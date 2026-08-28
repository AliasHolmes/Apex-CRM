import { Type, openAIStructured } from '../services/llm.js';
import { extractLinkedInUsername } from '../services/linkedinEvidence.js';
import { getIntentCacheEntry, upsertIntentCacheEntry } from '../db.js';
import { runProviderQueue, type ProviderQueueTask } from './providerQueue.js';
import { applyPostIntentDelta, rankLeadForFinalSelection } from './scoring.js';
import type { ProspectContract } from './prospectContract.js';
import type { BrightDataSearchResult, BrightDataSearchOptions } from '../services/brightdata.js';

export type PostIntentCategory =
  | 'hiring'
  | 'evaluating_tools'
  | 'pain_signal'
  | 'growth_signal'
  | 'general'
  | 'none';

export type PostIntentQuality = 'strong' | 'moderate' | 'weak' | 'none';

export type PostIntentEvidence = {
  queriedAt: string;
  postSnippets: string[];
  intentKeywords: string[];
  intentCategory: PostIntentCategory;
  confidenceScore: number;
  quality: PostIntentQuality;
  llmReason: string;
  sourceUrl?: string;
};

export type LinkedInPostIntentStats = {
  attempted: number;
  cacheHits: number;
  noResults: number;
  llmSkipped: number;
  succeeded: number;
  failed: number;
};

export type LinkedInPostIntentOptions = {
  qualifiedLeads: Map<string, any>;
  contract: ProspectContract;
  brightDataSearch: (query: string, options?: BrightDataSearchOptions) => Promise<BrightDataSearchResult[]>;
  tavilySearchFallback?: (query: string, options?: any) => Promise<any>;
  targetLimit?: number;
  maxLeads?: number;
  concurrency?: number;
  ttlDays?: number;
  sessionAbortSignal?: AbortSignal;
  logEvent: (msg: string) => void;
  recordTrace: (event: any) => void;
};

export const postIntentSchema = {
  type: Type.OBJECT,
  properties: {
    intentCategory: {
      type: Type.STRING,
      enum: ['hiring', 'evaluating_tools', 'pain_signal', 'growth_signal', 'general', 'none']
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: 'Confidence score from 0.0 to 1.0 indicating buying, tooling, or hiring intent'
    },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Specific keywords matched in post text (e.g. n8n, zapier, hiring, scale, automate)'
    },
    reason: {
      type: Type.STRING,
      description: 'One sentence explanation of the detected intent signal or why none was found'
    }
  },
  required: ['intentCategory', 'confidenceScore', 'keywords', 'reason']
};

export const POST_INTENT_SYSTEM_PROMPT = `You are a specialized B2B sales intelligence analyst.
Your task is to analyze Google SERP snippets from a prospect's recent LinkedIn posts and classify any buying, tooling, pain, or hiring intent signals.

Categorize into one of:
- "hiring": Actively hiring or looking for contractors/specialists/engineers.
- "evaluating_tools": Mentioning exploring, comparing, testing, or adopting specific tools/platforms (e.g., n8n, Zapier, Make, AI workflows).
- "pain_signal": Describing operational bottlenecks, manual workload, scaling challenges, or system breakages.
- "growth_signal": Company expansion, funding, new product launches, scaling teams.
- "general": Generic thought leadership, life updates, or industry commentary without explicit buying/hiring intent.
- "none": No meaningful signal or unrelated person.

Respond strictly in JSON matching the provided schema. Keep reason concise (1 sentence).`;

export function buildLinkedInPostSearchQuery(lead: Record<string, any>): string {
  const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || lead.profile?.contactDetails?.linkedinUrl;
  const handle = extractLinkedInUsername(url);
  if (handle) {
    return `site:linkedin.com ("${handle}" OR "in/${handle}") (posts OR "recent-activity" OR hiring OR looking OR scaling)`;
  }
  const name = String(lead.fullName || lead.profile?.fullName || '').trim();
  const company = String(lead.currentCompany || lead.company || lead.profile?.currentCompany || '').trim();
  if (name && company) {
    return `"${name}" "${company}" site:linkedin.com (posts OR "recent-activity" OR hiring OR looking OR scaling)`;
  }
  if (name) {
    return `"${name}" site:linkedin.com (posts OR "recent-activity" OR hiring OR looking OR scaling)`;
  }
  return '';
}

export function extractPostSnippets(results: BrightDataSearchResult[]): { snippets: string[]; postContext: string; firstUrl?: string } {
  const postResults = (results || []).filter(item => {
    const u = (item.url || '').toLowerCase();
    return u.includes('linkedin.com/posts') || u.includes('linkedin.com/feed/update') || u.includes('linkedin.com/activity') || u.includes('linkedin.com/pulse');
  });

  const targetResults = postResults.length > 0 ? postResults : (results || []).slice(0, 3);
  const snippets: string[] = [];
  const contextParts: string[] = [];

  for (const item of targetResults.slice(0, 5)) {
    const title = (item.title || '').replace(/\s*[-|]\s*linkedin.*$/i, '').trim();
    const content = (item.content || '').trim();
    if (content || title) {
      const line = [title, content].filter(Boolean).join(' - ');
      snippets.push(line);
      contextParts.push(`[Post snippet]: ${line}`);
    }
  }

  const postContext = contextParts.join('\n').slice(0, 1000);
  const firstUrl = targetResults[0]?.url;
  return { snippets, postContext, firstUrl };
}

export function computePostIntentQuality(
  category: PostIntentCategory,
  confidence: number
): PostIntentQuality {
  const c = Math.max(0, Math.min(1, Number(confidence) || 0));
  if ((category === 'hiring' || category === 'evaluating_tools') && c >= 0.5) {
    return 'strong';
  }
  if ((category === 'pain_signal' || category === 'growth_signal') && c >= 0.4) {
    return 'moderate';
  }
  if ((category === 'hiring' || category === 'evaluating_tools') && c >= 0.25) {
    return 'moderate';
  }
  if (category === 'general' && c >= 0.4) {
    return 'weak';
  }
  if (c >= 0.3 && category !== 'none') {
    return 'weak';
  }
  return 'none';
}

export async function classifyLinkedInPostIntent(
  postContext: string,
  brief: string,
  lead: Record<string, any>
): Promise<{ intentCategory: PostIntentCategory; confidenceScore: number; keywords: string[]; reason: string; quality: PostIntentQuality }> {
  if (!postContext || postContext.length < 50) {
    return {
      intentCategory: 'none',
      confidenceScore: 0,
      keywords: [],
      reason: 'Insufficient public LinkedIn post snippets to extract intent.',
      quality: 'none'
    };
  }

  const name = lead.fullName || lead.profile?.fullName || 'Prospect';
  const title = lead.currentTitle || lead.profile?.currentTitle || '';
  const company = lead.currentCompany || lead.company || lead.profile?.currentCompany || '';

  const userPrompt = `Prospect: ${name} (${title} at ${company})
Our Offer/Context: ${brief || 'B2B automation, operations, and software systems'}

Recent Google-Indexed LinkedIn Post Snippets:
${postContext}

Analyze the snippets and classify the prospect's intent:`;

  try {
    const result = await openAIStructured<{
      intentCategory?: string;
      confidenceScore?: number;
      keywords?: string[];
      reason?: string;
    }>(userPrompt, postIntentSchema, POST_INTENT_SYSTEM_PROMPT, {
      maxTokens: 600,
      temperature: 0
    });

    const validCategories: PostIntentCategory[] = ['hiring', 'evaluating_tools', 'pain_signal', 'growth_signal', 'general', 'none'];
    const rawCat = String(result.intentCategory || 'none').toLowerCase() as PostIntentCategory;
    const category = validCategories.includes(rawCat) ? rawCat : 'none';
    const confidence = Math.min(1, Math.max(0, Number(result.confidenceScore) || 0));
    const keywords = Array.isArray(result.keywords) ? result.keywords.map(k => String(k).trim()).filter(Boolean) : [];
    const reason = String(result.reason || 'Analyzed recent post activity.').trim();
    const quality = computePostIntentQuality(category, confidence);

    return {
      intentCategory: category,
      confidenceScore: confidence,
      keywords,
      reason,
      quality
    };
  } catch (err: any) {
    return {
      intentCategory: 'none',
      confidenceScore: 0,
      keywords: [],
      reason: `Classification error: ${err.message || 'LLM error'}`,
      quality: 'none'
    };
  }
}

export async function runLinkedInPostIntentEnrichment(
  options: LinkedInPostIntentOptions
): Promise<LinkedInPostIntentStats> {
  const {
    qualifiedLeads,
    contract,
    brightDataSearch,
    tavilySearchFallback,
    targetLimit,
    maxLeads = 20,
    concurrency = 2,
    ttlDays = 7,
    sessionAbortSignal,
    logEvent,
    recordTrace
  } = options;

  const stats: LinkedInPostIntentStats = {
    attempted: 0,
    cacheHits: 0,
    noResults: 0,
    llmSkipped: 0,
    succeeded: 0,
    failed: 0
  };

  if (!qualifiedLeads || qualifiedLeads.size === 0 || maxLeads <= 0) {
    return stats;
  }

  const INTENT_FINGERPRINT = 'linkedin_post_v1';

  // Pre-warm postIntentEvidence from cache before sorting.
  // rankLeadForFinalSelection calls postIntentScore(lead), which reads lead.postIntentEvidence.
  // Without this step, postIntentEvidence is undefined for every lead and the sort is blind
  // to Phase 5 signal entirely -- defeating the purpose of the cutline sort.
  // Cache reads are synchronous SQLite; no SERP calls are made here.
  const allLeads = Array.from(qualifiedLeads.values());
  for (const lead of allLeads) {
    if (lead.postIntentEvidence) continue; // already attached (e.g. from an earlier pass)
    const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || lead.profile?.contactDetails?.linkedinUrl || '';
    const handle = extractLinkedInUsername(url) || (lead.fullName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!handle) continue;
    const cached = getIntentCacheEntry(`linkedin:post:${handle}`, INTENT_FINGERPRINT);
    if (cached) {
      try {
        lead.postIntentEvidence = JSON.parse(cached.evidenceBlock) as PostIntentEvidence;
      } catch {
        // malformed cache entry -- leave postIntentEvidence undefined, sorts to neutral 5
      }
    }
  }

  // --- Cutline & Bubble Selection Logic ---
  // Max possible rank swing = (Max Phase 5 Score - Baseline) * Weight = (8.9 - 5.0) * 0.10 = 0.39
  const MAX_INTENT_SWING = 0.39;

  const sortedLeads = [...allLeads].sort((a, b) => rankLeadForFinalSelection(b) - rankLeadForFinalSelection(a));
  let leadsToProcess: any[] = [];

  if (typeof targetLimit === 'number' && targetLimit > 0 && targetLimit < sortedLeads.length) {
    const cutlineIndex = targetLimit - 1;
    const cutlineScore = rankLeadForFinalSelection(sortedLeads[cutlineIndex]);

    // 1. Identify "Bubble" candidates whose rank could realistically flip across the cutline
    const bubbleLeads = sortedLeads.filter(lead => {
      const score = rankLeadForFinalSelection(lead);
      return score >= (cutlineScore - MAX_INTENT_SWING) &&
             score <= (cutlineScore + MAX_INTENT_SWING);
    });

    // 2. Fill remaining budget with top-down winners (for verification and annotation)
    const bubbleSet = new Set(bubbleLeads);
    const remainingBudget = Math.max(0, maxLeads - bubbleLeads.length);
    const topDownLeads = sortedLeads
      .filter(l => !bubbleSet.has(l))
      .slice(0, remainingBudget);

    // 3. Process Bubble candidates first (selection impact), then Top-Down (annotation)
    leadsToProcess = [...bubbleLeads, ...topDownLeads].slice(0, maxLeads);
    logEvent(`Phase 5: evaluating LinkedIn post intent for ${leadsToProcess.length} prospects (bubble=${bubbleLeads.length}, topDown=${topDownLeads.length}, cutlineScore=${cutlineScore.toFixed(2)}, total=${allLeads.length}).`);
  } else {
    leadsToProcess = sortedLeads.slice(0, maxLeads);
    logEvent(`Phase 5: evaluating LinkedIn post intent for ${leadsToProcess.length} prospects (sorted by rank from ${allLeads.length} candidates).`);
  }

  const tasks: ProviderQueueTask<void>[] = leadsToProcess.map((lead, index) => {
    const name = lead.fullName || lead.profile?.fullName || `Lead-${index}`;
    const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || lead.profile?.contactDetails?.linkedinUrl || '';
    const handle = extractLinkedInUsername(url) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cacheKey = `linkedin:post:${handle}`;

    return {
      id: `post_intent:${handle}`,
      priority: leadsToProcess.length - index,
      run: async (signal) => {
        if (signal?.aborted || sessionAbortSignal?.aborted) return;
        stats.attempted++;

        // 1. Check cache first
        const cached = getIntentCacheEntry(cacheKey, INTENT_FINGERPRINT);
        if (cached) {
          stats.cacheHits++;
          try {
            const evidence: PostIntentEvidence = JSON.parse(cached.evidenceBlock);
            lead.postIntentEvidence = evidence;
            lead.intentEnrichmentState = (evidence && evidence.quality !== 'none') ? 'enriched_signal' : 'enriched_none';
            const newScore = applyPostIntentDelta(lead);
            lead.finalSelectionScore = newScore;
            if (lead.qualification) lead.qualification.finalScore = newScore;
            if (evidence.quality === 'strong' || evidence.quality === 'moderate') {
              if (!Array.isArray(lead.tags)) lead.tags = [];
              const postTag = `LinkedIn Post: ${evidence.intentCategory.replace('_', ' ')}`;
              if (!lead.tags.includes(postTag)) lead.tags.push(postTag);
            }
            stats.succeeded++;
            logEvent(`[Phase 5 Cache Hit] ${name} (${handle}): ${evidence.intentCategory} (quality=${evidence.quality}, score=${newScore.toFixed(2)})`);
            return;
          } catch {
            // cache parse failure, proceed to live search
          }
        }

        // 2. Perform live SERP search for LinkedIn posts
        const query = buildLinkedInPostSearchQuery(lead);
        if (!query) {
          stats.noResults++;
          lead.intentEnrichmentState = 'enriched_none';
          return;
        }

        try {
          let results = await brightDataSearch(query, {
            onBingFallback: ({ resultsCount }: { resultsCount: number }) => {
              logEvent(`[Phase 5] Google SERP challenged for ${name}; Bing fallback rescued ${resultsCount} post result(s).`);
            }
          }).catch(() => {
            // The Bright Data service already retried internally; this is the
            // final failure. Log compactly and let the Tavily fallback run.
            logEvent(`[Phase 5] Bright Data post search unavailable for ${name}; continuing with fallback results.`);
            return [] as BrightDataSearchResult[];
          });
          let activeProvider: 'brightdata' | 'tavily' = 'brightdata';

          if ((!results || results.length === 0) && tavilySearchFallback) {
            try {
              const companyName = String(
                lead.currentCompany ||
                  lead.company ||
                  lead.profile?.currentCompany ||
                  "",
              ).trim();
              const tavilyQuery = handle
                ? `${handle} linkedin posts`
                : name && companyName
                  ? `${name} ${companyName} linkedin posts`
                  : `${name} linkedin posts`;
              const tavilyRes = await tavilySearchFallback(tavilyQuery, {
                searchDepth: "basic",
                maxResults: 5,
                includeDomains: ["linkedin.com"],
              });
              const items = Array.isArray(tavilyRes)
                ? tavilyRes
                : tavilyRes?.items || tavilyRes?.results || [];
              if (items.length > 0) {
                activeProvider = "tavily";
                results = items
                  .map((item: any) => ({
                    title: String(item.title || ""),
                    url: String(item.url || item.link || ""),
                    content: String(
                      item.content ||
                        item.raw_content ||
                        item.snippet ||
                        "",
                    ),
                    sourceProvider: "tavily" as any,
                  }))
                  .filter((item: any) => item.url && item.title);
              }
            } catch {
              // tavily fallback failed, proceed with empty results
            }
          }

          const { snippets, postContext, firstUrl } = extractPostSnippets(results);

          if (!snippets.length || postContext.length < 50) {
            stats.llmSkipped++;
            const emptyEvidence: PostIntentEvidence = {
              queriedAt: new Date().toISOString(),
              postSnippets: snippets,
              intentKeywords: [],
              intentCategory: 'none',
              confidenceScore: 0,
              quality: 'none',
              llmReason: snippets.length > 0
                ? 'Profile preview indexed without detailed post activity.'
                : 'No recent Google-indexed LinkedIn posts found for this prospect.',
              sourceUrl: firstUrl
            };
            lead.postIntentEvidence = emptyEvidence;
            lead.intentEnrichmentState = 'enriched_none';
            upsertIntentCacheEntry({
              normalizedUrl: cacheKey,
              companyName: lead.currentCompany || lead.company || name,
              personName: name,
              linkedinUsername: handle,
              evidenceBlock: JSON.stringify(emptyEvidence),
              scrapeQuality: 'weak',
              sourceProvider: activeProvider,
              intentFingerprint: INTENT_FINGERPRINT
            }, ttlDays);
            return;
          }

          // 3. Classify intent with LLM
          const classification = await classifyLinkedInPostIntent(postContext, contract.brief, lead);
          const postEvidence: PostIntentEvidence = {
            queriedAt: new Date().toISOString(),
            postSnippets: snippets,
            intentKeywords: classification.keywords,
            intentCategory: classification.intentCategory,
            confidenceScore: classification.confidenceScore,
            quality: classification.quality,
            llmReason: classification.reason,
            sourceUrl: firstUrl
          };

          lead.postIntentEvidence = postEvidence;
          lead.intentEnrichmentState = (postEvidence.quality !== 'none') ? 'enriched_signal' : 'enriched_none';
          const newScore = applyPostIntentDelta(lead);
          lead.finalSelectionScore = newScore;
          if (lead.qualification) lead.qualification.finalScore = newScore;

          if (postEvidence.quality === 'strong' || postEvidence.quality === 'moderate') {
            if (!Array.isArray(lead.tags)) lead.tags = [];
            const postTag = `LinkedIn Post: ${postEvidence.intentCategory.replace('_', ' ')}`;
            if (!lead.tags.includes(postTag)) lead.tags.push(postTag);
          }

          upsertIntentCacheEntry({
            normalizedUrl: cacheKey,
            companyName: lead.currentCompany || lead.company || name,
            personName: name,
            linkedinUsername: handle,
            evidenceBlock: JSON.stringify(postEvidence),
            scrapeQuality: postEvidence.quality === 'strong' ? 'good' : postEvidence.quality === 'moderate' ? 'partial' : 'weak',
            sourceProvider: activeProvider,
            intentFingerprint: INTENT_FINGERPRINT
          }, ttlDays);

          stats.succeeded++;
          logEvent(`[Phase 5 Enriched] ${name}: category=${postEvidence.intentCategory}, quality=${postEvidence.quality}, confidence=${postEvidence.confidenceScore.toFixed(2)} -> updated score=${newScore.toFixed(2)}`);
        } catch (err: any) {
          stats.failed++;
          if (!lead.intentEnrichmentState) {
            lead.intentEnrichmentState = 'enriched_none';
          }
          logEvent(`[Phase 5 WARN] LinkedIn post intent check failed for ${name}: ${err.message || String(err)}`);
        }
      }
    };
  });

  await runProviderQueue(tasks, {
    concurrency,
    signal: sessionAbortSignal
  });

  recordTrace({
    phase: 'candidate_processing',
    operation: 'linkedin_post_intent_enrichment',
    status: 'success',
    provider: 'brightdata',
    counts: { ...stats }
  });

  return stats;
}

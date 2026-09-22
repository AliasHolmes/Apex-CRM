import {
  Type,
  openAIStructured,
  DEFAULT_PRIMARY_MODEL,
  type LLMProviderAttempt,
  type LLMUsage,
} from '../services/llm.js';
import { extractLinkedInUsername } from '../services/linkedinEvidence.js';
import { getIntentCacheEntry, getIntentCacheEntriesBatch, upsertIntentCacheEntry } from '../db.js';
import { runProviderQueue, type ProviderQueueTask } from './providerQueue.js';
import { applyPostIntentDelta } from './scoring.js';
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

export const postIntentBatchSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidateId: {
            type: Type.STRING,
            description: "The unique identifier of the candidate being classified",
          },
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
        required: ['candidateId', 'intentCategory', 'confidenceScore', 'keywords', 'reason']
      }
    }
  },
  required: ['results']
};

export const POST_INTENT_BATCH_SYSTEM_PROMPT = `You are a specialized B2B sales intelligence analyst.
Your task is to analyze Google SERP snippets from multiple prospects' recent LinkedIn posts and classify any buying, tooling, pain, or hiring intent signals for EACH candidate individually.

For each candidate, categorize into one of:
- "hiring": Actively hiring or looking for contractors/specialists/engineers.
- "evaluating_tools": Mentioning exploring, comparing, testing, or adopting specific tools/platforms (e.g., n8n, Zapier, Make, AI workflows).
- "pain_signal": Describing operational bottlenecks, manual workload, scaling challenges, or system breakages.
- "growth_signal": Company expansion, funding, new product launches, scaling teams.
- "general": Generic thought leadership, life updates, or industry commentary without explicit buying/hiring intent.
- "none": No meaningful signal or unrelated person.

Respond strictly in JSON matching the provided schema with an entry in results for every candidate. Keep reasons concise (1 sentence).`;

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
  lead: Record<string, any>,
  logEvent?: (msg: string) => void,
  recordTrace?: (event: any) => void,
): Promise<{ intentCategory: PostIntentCategory; confidenceScore: number; keywords: string[]; reason: string; quality: PostIntentQuality }> {
  if (!postContext || postContext.trim().length < 50) {
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

  const startedAt = Date.now();
  const attempts: LLMProviderAttempt[] = [];
  let usage: LLMUsage | undefined;
  try {
    const result = await openAIStructured<{
      intentCategory?: string;
      confidenceScore?: number;
      keywords?: string[];
      reason?: string;
    }>(userPrompt, postIntentSchema, POST_INTENT_SYSTEM_PROMPT, {
      maxTokens: 600,
      temperature: 0,
      onProviderAttempt: (attempt) => attempts.push(attempt),
      onUsage: (u) => {
        usage = u;
      },
    });

    const validCategories: PostIntentCategory[] = ['hiring', 'evaluating_tools', 'pain_signal', 'growth_signal', 'general', 'none'];
    const rawCat = String(result.intentCategory || 'none').toLowerCase() as PostIntentCategory;
    const category = validCategories.includes(rawCat) ? rawCat : 'none';
    const confidence = Math.min(1, Math.max(0, Number(result.confidenceScore) || 0));
    const keywords = Array.isArray(result.keywords) ? result.keywords.map(k => String(k).trim()).filter(Boolean) : [];
    const reason = String(result.reason || 'Analyzed recent post activity.').trim();
    const quality = computePostIntentQuality(category, confidence);

    const successfulAttempt = attempts.find((a) => a.status === "success");
    const resolvedModel =
      usage?.model ||
      successfulAttempt?.actualModel ||
      successfulAttempt?.model ||
      process.env.OPENAI_MODEL ||
      DEFAULT_PRIMARY_MODEL;
    const latency = Date.now() - startedAt;
    const tokens = usage?.totalTokens;
    logEvent?.(
      `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [LinkedIn Post Intent: ${name} -> ${category} (${quality})]`,
    );

    recordTrace?.({
      phase: "select",
      operation: "post_intent_classify",
      provider: "llm",
      query: `post_intent:${name}`,
      status: "success",
      latencyMs: latency,
      model: resolvedModel,
      llm: {
        route: successfulAttempt?.provider || "llm",
        model: resolvedModel,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    });

    return {
      intentCategory: category,
      confidenceScore: confidence,
      keywords,
      reason,
      quality
    };
  } catch (err: any) {
    logEvent?.(
      `[LLM ERROR] LinkedIn Post Intent classification failed for ${name} (${Date.now() - startedAt}ms): ${err.message || String(err)}`,
    );
    recordTrace?.({
      phase: "select",
      operation: "post_intent_classify",
      provider: "llm",
      query: `post_intent:${name}`,
      status: "error",
      latencyMs: Date.now() - startedAt,
      error: { message: err.message || String(err) },
    });
    return {
      intentCategory: 'none',
      confidenceScore: 0,
      keywords: [],
      reason: `Classification error: ${err.message || 'LLM error'}`,
      quality: 'none'
    };
  }
}

export async function classifyLinkedInPostIntentBatch(
  candidates: Array<{ candidateId: string; postContext: string; lead: Record<string, any> }>,
  brief: string,
  logEvent?: (msg: string) => void,
  recordTrace?: (event: any) => void,
): Promise<Map<string, { intentCategory: PostIntentCategory; confidenceScore: number; keywords: string[]; reason: string; quality: PostIntentQuality }>> {
  const resultMap = new Map<string, { intentCategory: PostIntentCategory; confidenceScore: number; keywords: string[]; reason: string; quality: PostIntentQuality }>();
  if (!candidates.length) return resultMap;

  if (candidates.length === 1) {
    const single = candidates[0];
    const res = await classifyLinkedInPostIntent(single.postContext, brief, single.lead, logEvent, recordTrace);
    resultMap.set(single.candidateId, res);
    return resultMap;
  }

  const promptSections = candidates.map((c, i) => {
    const name = c.lead.fullName || c.lead.profile?.fullName || `Candidate-${i + 1}`;
    const title = c.lead.currentTitle || c.lead.profile?.currentTitle || '';
    const company = c.lead.currentCompany || c.lead.company || c.lead.profile?.currentCompany || '';
    return `### Candidate ID: "${c.candidateId}"
Name: ${name} (${title} at ${company})
Recent Post Snippets:
${c.postContext}`;
  }).join('\n\n');

  const userPrompt = `Our Offer/Context: ${brief || 'B2B automation, operations, and software systems'}

Analyze the following candidates and return an intent classification for each one:

${promptSections}`;

  const startedAt = Date.now();
  const attempts: LLMProviderAttempt[] = [];
  let usage: LLMUsage | undefined;
  try {
    const response = await openAIStructured<{
      results?: Array<{
        candidateId?: string;
        intentCategory?: string;
        confidenceScore?: number;
        keywords?: string[];
        reason?: string;
      }>;
    }>(userPrompt, postIntentBatchSchema, POST_INTENT_BATCH_SYSTEM_PROMPT, {
      maxTokens: Math.min(2500, Math.max(800, candidates.length * 350)),
      temperature: 0,
      onProviderAttempt: (attempt) => attempts.push(attempt),
      onUsage: (u) => {
        usage = u;
      },
    });

    const validCategories: PostIntentCategory[] = ['hiring', 'evaluating_tools', 'pain_signal', 'growth_signal', 'general', 'none'];
    const returnedResults = response.results || [];
    for (const r of returnedResults) {
      if (!r.candidateId) continue;
      const rawCat = String(r.intentCategory || 'none').toLowerCase() as PostIntentCategory;
      const category = validCategories.includes(rawCat) ? rawCat : 'none';
      const confidence = Math.min(1, Math.max(0, Number(r.confidenceScore) || 0));
      const keywords = Array.isArray(r.keywords) ? r.keywords.map(k => String(k).trim()).filter(Boolean) : [];
      const reason = String(r.reason || 'Analyzed recent post activity.').trim();
      const quality = computePostIntentQuality(category, confidence);
      resultMap.set(r.candidateId, {
        intentCategory: category,
        confidenceScore: confidence,
        keywords,
        reason,
        quality,
      });
    }

    for (const c of candidates) {
      if (!resultMap.has(c.candidateId)) {
        const fallbackRes = await classifyLinkedInPostIntent(c.postContext, brief, c.lead, logEvent, recordTrace);
        resultMap.set(c.candidateId, fallbackRes);
      }
    }

    const successfulAttempt = attempts.find((a) => a.status === "success");
    const resolvedModel =
      usage?.model ||
      successfulAttempt?.actualModel ||
      successfulAttempt?.model ||
      process.env.OPENAI_MODEL ||
      DEFAULT_PRIMARY_MODEL;
    const latency = Date.now() - startedAt;
    const tokens = usage?.totalTokens;
    logEvent?.(
      `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [LinkedIn Post Intent Batch: ${candidates.length} candidates]`,
    );

    recordTrace?.({
      phase: "select",
      operation: "post_intent_classify_batch",
      provider: "llm",
      query: `post_intent_batch:${candidates.length}`,
      status: "success",
      latencyMs: latency,
      model: resolvedModel,
      llm: {
        route: successfulAttempt?.provider || "llm",
        model: resolvedModel,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    });

    return resultMap;
  } catch (err: any) {
    logEvent?.(
      `[LLM WARN] LinkedIn Post Intent batch classification failed (${Date.now() - startedAt}ms), falling back to individual calls: ${err.message || String(err)}`,
    );
    for (const c of candidates) {
      const single = await classifyLinkedInPostIntent(c.postContext, brief, c.lead, logEvent, recordTrace);
      resultMap.set(c.candidateId, single);
    }
    return resultMap;
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
    // G12 annotate-only: targetLimit no longer drives a cutline; kept in the
    // options type for caller compatibility.
    targetLimit: _targetLimit,
    maxLeads = 10,
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

  // Pre-warm postIntentEvidence from cache before annotating.
  // postIntentScore(lead) reads lead.postIntentEvidence; without this step it
  // is undefined for every lead and annotation deltas start from a blind baseline.
  // Cache reads are synchronous SQLite; no SERP calls are made here.
  const allLeads = Array.from(qualifiedLeads.values());
  const lookups: Array<{ lead: any; cacheKey: string }> = [];
  for (const lead of allLeads) {
    if (lead.postIntentEvidence) continue; // already attached (e.g. from an earlier pass)
    const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || lead.profile?.contactDetails?.linkedinUrl || '';
    const handle = extractLinkedInUsername(url) || (lead.fullName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!handle) continue;
    const cacheKey = `linkedin:post:${handle}`;
    lookups.push({ lead, cacheKey });
  }

  if (lookups.length > 0) {
    const cachedBatch = getIntentCacheEntriesBatch(
      lookups.map(l => ({ normalizedUrl: l.cacheKey, intentFingerprint: INTENT_FINGERPRINT }))
    );
    for (const { lead, cacheKey } of lookups) {
      const cached = cachedBatch.get(`${cacheKey.trim().toLowerCase()}::${INTENT_FINGERPRINT}`);
      if (cached) {
        try {
          lead.postIntentEvidence = JSON.parse(cached.evidenceBlock) as PostIntentEvidence;
        } catch {
          // malformed cache entry -- leave postIntentEvidence undefined, sorts to neutral 5
        }
      }
    }
  }

  // G12 (annotate-only): post-selection intent annotates finalists with
  // scores/badges but never reorders or re-cuts who is returned. The former
  // bubble/cutline machinery implied a second selection cutline that did not
  // exist -- intent enriches, selection already happened.
  const leadsToProcess: any[] = allLeads.slice(0, Math.max(0, maxLeads));
  logEvent(`Phase 5: annotating LinkedIn post intent for ${leadsToProcess.length} finalist(s) (from ${allLeads.length} candidates; annotate-only, no reorder).`);

  interface CandidateNeedingLlm {
    lead: any;
    name: string;
    handle: string;
    cacheKey: string;
    activeProvider: 'brightdata' | 'tavily';
    postContext: string;
    snippets: string[];
    firstUrl?: string;
  }
  const pendingLlm: CandidateNeedingLlm[] = [];

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

          // Stage for batched LLM classification
          pendingLlm.push({
            lead,
            name,
            handle,
            cacheKey,
            activeProvider,
            postContext,
            snippets,
            firstUrl
          });
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

  if (sessionAbortSignal?.aborted) {
    return stats;
  }

  // Phase B: Batched LLM classification (chunks of up to 5)
  const BATCH_SIZE = 5;
  for (let i = 0; i < pendingLlm.length; i += BATCH_SIZE) {
    if (sessionAbortSignal?.aborted) break;
    const batch = pendingLlm.slice(i, i + BATCH_SIZE);
    const candidateInputs = batch.map((item, idx) => ({
      candidateId: String(item.lead.id || `${item.handle}-${i + idx}`),
      postContext: item.postContext,
      lead: item.lead,
    }));

    try {
      const classifications = await classifyLinkedInPostIntentBatch(
        candidateInputs,
        contract.brief,
        logEvent,
        recordTrace
      );

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const cid = candidateInputs[j].candidateId;
        const classification = classifications.get(cid) || {
          intentCategory: 'none' as PostIntentCategory,
          confidenceScore: 0,
          keywords: [] as string[],
          reason: 'No classification returned from batch.',
          quality: 'none' as PostIntentQuality,
        };

        const postEvidence: PostIntentEvidence = {
          queriedAt: new Date().toISOString(),
          postSnippets: item.snippets,
          intentKeywords: classification.keywords,
          intentCategory: classification.intentCategory,
          confidenceScore: classification.confidenceScore,
          quality: classification.quality,
          llmReason: classification.reason,
          sourceUrl: item.firstUrl
        };

        item.lead.postIntentEvidence = postEvidence;
        item.lead.intentEnrichmentState = (postEvidence.quality !== 'none') ? 'enriched_signal' : 'enriched_none';
        const newScore = applyPostIntentDelta(item.lead);
        item.lead.finalSelectionScore = newScore;
        if (item.lead.qualification) item.lead.qualification.finalScore = newScore;

        if (postEvidence.quality === 'strong' || postEvidence.quality === 'moderate') {
          if (!Array.isArray(item.lead.tags)) item.lead.tags = [];
          const postTag = `LinkedIn Post: ${postEvidence.intentCategory.replace('_', ' ')}`;
          if (!item.lead.tags.includes(postTag)) item.lead.tags.push(postTag);
        }

        upsertIntentCacheEntry({
          normalizedUrl: item.cacheKey,
          companyName: item.lead.currentCompany || item.lead.company || item.name,
          personName: item.name,
          linkedinUsername: item.handle,
          evidenceBlock: JSON.stringify(postEvidence),
          scrapeQuality: postEvidence.quality === 'strong' ? 'good' : postEvidence.quality === 'moderate' ? 'partial' : 'weak',
          sourceProvider: item.activeProvider,
          intentFingerprint: INTENT_FINGERPRINT
        }, ttlDays);

        stats.succeeded++;
        logEvent(`[Phase 5 Enriched] ${item.name}: category=${postEvidence.intentCategory}, quality=${postEvidence.quality}, confidence=${postEvidence.confidenceScore.toFixed(2)} -> updated score=${newScore.toFixed(2)}`);
      }
    } catch (err: any) {
      logEvent(`[Phase 5 WARN] LinkedIn post intent batch failed: ${err.message || String(err)}`);
      for (const item of batch) {
        stats.failed++;
        if (!item.lead.intentEnrichmentState) {
          item.lead.intentEnrichmentState = 'enriched_none';
        }
      }
    }
  }

  recordTrace({
    phase: 'candidate_processing',
    operation: 'linkedin_post_intent_enrichment',
    status: 'success',
    provider: 'brightdata',
    counts: { ...stats }
  });

  return stats;
}

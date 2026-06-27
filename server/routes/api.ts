import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';

import { readStoredLeads, hasLeadStoreBeenInitialized, replaceStoredLeads, normalizeIncomingLeads, getLeadsDb, insertSearchLog, pruneExpiredEnrichmentCache, getEnrichmentCacheEntry, upsertEnrichmentCacheEntry } from '../db.js';
import { loadAuth, saveAuth } from '../auth.js';
import { hasOpenAIKey, tavilySearch, openAIStructured, singleProfileSchema, APEX_SYSTEM_PROMPT, leadsArraySchema, searchQueriesSchema, openAIText, STRATEGIST_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, bulkLeadsArraySchema } from '../services/llm.js';
import { getBrightDataStatus, isBrightDataConfigured, scrapeAsMarkdown } from '../services/brightdata.js';
import { buildTavilyEvidence, extractLinkedInUsername, normalizeLinkedInUrl, parseLinkedInEvidence } from '../services/linkedinEvidence.js';
import { computeScoreBreakdown, type EvidenceQuality, type LeadSourceProvider } from '../leadSearch/scoring.js';
import { createLeadEvidence, inferTavilyEvidenceQuality } from '../leadSearch/evidence.js';
import { buildFallbackQueryPlan, buildStrategistPrompt, normalizeQueryPlanItems, toLinkedInSearchQuery, type ProviderRunStats, type QueryRunStats, type SearchQueryPlanItem } from '../leadSearch/strategist.js';
import { incrementRejection, mapBrightDataRejection, type RejectionReason } from '../leadSearch/rejections.js';

const router = Router();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.APP_URL ? (process.env.APP_URL + '/api/auth/google/callback') : 'http://localhost:3000/api/auth/google/callback';
let codeVerifierCache = '';


router.get('/leads', (req, res): any => {
  try {
    res.json({ leads: readStoredLeads(), initialized: hasLeadStoreBeenInitialized() });
  } catch (error: any) {
    console.error('Failed to read leads from SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to read leads' });
  }
});

router.put('/leads', (req, res): any => {
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads) {
      return res.status(400).json({ error: 'Expected a leads array.' });
    }

    replaceStoredLeads(leads);
    res.json({ success: true, count: leads.length });
  } catch (error: any) {
    console.error('Failed to persist leads to SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to persist leads' });
  }
});
// Active Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!process.env.OPENAI_API_KEY,
    hasTavilyKey: !!process.env.TAVILY_API_KEY,
    hasOAuth: !!loadAuth(),
    hasGoogleClient: !!CLIENT_ID,
    brightData: getBrightDataStatus(),
  });
});

router.get('/auth/google/url', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment.' });
  }
  codeVerifierCache = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifierCache).digest('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent'
  });
  res.json({ url });
});

router.get('/auth/google/callback', async (req, res): Promise<any> => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('No code');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifierCache
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).send('Failed to get token: ' + JSON.stringify(tokens));
    
    // Discover Code Assist Project
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens.access_token}`,
      'User-Agent': 'google-api-nodejs-client/9.15.1 (gzip)',
      'X-Goog-Api-Client': 'gl-node/24.0.0'
    };
    const md = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "OPENAI" };
    
    const loadRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST', headers, body: JSON.stringify({ metadata: md })
    });
    const loadData = await loadRes.json();
    let projectId = loadData.cloudaicompanionProject;
    let tierId = loadData.currentTier?.id;

    // Detect if standard-tier is allowed (Pro subscription)
    let targetTier = 'free-tier';
    const allowedTiers = loadData.allowedTiers || [];
    const hasStandardTier = allowedTiers.some((t: any) => t && t.id === 'standard-tier');
    if (hasStandardTier) {
      targetTier = 'standard-tier';
    }

    if (tierId !== targetTier) {
      const onboardRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:onboardUser', {
         method: 'POST',
         headers,
         body: JSON.stringify({
           tierId: targetTier,
           cloudaicompanionProject: projectId || undefined,
           metadata: md
         })
      });
      const onboardData = await onboardRes.json();
      projectId = onboardData.response?.cloudaicompanionProject || projectId;
    }

    saveAuth({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_ms: Date.now() + ((tokens.expires_in || 3599) * 1000),
      project_id: projectId || ''
    });

    res.send('<script>window.close();</script><p style="font-family:sans-serif;text-align:center;margin-top:20vh;color:#1a7f37;font-size:24px;">Successfully authenticated. You can close this window.</p>');
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// 1. Scrape Public URL / Name lookup via Search Grounding
router.post('/scrape-url', async (req, res): Promise<any> => {
  try {
    const { urlOrName } = req.body;
    if (!urlOrName) {
      return res.status(400).json({ error: 'urlOrName is required' });
    }

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable real scraping.' });
    }

    // Step 1: Tavily search for public LinkedIn-indexed evidence
    console.log(`[scrape-url] Searching Tavily for: ${urlOrName}`);
    
    const { text: rawText, sources } = await tavilySearch(`${urlOrName} LinkedIn`);

    if (!rawText || rawText.length < 50) {
      throw new Error('Could not find sufficient public information about this person.');
    }

    // Step 2: Structure the raw search result into CRM schema
    const structurePrompt = `You are a CRM data extraction engine. Convert the following raw professional profile research into a structured JSON object.

If a field is not found in the research, use an empty string - do NOT invent data.
For the fitScore, intentScore, and timingScore: score 1-10 based on how much signal exists.

Raw research data:
${rawText}`;

    const profile = await openAIStructured<any>(structurePrompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

    if (!profile || !profile.fullName) {
      throw new Error('Could not extract a valid profile from the search results.');
    }

    res.json({
      profile,
      sourceLinks: sources.slice(0, 5),
      rawText,
      sandboxMode: false
    });
  } catch (error: any) {
    console.error('Error in /api/scrape-url:', error);
    res.status(500).json({ error: error.message || 'Failed to scrape this profile.' });
  }
});

// 2. Extractor: Parse copy-pasted raw text or HTML block
router.post('/scrape-pasted', async (req, res): Promise<any> => {
  try {
    const { pastedText } = req.body;
    if (!pastedText || pastedText.trim().length < 20) {
      return res.status(400).json({ error: 'Please paste a larger LinkedIn profile text block (minimum 20 characters).' });
    }

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable AI extraction.' });
    }

    // Single structured call - no grounding needed, text is already provided
    console.log('[scrape-pasted] Extracting profile from pasted text...');
    const prompt = `You are a CRM data extraction engine. The user has copy-pasted raw text from a LinkedIn profile or professional bio.

Extract every piece of professional information you can find and map it to the JSON schema.
Do NOT invent any data - only use what is present in the text below.
For email: if not explicitly stated, infer the most likely format based on name + company (label as INFERRED).
For fitScore / intentScore / timingScore: score 1-10 based on signals in the text.

Pasted text:
${pastedText}`;

    const profile = await openAIStructured<any>(prompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

    if (!profile || !profile.fullName) {
      throw new Error('Could not extract a valid profile. Make sure the pasted text includes at least a name and job title.');
    }

    res.json({ profile, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/scrape-pasted:', error);
    res.status(500).json({ error: error.message || 'Failed to extract pasted profile data.' });
  }
});

// -----------------------------------------------------------------------------
// Search Logging Utility
// -----------------------------------------------------------------------------


router.get('/search-logs', (req, res): any => {
  try {
    const db = getLeadsDb();
    const stmt = db.prepare('SELECT * FROM search_logs ORDER BY timestamp DESC');
    const rows = stmt.all() as any[];
    
    const logs = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      prompt: r.prompt,
      generatedQueries: JSON.parse(r.generated_queries || '[]'),
      status: r.status,
      errorMessage: r.error_message,
      rawResultsCount: r.raw_results_count,
      leadsFound: r.leads_found,
      detailedLogs: r.detailed_logs
    }));
    res.json(logs);
  } catch (error: any) {
    console.error('Failed to read search logs:', error);
    res.status(500).json({ error: 'Failed to retrieve search logs.' });
  }
});

// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
router.post('/find-leads', async (req, res): Promise<any> => {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const sessionLogs: string[] = [];
  const logEvent = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); sessionLogs.push(line); };
  logEvent(`--- NEW ADAPTIVE MINING SESSION: ${sessionId} ---`);

  let generatedQueries: string[] = [];
  let rawResultsCount = 0;
  let leadsFound = 0;
  const promptQuery = req.body.query || '';
  const startedAt = Date.now();
  insertSearchLog({
    id: sessionId,
    timestamp: new Date().toISOString(),
    prompt: promptQuery,
    generatedQueries: [],
    status: 'running',
    errorMessage: '',
    rawResultsCount: 0,
    leadsFound: 0,
    detailedLogs: sessionLogs.join('\n')
  });

  const brightDataStats: ProviderRunStats = {
    configured: isBrightDataConfigured(),
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cacheHits: 0,
    rejectionReasons: {}
  };

  const stats = {
    requested: Math.min(Math.max(Number(req.body.limit || 5), 1), 200),
    returned: 0,
    rawCandidates: 0,
    cacheHits: 0,
    cacheWrites: 0,
    enriched: 0,
    brightDataFailures: 0,
    rounds: 0,
    stopReason: 'not_started',
    rejectionReasons: {} as Record<string, number>,
    queryRuns: [] as QueryRunStats[],
    brightData: brightDataStats
  };

  type EvidenceMeta = {
    evidenceBlock: string;
    evidenceQuality: EvidenceQuality;
    sourceProvider: LeadSourceProvider;
    sourceUrl: string;
    sourceQuery: string;
    sourceRound: number;
    queryRun?: QueryRunStats;
  };

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const normalizeDedupeValue = (value?: string) => (value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .trim();

  const profileKeys = (profile: any) => {
    const keys = new Set<string>();
    const email = normalizeDedupeValue(profile?.contactDetails?.email);
    const linkedin = extractLinkedInUsername(profile?.contactDetails?.linkedinUrl);
    const name = normalizeDedupeValue(profile?.fullName);
    const company = normalizeDedupeValue(profile?.currentCompany);
    if (email) keys.add(`email:${email}`);
    if (linkedin) keys.add(`linkedin:${linkedin}`);
    if (name && company) keys.add(`name_company:${name}::${company}`);
    return keys;
  };

  const hasDuplicateKeys = (profile: any, existingKeys: Set<string>) => {
    for (const key of profileKeys(profile)) {
      if (existingKeys.has(key)) return true;
    }
    return false;
  };

  const addProfileKeys = (profile: any, existingKeys: Set<string>) => {
    profileKeys(profile).forEach(key => existingKeys.add(key));
  };

  const fallbackEvidenceForLead = (lead: any): EvidenceMeta => {
    const sourceUrl = lead.contactDetails?.linkedinUrl || '';
    const evidenceBlock = [
      sourceUrl ? `LINK: ${sourceUrl}` : '',
      lead.headline ? `HEADLINE: ${lead.headline}` : '',
      lead.summary ? `SUMMARY: ${lead.summary}` : '',
      Array.isArray(lead.evidenceReasons) ? lead.evidenceReasons.join('\n') : ''
    ].filter(Boolean).join('\n');
    return {
      evidenceBlock,
      evidenceQuality: 'weak',
      sourceProvider: lead.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily',
      sourceUrl,
      sourceQuery: promptQuery,
      sourceRound: stats.rounds || 1
    };
  };

  const effectiveScore = (lead: any) => {
    const score = Number(lead.scoreBreakdown?.finalScore || 0);
    if (score > 0) return score;
    const fit = Number(lead.fitScore || 0);
    const composite = Number(lead.compositeScore || 0);
    const predictive = Number(lead.predictiveScore || 0);
    if (fit > 0) return fit;
    if (composite > 10) return composite / 10;
    if (composite > 0) return composite;
    if (predictive > 10) return predictive / 10;
    return predictive;
  };

  const leadRejectionReason = (lead: any, minScore: number): RejectionReason | null => {
    const hasIdentity = Boolean((lead?.fullName || '').trim());
    if (!hasIdentity) return 'missing_identity';
    const hasRoleContext = Boolean((lead?.currentTitle || '').trim() || (lead?.currentCompany || '').trim() || (lead?.headline || '').trim());
    if (!hasRoleContext) return 'missing_role_context';
    if (effectiveScore(lead) < minScore) return 'score_below_minimum';
    return null;
  };

  const chunkEvidenceBlocks = (blocks: string[], maxLength = 3200) => {
    const chunks: string[] = [];
    let current = '';
    for (const block of blocks) {
      if (current.length + block.length > maxLength && current.length > 0) {
        chunks.push(current);
        current = block;
      } else {
        current += block;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  };

  try {
    const { query, excludeList = [] } = req.body;
    const targetLimit = stats.requested;
    const maxRounds = Math.min(Math.max(Number(process.env.LEAD_SEARCH_MAX_ROUNDS || 4), 1), 8);
    const minScore = Math.min(Math.max(Number(process.env.LEAD_SEARCH_MIN_SCORE || 6), 1), 10);
    const ttlDays = Math.min(Math.max(Number(process.env.BRIGHTDATA_CACHE_TTL_DAYS || 7), 1), 30);
    const enrichmentCap = Math.min(
      Math.max(Number(process.env.BRIGHTDATA_ENRICHMENT_CAP || 0) || Math.max(targetLimit * 3, 20), 1),
      500
    );
    const safetyTimeoutMs = Number(process.env.LEAD_SEARCH_TIMEOUT_MS || 0) || 0;

    if (!query) {
      throw new Error('Search criteria/query is required');
    }

    if (!hasOpenAIKey()) {
      throw new Error('OPENAI_API_KEY is not configured. Add it to your .env file to enable real lead discovery.');
    }

    const expiredRows = pruneExpiredEnrichmentCache();
    if (expiredRows > 0) logEvent(`Pruned ${expiredRows} expired enrichment cache rows.`);

    const existingKeys = new Set<string>();
    const excludedValues = new Set<string>();
    for (const lead of readStoredLeads() as any[]) {
      addProfileKeys(lead.profile || lead, existingKeys);
    }
    for (const exclusion of excludeList) {
      const normalized = normalizeDedupeValue(exclusion);
      if (!normalized) continue;
      excludedValues.add(normalized);
      existingKeys.add(`email:${normalized}`);
      if (normalized.includes('linkedin.com/in/')) existingKeys.add(`linkedin:${extractLinkedInUsername(normalized)}`);
      existingKeys.add(`name:${normalized}`);
    }

    const matchesExcludeList = (lead: any) => {
      if (excludedValues.size === 0) return false;
      const name = normalizeDedupeValue(lead?.fullName);
      const email = normalizeDedupeValue(lead?.contactDetails?.email);
      const linkedin = normalizeDedupeValue(lead?.contactDetails?.linkedinUrl);
      for (const exclusion of excludedValues) {
        if (email && email === exclusion) return true;
        if (linkedin && linkedin.includes(exclusion)) return true;
        if (name && name.includes(exclusion)) return true;
      }
      return false;
    };
    const acceptedLeads: any[] = [];
    const seenCandidateKeys = new Set<string>();
    const seenQueryTexts = new Set<string>();
    const evidenceByUrl = new Map<string, EvidenceMeta>();
    const brightDataReady = isBrightDataConfigured();
    let brightDataCircuitOpen = !brightDataReady;
    let previousRoundSummary: Record<string, any> = {};

    if (!brightDataReady) {
      logEvent('Bright Data token not configured. Continuing Tavily-only.');
    }

    for (let round = 1; round <= maxRounds && acceptedLeads.length < targetLimit; round++) {
      if (safetyTimeoutMs > 0 && Date.now() - startedAt > safetyTimeoutMs) {
        stats.stopReason = 'timeout';
        break;
      }

      stats.rounds = round;
      const remaining = targetLimit - acceptedLeads.length;
      const strategistPrompt = buildStrategistPrompt({
        query,
        round,
        maxRounds,
        remaining,
        previousQueries: generatedQueries,
        previousRoundSummary
      });

      let planItems: SearchQueryPlanItem[] = [];
      try {
        const queryResult = await openAIStructured<any>(strategistPrompt, searchQueriesSchema, STRATEGIST_SYSTEM_PROMPT);
        planItems = normalizeQueryPlanItems(queryResult);
      } catch (e: any) {
        logEvent(`WARN: Strategist failed in round ${round}: ${e.message}. Using fallback queries.`);
      }

      if (planItems.length === 0) {
        planItems = buildFallbackQueryPlan(query);
        logEvent(`Round ${round}: using ${planItems.length} deterministic fallback queries.`);
      }

      const roundPlans = planItems
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))
        .map(item => ({ item, executableQuery: toLinkedInSearchQuery(item) }))
        .filter(plan => {
          const key = plan.executableQuery.toLowerCase();
          if (seenQueryTexts.has(key)) return false;
          seenQueryTexts.add(key);
          return true;
        });

      if (roundPlans.length === 0) {
        logEvent(`Round ${round}: strategist produced no new queries.`);
        stats.stopReason = 'exhausted';
        break;
      }

      generatedQueries.push(...roundPlans.map(plan => plan.executableQuery));
      logEvent(`Round ${round}: executing ${roundPlans.length} Tavily queries.`);

      const queryRuns = roundPlans.map(plan => {
        const run: QueryRunStats = {
          round,
          query: plan.executableQuery,
          family: plan.item.family,
          intent: plan.item.intent,
          rawCandidates: 0,
          uniqueCandidates: 0,
          evidenceBlocks: 0,
          extractedLeads: 0,
          acceptedLeads: 0,
          rejectionReasons: {}
        };
        stats.queryRuns.push(run);
        return run;
      });

      const searchResults = await Promise.all(roundPlans.map((plan, index) => tavilySearch(plan.executableQuery).catch(e => {
        logEvent(`WARN: Search failed for query "${plan.executableQuery}": ${e.message}`);
        return { text: '', sources: [], items: [], _failedQueryIndex: index };
      })));

      const roundItems: any[] = [];
      for (let resultIndex = 0; resultIndex < searchResults.length; resultIndex++) {
        const result = searchResults[resultIndex];
        const queryRun = queryRuns[resultIndex];
        const plan = roundPlans[resultIndex];
        const items = Array.isArray(result.items) ? result.items : [];
        queryRun.rawCandidates = items.length;
        for (const item of items) {
          const url = item.url || '';
          const username = extractLinkedInUsername(url);
          const normalizedUrl = normalizeLinkedInUrl(url);
          const candidateKey = username || normalizedUrl || normalizeDedupeValue(`${item.title || ''} ${item.content || ''}`);
          if (!candidateKey || seenCandidateKeys.has(candidateKey)) {
            noteRejection('duplicate_candidate', queryRun);
            continue;
          }
          seenCandidateKeys.add(candidateKey);
          item._normalizedUrl = normalizedUrl;
          item._linkedinUsername = username;
          item._sourceQuery = plan.executableQuery;
          item._sourceRound = round;
          item._queryFamily = plan.item.family;
          item._queryIntent = plan.item.intent;
          item._expectedSignal = plan.item.expectedSignal;
          item._queryRun = queryRun;
          queryRun.uniqueCandidates++;
          roundItems.push(item);
        }
      }

      rawResultsCount = seenCandidateKeys.size;
      stats.rawCandidates = rawResultsCount;

      if (roundItems.length === 0) {
        logEvent(`Round ${round}: no new unique candidates.`);
        stats.stopReason = 'exhausted';
        break;
      }

      roundItems.sort((a, b) => {
        const scoreItem = (item: any) => `${item.title || ''} ${item.content || ''} ${item.raw_content || ''}`.length + (extractLinkedInUsername(item.url) ? 250 : 0);
        return scoreItem(b) - scoreItem(a);
      });

      const candidateBudget = Math.min(roundItems.length, Math.max(targetLimit * 4, 4));
      const candidateItems = roundItems.slice(0, candidateBudget);
      logEvent(`Round ${round}: using top ${candidateItems.length}/${roundItems.length} candidates for extraction budget.`);

      const evidenceBlocks: string[] = [];

      for (const item of candidateItems) {
        if (acceptedLeads.length >= targetLimit) break;
        const url = item.url || '';
        const normalizedUrl = item._normalizedUrl || normalizeLinkedInUrl(url);
        const username = item._linkedinUsername || extractLinkedInUsername(url);
        const title = item.title || 'Untitled result';
        const snippet = item.content || item.raw_content || '';
        const queryRun = item._queryRun as QueryRunStats | undefined;

        const cacheHit = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
        let sourceProvider: LeadSourceProvider = 'tavily';
        let evidenceQuality: EvidenceQuality = inferTavilyEvidenceQuality(item);
        let evidenceBlock = '';

        if (cacheHit) {
          stats.cacheHits++;
          brightDataStats.cacheHits++;
          sourceProvider = 'cache';
          evidenceQuality = cacheHit.scrapeQuality === 'good' ? 'good' : 'partial';
          evidenceBlock = cacheHit.evidenceBlock;
          logEvent(`Cache hit: ${username || normalizedUrl}`);
        } else if (!brightDataCircuitOpen && stats.enriched < enrichmentCap && username) {
          brightDataStats.attempted++;
          try {
            const markdown = await scrapeAsMarkdown(url);
            if (markdown) {
              const parsed = parseLinkedInEvidence(markdown, { title, url, snippet });
              if (parsed.quality === 'good' || parsed.quality === 'partial') {
                sourceProvider = 'brightdata';
                evidenceQuality = parsed.quality;
                evidenceBlock = parsed.evidenceBlock;
                stats.enriched++;
                brightDataStats.succeeded++;
                upsertEnrichmentCacheEntry({
                  normalizedUrl,
                  linkedinUsername: username,
                  personName: parsed.personName,
                  companyName: parsed.companyName,
                  evidenceBlock,
                  scrapeQuality: parsed.quality,
                  sourceProvider: 'brightdata'
                }, ttlDays);
                stats.cacheWrites++;
              } else {
                const mappedReason = mapBrightDataRejection(parsed.rejectionReason);
                incrementRejection(brightDataStats.rejectionReasons, mappedReason);
                noteRejection(mappedReason, queryRun);
                logEvent(`Bright Data scrape rejected for ${username}: ${parsed.rejectionReason || 'low quality'}`);
              }
            }
          } catch (e: any) {
            stats.brightDataFailures++;
            brightDataStats.failed++;
            incrementRejection(brightDataStats.rejectionReasons, 'brightdata_failed');
            noteRejection('brightdata_failed', queryRun);
            logEvent(`WARN: Bright Data failed for ${username}: ${e.message}`);
            if (stats.brightDataFailures >= 1) {
              brightDataCircuitOpen = true;
              logEvent('Bright Data circuit opened after first failure. Continuing Tavily-only.');
            }
          }
        } else {
          brightDataStats.skipped++;
        }

        if (!evidenceBlock) {
          evidenceBlock = buildTavilyEvidence(item);
          sourceProvider = 'tavily';
          evidenceQuality = inferTavilyEvidenceQuality(item);
        }

        const evidenceMeta: EvidenceMeta = {
          evidenceBlock,
          evidenceQuality,
          sourceProvider,
          sourceUrl: url,
          sourceQuery: item._sourceQuery || '',
          sourceRound: item._sourceRound || round,
          queryRun
        };
        evidenceByUrl.set(normalizedUrl, evidenceMeta);
        if (queryRun) queryRun.evidenceBlocks++;
        evidenceBlocks.push(`--- PROFILE CANDIDATE ---\nSOURCE_PROVIDER: ${sourceProvider}\nLINK: ${url}\n${evidenceBlock}\n\n`);
      }

      if (evidenceBlocks.length === 0) {
        logEvent(`Round ${round}: no usable evidence blocks.`);
        continue;
      }

      const chunks = chunkEvidenceBlocks(evidenceBlocks);
      logEvent(`Round ${round}: extracting ${chunks.length} evidence batches.`);

      for (let i = 0; i < chunks.length && acceptedLeads.length < targetLimit; i++) {
        try {
          const prompt = `Extract distinct, qualified B2B prospects from the source-labeled evidence below.\n\nRules:\n- Include only people with at least a full name and a title, company, or headline.\n- Do not invent data. Use empty strings for missing fields.\n- Preserve LINK as contactDetails.linkedinUrl.\n- Preserve SOURCE_PROVIDER as sourceProvider.\n- Score conservatively from 1-10 using only visible evidence.\n- Return at most ${targetLimit - acceptedLeads.length} best prospects from this batch.\n- Add evidenceReasons as 1-3 short reasons the prospect matches the user query.\n\nUser search criteria:\n${query}\n\nEvidence:\n${chunks[i]}`;

          const extracted = await openAIStructured<any[]>(prompt, bulkLeadsArraySchema, EXTRACTION_SYSTEM_PROMPT);
          const extractedLeads = Array.isArray(extracted) ? extracted : [];
          logEvent(`Round ${round}, chunk ${i + 1}/${chunks.length}: extracted ${extractedLeads.length} profiles.`);
          if (extractedLeads.length === 0) {
            noteRejection('llm_extraction_empty');
          }

          for (const lead of extractedLeads) {
            if (acceptedLeads.length >= targetLimit) break;
            const normalizedLeadUrl = normalizeLinkedInUrl(lead.contactDetails?.linkedinUrl);
            const evidenceMeta = evidenceByUrl.get(normalizedLeadUrl) || fallbackEvidenceForLead(lead);
            const queryRun = evidenceMeta.queryRun;
            if (queryRun) queryRun.extractedLeads++;

            lead.sourceProvider = lead.sourceProvider || evidenceMeta.sourceProvider;
            lead.evidenceReasons = Array.isArray(lead.evidenceReasons) && lead.evidenceReasons.length
              ? lead.evidenceReasons
              : [`Qualified from ${lead.sourceProvider} evidence for: ${query}`];
            lead.evidence = createLeadEvidence({
              sourceUrl: evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || '',
              sourceProvider: evidenceMeta.sourceProvider,
              sourceQuery: evidenceMeta.sourceQuery,
              sourceRound: evidenceMeta.sourceRound,
              evidenceQuality: evidenceMeta.evidenceQuality,
              evidenceBlock: evidenceMeta.evidenceBlock,
              whyThisLead: lead.evidenceReasons[0]
            });
            lead.scoreBreakdown = computeScoreBreakdown(lead, evidenceMeta.evidenceQuality, evidenceMeta.sourceProvider);
            lead.scoreOverride = lead.scoreBreakdown.finalScore;

            const rejectionReason = leadRejectionReason(lead, minScore);
            if (rejectionReason) {
              noteRejection(rejectionReason, queryRun);
              continue;
            }
            if (matchesExcludeList(lead) || hasDuplicateKeys(lead, existingKeys)) {
              noteRejection('duplicate_existing_lead', queryRun);
              continue;
            }

            addProfileKeys(lead, existingKeys);
            if (queryRun) queryRun.acceptedLeads++;
            acceptedLeads.push(lead);
          }
        } catch (e: any) {
          logEvent(`WARN: Extraction chunk ${i + 1}/${chunks.length} failed: ${e.message}`);
        }
      }

      const roundRuns = stats.queryRuns.filter(run => run.round === round);
      previousRoundSummary = {
        rawCandidates: roundRuns.reduce((sum, run) => sum + run.rawCandidates, 0),
        uniqueCandidates: roundRuns.reduce((sum, run) => sum + run.uniqueCandidates, 0),
        extractedLeads: roundRuns.reduce((sum, run) => sum + run.extractedLeads, 0),
        acceptedLeads: roundRuns.reduce((sum, run) => sum + run.acceptedLeads, 0),
        rejectionReasons: stats.rejectionReasons
      };
    }

    if (acceptedLeads.length === 0) {
      throw new Error('Could not extract any new qualified profiles from search results. Try more specific criteria.');
    }

    acceptedLeads.sort((a, b) => effectiveScore(b) - effectiveScore(a));
    const finalLeads = acceptedLeads.slice(0, targetLimit);
    leadsFound = finalLeads.length;
    stats.returned = leadsFound;

    if (leadsFound >= targetLimit) {
      stats.stopReason = 'target_reached';
    } else if (stats.stopReason === 'not_started') {
      stats.stopReason = stats.rounds >= maxRounds ? 'max_rounds' : 'exhausted';
    }

    logEvent(`Session complete: returned ${leadsFound}/${targetLimit}. Stop reason: ${stats.stopReason}. Stats: ${JSON.stringify(stats)}`);

    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
    insertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'success',
      errorMessage: '',
      rawResultsCount,
      leadsFound,
      detailedLogs: detailedLogsText
    });

    res.json({ leads: finalLeads, stats, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/find-leads:', error);

    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
    insertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'error',
      errorMessage: error.message || 'Failed to locate leads.',
      rawResultsCount,
      leadsFound: 0,
      detailedLogs: detailedLogsText
    });

    res.status(500).json({ error: error.message || 'Failed to locate leads.', stats });
  }
});
router.post('/generate-outbound', async (req, res): Promise<any> => {
  try {
    const {
      profile,
      tone,
      pitchType,
      valueProposition,
      senderName,
      senderCompany,
      sequenceStep,
      customInstruction,
      companyAccount,
      buyingSignals
    } = req.body;

    if (!profile || !profile.fullName) {
      return res.status(400).json({ error: 'Profile data is required for personalization.' });
    }

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable AI outreach generation.' });
    }

    console.log(`[generate-outbound] Generating outreach for: ${profile.fullName}`);

    const prompt = `Generate a highly personalized outreach message for the following prospect.

## Prospect Profile
- Name: ${profile.fullName}
- Title: ${profile.currentTitle} at ${profile.currentCompany}
- Industry: ${profile.industry || 'Unknown'}
- Location: ${profile.location || 'Unknown'}
- Seniority: ${profile.seniorityLevel || 'Unknown'}
- Company Size: ${profile.companySizeEst || 'Unknown'}
- Summary: ${profile.summary || ''}
- Pain Indicators: ${(profile.painIndicators || []).join(', ') || 'None listed'}
- Career Signals: ${(profile.careerSignals || []).join(', ') || 'None listed'}
- Tech Stack: ${(profile.techStackHints || []).join(', ') || 'Unknown'}
- Buying Signals: ${buyingSignals || 'None provided'}

## Campaign Settings
- Tone: ${tone || 'Professional'}
- Pitch Type: ${pitchType || 'Cold outreach'}
- Value Proposition: ${valueProposition || 'Not specified'}
- Sender: ${senderName || 'Sales Rep'} from ${senderCompany || 'Our Company'}
- Sequence Step: ${sequenceStep || 'Step 1 - First Touch'}
- Custom Instruction: ${customInstruction || 'None'}
- Channel: ${companyAccount ? 'Company LinkedIn Account' : 'Personal LinkedIn / Email'}

## Output Requirements
Return a complete HTML-formatted outreach message.
Follow the Golden Rules strictly:
1. Never start with "I"
2. Be specific - reference something real from their profile
3. One CTA only
4. LinkedIn connection note: max 300 characters
5. Cold email: max 150 words
6. No spam words: guaranteed, synergy, leverage, disruptive, game-changing, revolutionary

Format the output as clean HTML with proper line breaks and styling for display in a rich text editor.`;

    const { text: rawText } = await openAIText(prompt, APEX_SYSTEM_PROMPT);

    if (!rawText) {
      throw new Error('Failed to generate outreach copy.');
    }

    // Wrap plain text in HTML if it's not already HTML
    const text = rawText.includes('<') ? rawText : `<p>${rawText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;

    res.json({ text, sandboxMode: false });
  } catch (error: any) {
    console.error('Error generating outbound copy:', error);
    res.status(500).json({ error: error.message || 'Outreach template calculation failed.' });
  }
});

// -----------------------------------------------------------------------------
// Conversational CRM Copilot
// -----------------------------------------------------------------------------
router.post('/chat', async (req, res): Promise<any> => {
  try {
    const { query, leads = [] } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable the AI Copilot.' });
    }

    // Build a rich context summary of the CRM for LLM
    const leadsContext = leads.length === 0
      ? 'The CRM pipeline is currently empty.'
      : leads.slice(0, 20).map((l: any, i: number) =>
          `${i + 1}. ${l.profile?.fullName} - ${l.profile?.currentTitle} at ${l.profile?.currentCompany} | Stage: ${l.stage} | Fit: ${l.profile?.fitScore ?? '?'}/10 | Intent: ${l.profile?.intentScore ?? '?'}/10`
        ).join('\n');

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
${leads.length} total leads.
${leadsContext}

Answer the user's question about their CRM pipeline, leads, outreach strategy, or any sales-related query. Be direct, concise, and actionable. Format responses in markdown.`;

    const { text: reply } = await openAIText(query, systemPrompt);

    res.json({ text: reply || 'I could not generate a response. Please try again.' });
  } catch (error: any) {
    console.error('Error in Copilot Chat:', error);
    res.status(500).json({ error: error.message || 'Chat generation failed.' });
  }
});

export default router;

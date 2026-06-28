import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';

import { readStoredLeads, hasLeadStoreBeenInitialized, replaceStoredLeads, normalizeIncomingLeads, getLeadsDb, insertSearchLog, pruneExpiredEnrichmentCache, getEnrichmentCacheEntry, upsertEnrichmentCacheEntry, getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry } from '../db.js';
import { loadAuth, saveAuth } from '../auth.js';
import { hasOpenAIKey, tavilySearch, openAIStructured, singleProfileSchema, APEX_SYSTEM_PROMPT, leadsArraySchema, searchQueriesSchema, openAIText, STRATEGIST_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, bulkLeadsArraySchema } from '../services/llm.js';
import { getBrightDataStatus, isBrightDataConfigured, scrapeAsMarkdown, brightDataSearch } from '../services/brightdata.js';
import { buildTavilyEvidence, extractLinkedInUsername, normalizeLinkedInUrl, parseLinkedInEvidence } from '../services/linkedinEvidence.js';
import { computeScoreBreakdown, type EvidenceQuality, type LeadSourceProvider } from '../leadSearch/scoring.js';
import { createLeadEvidence, inferTavilyEvidenceQuality } from '../leadSearch/evidence.js';
import { buildFallbackQueryPlan, buildStrategistPrompt, normalizeQueryPlanItems, toLinkedInSearchQuery, type ProviderRunStats, type QueryRunStats, type SearchQueryPlanItem } from '../leadSearch/strategist.js';
import { incrementRejection, mapBrightDataRejection, type RejectionReason } from '../leadSearch/rejections.js';
import { verifyDecisionMakerFromEvidence } from '../leadSearch/verification.js';
import { checkCompanyIntent, findCompanyWebsite } from '../leadSearch/companyIntent.js';

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
    hasKey: hasOpenAIKey(),
    hasTavilyKey: !!process.env.TAVILY_API_KEY,
    hasOAuth: !!loadAuth(),
    hasGoogleClient: !!CLIENT_ID,
    brightData: getBrightDataStatus(),
  });
});

router.get('/llm-health', async (req, res) => {
  const gatewayMode = process.env.LLM_GATEWAY_MODE || 'direct';
  const baseUrl = gatewayMode === 'litellm' 
    ? (process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1')
    : (process.env.OPENAI_BASE || 'https://api.byesu.com/v1');
  const model = gatewayMode === 'litellm'
    ? (process.env.LITELLM_MODEL || 'apex-primary')
    : (process.env.OPENAI_MODEL || 'gpt-5.5');

  try {
    const response = await openAIText("Reply with exactly ok");
    const isOk = response.text.trim().toLowerCase().includes('ok');
    res.json({
      mode: gatewayMode,
      baseUrl,
      model,
      ok: isOk,
      ...(isOk ? {} : { error: `Unexpected response: ${response.text}` })
    });
  } catch (error: any) {
    res.json({
      mode: gatewayMode,
      baseUrl,
      model,
      ok: false,
      error: error.message || String(error)
    });
  }
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

  const brightDataStats = {
    configured: isBrightDataConfigured(),
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cacheHits: 0,
    searchAttempted: 0,
    searchSucceeded: 0,
    profileScrapesAttempted: 0,
    profileScrapesSucceeded: 0,
    companyScrapesAttempted: 0,
    companyScrapesSucceeded: 0,
    negativeCacheHits: 0,
    rejectionReasons: {} as Record<string, number>
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
    brightData: brightDataStats,
    sourceProvider: 'tavily' as 'tavily' | 'brightdata_search' | 'mixed',
    brightDataSearchResults: 0
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

  const getProfileDomain = (profile: any) => {
    const website = profile?.contactDetails?.website;
    if (website) return normalizeDedupeValue(website).split('/')[0];
    const email = profile?.contactDetails?.email;
    if (email && email.includes('@')) return email.toLowerCase().split('@')[1];
    return '';
  };

  const profileKeys = (profile: any) => {
    const keys = new Set<string>();
    const email = normalizeDedupeValue(profile?.contactDetails?.email);
    const linkedin = extractLinkedInUsername(profile?.contactDetails?.linkedinUrl);
    const name = normalizeDedupeValue(profile?.fullName);
    const company = normalizeDedupeValue(profile?.currentCompany);
    const domain = getProfileDomain(profile);
    if (email) keys.add(`email:${email}`);
    if (linkedin) keys.add(`linkedin:${linkedin}`);
    if (name && company) keys.add(`name_company:${name}::${company}`);
    if (name && domain) keys.add(`name_domain:${name}::${domain}`);
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
      sourceProvider: lead.sourceProvider === 'brightdata_search' ? 'brightdata' : (lead.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily'),
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

    const brightDataSearchMode = process.env.BRIGHTDATA_SEARCH_MODE || 'fallback';
    const profileConcurrency = Math.max(Number(process.env.BRIGHTDATA_PROFILE_CONCURRENCY || 2), 1);
    const profileMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_PROFILE_MAX_PER_SEARCH || 0) || Math.max(targetLimit * 2, 10), 0);
    const companyIntentEnabled = process.env.BRIGHTDATA_COMPANY_INTENT_ENABLED === 'true';
    const companyIntentMinScore = Math.min(Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MIN_SCORE || 8), 1), 10);
    const companyIntentMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MAX_PER_SEARCH || 3), 0);
    const profileEnrichmentStage = process.env.BRIGHTDATA_PROFILE_ENRICHMENT_STAGE || 'post_filter';

    if (!query) throw new Error('Search criteria/query is required');
    if (!hasOpenAIKey()) throw new Error('OPENAI_API_KEY is not configured. Add it to your .env file to enable real lead discovery.');

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

    // A small concurrency helper for promises
    const asyncQueue = async <T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> => {
      const results: T[] = [];
      const executing = new Set<Promise<void>>();
      for (const task of tasks) {
        const p = task().then(r => { results.push(r); });
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) {
          await Promise.race(executing);
        }
      }
      await Promise.all(executing);
      return results;
    };

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

      // 1. Tavily Search
      const searchResults = await Promise.all(roundPlans.map((plan, index) => tavilySearch(plan.executableQuery).catch(e => {
        logEvent(`WARN: Tavily Search failed for query "${plan.executableQuery}": ${e.message}`);
        return { text: '', sources: [], items: [], _failedQueryIndex: index };
      })));

      let roundItems: any[] = [];
      for (let resultIndex = 0; resultIndex < searchResults.length; resultIndex++) {
        const result = searchResults[resultIndex];
        const items = Array.isArray(result.items) ? result.items : [];
        for (const item of items) {
          item.sourceProvider = 'tavily';
          roundItems.push({ item, resultIndex });
        }
      }

      // 1b. Bright Data Fallback/Secondary Search
      let usingBrightDataSearch = false;
      if (brightDataReady && brightDataSearchMode !== 'off') {
        const isFallbackTriggered = brightDataSearchMode === 'fallback' && roundItems.length < 5;
        const isSecondaryTriggered = brightDataSearchMode === 'secondary';

        if (isFallbackTriggered || isSecondaryTriggered) {
          usingBrightDataSearch = true;
          stats.sourceProvider = stats.sourceProvider === 'tavily' && roundItems.length === 0 ? 'brightdata_search' : 'mixed';
          
          const bdSearchPlans = isSecondaryTriggered ? roundPlans.slice(0, 2) : roundPlans;
          logEvent(`Round ${round}: executing ${bdSearchPlans.length} Bright Data searches (mode: ${brightDataSearchMode}).`);
          
          brightDataStats.searchAttempted += bdSearchPlans.length;
          
          const bdResults = await Promise.all(bdSearchPlans.map(plan => brightDataSearch(plan.executableQuery).catch(e => {
            logEvent(`WARN: Bright Data Search failed: ${e.message}`);
            return [];
          })));

          for (let resultIndex = 0; resultIndex < bdResults.length; resultIndex++) {
            const items = bdResults[resultIndex] || [];
            if (items.length > 0) brightDataStats.searchSucceeded++;
            stats.brightDataSearchResults += items.length;
            for (const item of items) {
              item.sourceProvider = 'brightdata_search';
              roundItems.push({ item, resultIndex });
            }
          }
        }
      }

      // Deduplicate candidates
      let uniqueRoundItems = [];
      for (const { item, resultIndex } of roundItems) {
        const queryRun = queryRuns[resultIndex];
        const plan = roundPlans[resultIndex];
        
        const url = item.url || item.link || '';
        const username = extractLinkedInUsername(url);
        const normalizedUrl = normalizeLinkedInUrl(url);
        const candidateKey = username || normalizedUrl || normalizeDedupeValue(`${item.title || ''} ${item.content || item.snippet || ''}`);
        
        if (!candidateKey || seenCandidateKeys.has(candidateKey)) {
          // don't reject twice if it's mixed
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
        
        queryRun.rawCandidates++;
        queryRun.uniqueCandidates++;
        uniqueRoundItems.push(item);
      }

      rawResultsCount = seenCandidateKeys.size;
      stats.rawCandidates = rawResultsCount;

      if (uniqueRoundItems.length === 0) {
        logEvent(`Round ${round}: no new unique candidates.`);
        stats.stopReason = 'exhausted';
        break;
      }

      uniqueRoundItems.sort((a, b) => {
        const scoreItem = (item: any) => `${item.title || ''} ${item.content || ''} ${item.raw_content || ''}`.length + (extractLinkedInUsername(item.url) ? 250 : 0);
        return scoreItem(b) - scoreItem(a);
      });

      const candidateBudget = Math.min(uniqueRoundItems.length, Math.max(targetLimit * 4, 4));
      const candidateItems = uniqueRoundItems.slice(0, candidateBudget);
      logEvent(`Round ${round}: using top ${candidateItems.length}/${uniqueRoundItems.length} candidates for extraction budget.`);

      const evidenceBlocks: string[] = [];

      for (const item of candidateItems) {
        if (acceptedLeads.length >= targetLimit) break;
        const url = item.url || '';
        const normalizedUrl = item._normalizedUrl || normalizeLinkedInUrl(url);
        const username = item._linkedinUsername || extractLinkedInUsername(url);
        const queryRun = item._queryRun as QueryRunStats | undefined;

        let sourceProvider: LeadSourceProvider = item.sourceProvider === 'brightdata_search' ? 'brightdata' : 'tavily';
        let evidenceBlock = buildTavilyEvidence(item);
        let evidenceQuality = inferTavilyEvidenceQuality(item);
        
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

      const chunks = chunkEvidenceBlocks(evidenceBlocks);
      logEvent(`Round ${round}: extracting ${chunks.length} evidence batches.`);

      let provisionalLeads: any[] = [];
      for (let i = 0; i < chunks.length && provisionalLeads.length < targetLimit * 2; i++) {
        try {
          const prompt = `Extract distinct, qualified B2B prospects from the source-labeled evidence below.\n\nRules:\n- Include only people with at least a full name and a title, company, or headline.\n- Do not invent data. Use empty strings for missing fields.\n- Preserve LINK as contactDetails.linkedinUrl.\n- Preserve SOURCE_PROVIDER as sourceProvider.\n- Score conservatively from 1-10 using only visible evidence.\n- Add evidenceReasons as 1-3 short reasons the prospect matches the user query.\n\nUser search criteria:\n${query}\n\nEvidence:\n${chunks[i]}`;

          const extracted = await openAIStructured<any[]>(prompt, bulkLeadsArraySchema, EXTRACTION_SYSTEM_PROMPT);
          const extractedLeads = Array.isArray(extracted) ? extracted : [];
          logEvent(`Round ${round}, chunk ${i + 1}/${chunks.length}: extracted ${extractedLeads.length} profiles.`);
          if (extractedLeads.length === 0) {
            noteRejection('llm_extraction_empty');
          }
          provisionalLeads.push(...extractedLeads);
        } catch (e: any) {
          logEvent(`WARN: Extraction chunk ${i + 1}/${chunks.length} failed: ${e.message}`);
        }
      }

      // 3. Filtering & Decision Maker Verification
      let postFilterLeads: any[] = [];
      for (const lead of provisionalLeads) {
        const normalizedLeadUrl = normalizeLinkedInUrl(lead.contactDetails?.linkedinUrl);
        const evidenceMeta = evidenceByUrl.get(normalizedLeadUrl) || fallbackEvidenceForLead(lead);
        const queryRun = evidenceMeta.queryRun;

        // Identity/Role checks
        const hasIdentity = Boolean((lead?.fullName || '').trim());
        if (!hasIdentity) { noteRejection('missing_identity', queryRun); continue; }
        const hasRoleContext = Boolean((lead?.currentTitle || '').trim() || (lead?.currentCompany || '').trim() || (lead?.headline || '').trim());
        if (!hasRoleContext) { noteRejection('missing_role_context', queryRun); continue; }

        if (matchesExcludeList(lead) || hasDuplicateKeys(lead, existingKeys)) {
          noteRejection('duplicate_existing_lead', queryRun);
          continue;
        }

        const dmVerification = verifyDecisionMakerFromEvidence({
          query: promptQuery,
          fullName: lead.fullName,
          currentTitle: lead.currentTitle,
          currentCompany: lead.currentCompany,
          headline: lead.headline,
          evidenceText: evidenceMeta.evidenceBlock
        });

        lead.decisionMakerVerification = dmVerification;

        lead.sourceProvider = evidenceMeta.sourceProvider;
        lead.evidenceReasons = Array.isArray(lead.evidenceReasons) && lead.evidenceReasons.length
          ? lead.evidenceReasons : [`Qualified from ${lead.sourceProvider} evidence for: ${query}`];
        lead.evidence = createLeadEvidence({
          sourceUrl: evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || '',
          sourceProvider: evidenceMeta.sourceProvider,
          sourceQuery: evidenceMeta.sourceQuery,
          sourceRound: evidenceMeta.sourceRound,
          evidenceQuality: evidenceMeta.evidenceQuality,
          evidenceBlock: evidenceMeta.evidenceBlock,
          whyThisLead: lead.evidenceReasons[0]
        });

        lead.scoreBreakdown = computeScoreBreakdown(lead, evidenceMeta.evidenceQuality, evidenceMeta.sourceProvider, dmVerification);
        lead.scoreOverride = lead.scoreBreakdown.finalScore;

        if (dmVerification.ignoredTitle && dmVerification.confidence < 4 && effectiveScore(lead) < minScore) {
          noteRejection('not_decision_maker', queryRun);
          continue;
        }
        
        if (effectiveScore(lead) < minScore - 1) { // Apply hard floor slightly below minScore to allow enrichment
          noteRejection('score_below_minimum', queryRun);
          continue;
        }

        if (queryRun) { queryRun.extractedLeads++; }
        postFilterLeads.push({ lead, evidenceMeta, queryRun });
      }

      // 4. Post-Filter Bright Data Profile Enrichment (Deep Scrape)
      if (profileEnrichmentStage === 'post_filter') {
        const leadsToEnrich = postFilterLeads.filter(({ lead, evidenceMeta }) => {
          const score = effectiveScore(lead);
          // Enrich if borderline OR weak/partial evidence
          return (score >= minScore - 1 && score <= minScore + 1) || evidenceMeta.evidenceQuality !== 'good';
        }).slice(0, profileMaxPerSearch);

        logEvent(`Round ${round}: ${leadsToEnrich.length} leads selected for deep profile enrichment.`);

        const enrichTasks = leadsToEnrich.map(({ lead, evidenceMeta, queryRun }) => async () => {
          if (brightDataCircuitOpen || stats.enriched >= enrichmentCap) return;
          const url = evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl;
          if (!url) return;
          
          const normalizedUrl = normalizeLinkedInUrl(url);
          const username = extractLinkedInUsername(url);

          // Check caches
          const positiveCache = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
          const negativeCache = getNegativeEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });

          if (positiveCache) {
            stats.cacheHits++;
            brightDataStats.cacheHits++;
            evidenceMeta.sourceProvider = 'cache';
            evidenceMeta.evidenceQuality = positiveCache.scrapeQuality === 'good' ? 'good' : 'partial';
            evidenceMeta.evidenceBlock = positiveCache.evidenceBlock;
          } else if (negativeCache) {
            brightDataStats.negativeCacheHits++;
            const reason = negativeCache.evidenceBlock as RejectionReason;
            incrementRejection(brightDataStats.rejectionReasons, reason);
            noteRejection(reason, queryRun);
          } else if (username) {
            brightDataStats.profileScrapesAttempted++;
            try {
              const markdown = await scrapeAsMarkdown(url);
              if (markdown) {
                const title = lead.currentTitle || lead.headline || 'Untitled';
                const snippet = evidenceMeta.evidenceBlock;
                const parsed = parseLinkedInEvidence(markdown, { title, url, snippet });
                
                if (parsed.quality === 'good' || parsed.quality === 'partial') {
                  evidenceMeta.sourceProvider = 'brightdata';
                  evidenceMeta.evidenceQuality = parsed.quality;
                  evidenceMeta.evidenceBlock = parsed.evidenceBlock;
                  stats.enriched++;
                  brightDataStats.profileScrapesSucceeded++;
                  
                  upsertEnrichmentCacheEntry({
                    normalizedUrl,
                    linkedinUsername: username,
                    personName: parsed.personName,
                    companyName: parsed.companyName,
                    evidenceBlock: parsed.evidenceBlock,
                    scrapeQuality: parsed.quality,
                    sourceProvider: 'brightdata'
                  }, ttlDays);
                  stats.cacheWrites++;
                } else {
                  const mappedReason = mapBrightDataRejection(parsed.rejectionReason);
                  incrementRejection(brightDataStats.rejectionReasons, mappedReason);
                  noteRejection(mappedReason, queryRun);
                  logEvent(`Bright Data scrape rejected for ${username}: ${parsed.rejectionReason || 'low quality'}`);
                  
                  upsertNegativeEnrichmentCacheEntry({
                    normalizedUrl,
                    linkedinUsername: username,
                    evidenceBlock: mappedReason,
                    scrapeQuality: 'bad',
                    sourceProvider: 'brightdata'
                  });
                }
              }
            } catch (e: any) {
              stats.brightDataFailures++;
              brightDataStats.failed++;
              incrementRejection(brightDataStats.rejectionReasons, 'brightdata_failed');
              upsertNegativeEnrichmentCacheEntry({
                normalizedUrl,
                linkedinUsername: username,
                evidenceBlock: 'brightdata_failed',
                scrapeQuality: 'bad',
                sourceProvider: 'brightdata'
              });
              
              if (stats.brightDataFailures >= 3) {
                brightDataCircuitOpen = true;
                logEvent('Bright Data circuit opened after consecutive failures. Continuing Tavily-only.');
              }
            }
          }

          lead.decisionMakerVerification = verifyDecisionMakerFromEvidence({
            query: promptQuery,
            fullName: lead.fullName,
            currentTitle: lead.currentTitle,
            currentCompany: lead.currentCompany,
            headline: lead.headline,
            evidenceText: evidenceMeta.evidenceBlock
          });

          // Re-evaluate score with new evidence and updated authority verification.
          lead.evidence = createLeadEvidence({
            sourceUrl: evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || '',
            sourceProvider: evidenceMeta.sourceProvider,
            sourceQuery: evidenceMeta.sourceQuery,
            sourceRound: evidenceMeta.sourceRound,
            evidenceQuality: evidenceMeta.evidenceQuality,
            evidenceBlock: evidenceMeta.evidenceBlock,
            whyThisLead: lead.evidenceReasons[0]
          });
          lead.scoreBreakdown = computeScoreBreakdown(lead, evidenceMeta.evidenceQuality, evidenceMeta.sourceProvider, lead.decisionMakerVerification);
          lead.scoreOverride = lead.scoreBreakdown.finalScore;
        });

        await asyncQueue(enrichTasks, profileConcurrency);
      }

      // 5. Final Acceptance & Company Intent
      const companyIntentTasks: (() => Promise<void>)[] = [];

      for (const { lead, queryRun } of postFilterLeads) {
        if (acceptedLeads.length >= targetLimit) break;
        const finalDecisionMaker = lead.decisionMakerVerification || verifyDecisionMakerFromEvidence({
          query: promptQuery,
          fullName: lead.fullName,
          currentTitle: lead.currentTitle,
          currentCompany: lead.currentCompany,
          headline: lead.headline,
          evidenceText: lead.evidence?.snippets?.join(' ') || ''
        });
        lead.decisionMakerVerification = finalDecisionMaker;
        if (finalDecisionMaker.ignoredTitle || finalDecisionMaker.confidence < 5) {
          noteRejection('not_decision_maker', queryRun);
          continue;
        }
        lead.scoreBreakdown = computeScoreBreakdown(lead, lead.evidence?.evidenceQuality || 'weak', lead.evidence?.sourceProvider === 'cache' ? 'cache' : lead.evidence?.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily', finalDecisionMaker);
        lead.scoreOverride = lead.scoreBreakdown.finalScore;
        if (effectiveScore(lead) < minScore) {
          noteRejection('score_below_minimum', queryRun);
          continue;
        }

        if (queryRun) { queryRun.acceptedLeads++; }
        addProfileKeys(lead, existingKeys);
        acceptedLeads.push(lead);

        // Optional company intent scraping for accepted high-score leads only.
        if (companyIntentEnabled && lead.currentCompany && companyIntentTasks.length < companyIntentMaxPerSearch && effectiveScore(lead) >= companyIntentMinScore) {
          companyIntentTasks.push(async () => {
            const companyName = String(lead.currentCompany || '').trim();
            const cachedIntent = getEnrichmentCacheEntry({ personName: companyName, companyName: '__company_intent__' });
            if (cachedIntent) {
              brightDataStats.cacheHits++;
              try {
                lead.companyIntentEvidence = JSON.parse(cachedIntent.evidenceBlock);
              } catch {
                lead.companyIntentEvidence = {
                  websiteUrl: cachedIntent.normalizedUrl,
                  evidenceQuality: cachedIntent.scrapeQuality,
                  snippets: [cachedIntent.evidenceBlock],
                  buyingSignals: [],
                  painSignals: []
                };
              }
              return;
            }

            let websiteUrl = lead.contactDetails?.website || '';
            if (!websiteUrl || websiteUrl.includes('linkedin.com')) {
              brightDataStats.searchAttempted++;
              websiteUrl = await findCompanyWebsite({
                companyName,
                location: lead.location,
                brightDataSearch: async (searchQuery) => {
                  const results = await brightDataSearch(searchQuery);
                  if (results.length > 0) brightDataStats.searchSucceeded++;
                  return results;
                }
              }) || '';
            }

            if (!websiteUrl) return;
            brightDataStats.companyScrapesAttempted++;
            const intent = await checkCompanyIntent(websiteUrl);
            if (intent) {
              brightDataStats.companyScrapesSucceeded++;
              lead.companyIntentEvidence = intent;
              upsertEnrichmentCacheEntry({
                normalizedUrl: websiteUrl,
                personName: companyName,
                companyName: '__company_intent__',
                evidenceBlock: JSON.stringify(intent),
                scrapeQuality: intent.evidenceQuality === 'good' ? 'good' : 'partial',
                sourceProvider: 'brightdata'
              }, ttlDays);
            }
          });
        }
      }

      if (companyIntentTasks.length > 0) {
        await asyncQueue(companyIntentTasks, profileConcurrency);
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
    // fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
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
    // fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
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
    const stageCounts: Record<string, number> = {};
    leads.forEach((l: any) => {
      stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1;
    });
    const stageSummary = Object.entries(stageCounts)
      .map(([stage, count]) => `- ${stage}: ${count}`)
      .join('\n');

    const leadsContext = leads.length === 0
      ? 'The CRM pipeline is currently empty.'
      : leads.slice(0, 100).map((l: any, i: number) =>
          `${i + 1}. ${l.profile?.fullName} - ${l.profile?.currentTitle} at ${l.profile?.currentCompany} | Stage: ${l.stage} | Fit: ${l.profile?.fitScore ?? '?'}/10 | Intent: ${l.profile?.intentScore ?? '?'}/10`
        ).join('\n');

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
Total Leads: ${leads.length}

### Pipeline Stage Breakdown:
${stageSummary}

### Active Leads List (Showing top 100):
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

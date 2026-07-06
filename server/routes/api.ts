import { Router } from 'express';
import crypto from 'crypto';

import { readStoredLeads, hasLeadStoreBeenInitialized, replaceStoredLeads, normalizeIncomingLeads, getLeadsDb, insertSearchLog, readSearchLogs, readSearchLogById, pruneExpiredEnrichmentCache, getEnrichmentCacheEntry, upsertEnrichmentCacheEntry, getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry, pruneExpiredEmailDiscoveryCache, upsertLead, deleteLead, upsertLeads } from '../db.js';
import { hasOpenAIKey, tavilySearch, openAIStructured, singleProfileSchema, APEX_SYSTEM_PROMPT, leadsArraySchema, searchQueriesSchema, openAIText, STRATEGIST_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, bulkLeadsArraySchema, getLLMProviderSummaries } from '../services/llm.js';
import { BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, closeBrightDataClient, getBrightDataStatus, isBrightDataConfigured, scrapeAsMarkdown, scrapeBatchAsMarkdown, brightDataSearch, shouldAttemptBrightData, classifyBrightDataError, isBrightDataRetryableError } from '../services/brightdata.js';
import { buildTavilyEvidence, extractLinkedInUsername, normalizeLinkedInUrl, parseLinkedInEvidence } from '../services/linkedinEvidence.js';
import { computeScoreBreakdown, type EvidenceQuality, type LeadSourceProvider } from '../leadSearch/scoring.js';
import { createLeadEvidence, inferTavilyEvidenceQuality } from '../leadSearch/evidence.js';
import { buildFallbackQueryPlan, buildStrategistPrompt, normalizeQueryPlanItems, toLinkedInSearchQuery, type ProviderRunStats, type QueryRunStats, type SearchQueryPlanItem } from '../leadSearch/strategist.js';
import { incrementRejection, mapBrightDataRejection, type RejectionReason } from '../leadSearch/rejections.js';
import { verifyDecisionMakerFromEvidence } from '../leadSearch/verification.js';
import { checkCompanyIntent, findCompanyWebsite } from '../leadSearch/companyIntent.js';
import { applyEmailDiscoveryToLead, discoverProspectEmail } from '../leadSearch/emailDiscovery.js';
import { MiningTelemetryRecorder, estimateLLMCostUsd, getLLMRouteLabel, type MiningTraceEvent } from '../leadSearch/telemetry.js';

const router = Router();
export const activeSessions = new Map<string, string[]>();
export const activeSessionEvents = new Map<string, MiningTraceEvent[]>();

const isSafeSessionId = (value: string) => /^[A-Za-z0-9_-]{8,80}$/.test(value);

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

router.patch('/leads/:id', (req, res): any => {
  try {
    const lead = req.body?.lead;
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'Expected a lead object.' });
    }
    lead.id = req.params.id;
    if (!lead.createdAt) {
      lead.createdAt = new Date().toISOString();
    }
    upsertLead(lead);
    res.json({ success: true, lead });
  } catch (error: any) {
    console.error(`Failed to upsert lead ${req.params.id} to SQLite:`, error);
    res.status(500).json({ error: error.message || 'Failed to upsert lead' });
  }
});

router.delete('/leads/:id', (req, res): any => {
  try {
    deleteLead(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`Failed to delete lead ${req.params.id} from SQLite:`, error);
    res.status(500).json({ error: error.message || 'Failed to delete lead' });
  }
});

router.delete('/leads', (req, res): any => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'Expected an array of ids in request body.' });
    }
    const db = getLeadsDb();
    const stmt = db.prepare('DELETE FROM leads WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        stmt.run(id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ success: true, count: ids.length });
  } catch (error: any) {
    console.error('Failed to bulk delete leads from SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk delete leads' });
  }
});

router.post('/leads/bulk', (req, res): any => {
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads) {
      return res.status(400).json({ error: 'Expected a leads array.' });
    }
    upsertLeads(leads);
    res.json({ success: true, count: leads.length });
  } catch (error: any) {
    console.error('Failed to bulk upsert leads in SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk upsert leads' });
  }
});


// Active Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: hasOpenAIKey(),
    hasTavilyKey: !!process.env.TAVILY_API_KEY,
    hasOAuth: false,
    hasGoogleClient: false,
    brightData: getBrightDataStatus(),
    emailDiscovery: {
      mode: process.env.EMAIL_DISCOVERY_MODE || 'accepted_only',
      maxPerSearch: Number(process.env.EMAIL_DISCOVERY_MAX_PER_SEARCH || 10),
      cacheTtlDays: Number(process.env.EMAIL_DISCOVERY_CACHE_TTL_DAYS || 14)
    },
  });
});

router.get('/llm-health', async (req, res) => {
  const configuredProviders = getLLMProviderSummaries();

  try {
    const response = await openAIText("Reply with exactly ok");
    const isOk = response.text.trim().toLowerCase().includes('ok');
    res.json({
      mode: 'direct-fallback',
      provider: response.provider,
      baseUrl: response.baseUrl,
      model: response.model,
      configuredProviders,
      ok: isOk,
      ...(isOk ? {} : { error: `Unexpected response: ${response.text}` })
    });
  } catch (error: any) {
    res.json({
      mode: 'direct-fallback',
      configuredProviders,
      ok: false,
      error: error.message || String(error)
    });
  }
});

// Google OAuth is deprecated in favor of standalone primary LLM

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
    const logs = readSearchLogs().map((log: any) => ({
      id: log.id,
      timestamp: log.timestamp,
      prompt: log.prompt,
      generatedQueries: log.generatedQueries,
      status: log.status,
      errorMessage: log.errorMessage,
      rawResultsCount: log.rawResultsCount,
      leadsFound: log.leadsFound,
      detailedLogs: log.detailedLogs,
      debugLogs: log.debugLogs,
      traceSummary: {
        eventCount: log.traceEvents?.length || 0,
        providerSummary: log.providerSummary || {},
        costSummary: log.costSummary || {},
        phaseTimeline: log.phaseTimeline || [],
        schemaVersion: log.schemaVersion || 1
      },
      providerSummary: log.providerSummary || {},
      costSummary: log.costSummary || {},
      phaseTimeline: log.phaseTimeline || []
    }));
    res.json(logs);
  } catch (error: any) {
    console.error('Failed to read search logs:', error);
    res.status(500).json({ error: 'Failed to retrieve search logs.' });
  }
});

router.get('/search-logs/:id/live', (req, res) => {
  const logs = activeSessions.get(req.params.id) || [];
  const traceEvents = activeSessionEvents.get(req.params.id) || [];
  res.json({ logs, traceEvents });
});

router.get('/mining-sessions/:sessionId/trace', (req, res): any => {
  try {
    const log = readSearchLogById(req.params.sessionId);
    if (!log) return res.status(404).json({ error: 'Mining session trace not found.' });
    res.json({
      sessionId: log.id,
      timestamp: log.timestamp,
      prompt: log.prompt,
      status: log.status,
      errorMessage: log.errorMessage,
      rawResultsCount: log.rawResultsCount,
      leadsFound: log.leadsFound,
      detailedLogs: log.detailedLogs,
      debugLogs: log.debugLogs,
      traceEvents: log.traceEvents || [],
      providerSummary: log.providerSummary || {},
      costSummary: log.costSummary || {},
      phaseTimeline: log.phaseTimeline || [],
      schemaVersion: log.schemaVersion || 1
    });
  } catch (error: any) {
    console.error('Failed to read mining session trace:', error);
    res.status(500).json({ error: 'Failed to retrieve mining session trace.' });
  }
});
// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
router.post('/find-leads', async (req, res): Promise<any> => {
  const suppliedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (suppliedSessionId && !isSafeSessionId(suppliedSessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const sessionId = suppliedSessionId || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  if (activeSessions.has(sessionId)) {
    return res.status(409).json({ error: 'A lead mining session with this sessionId is already active.', sessionId });
  }

  const sessionLogs: string[] = [];
  const debugLogs: any[] = [];
  const logEvent = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    sessionLogs.push(line);
    activeSessions.set(sessionId, sessionLogs);
  };

  let generatedQueries: string[] = [];
  let rawResultsCount = 0;
  let leadsFound = 0;
  const promptQuery = req.body.query || '';
  const startedAt = Date.now();
  const requestedLimit = Math.min(Math.max(Number(req.body.limit || 5), 1), 200);
  const telemetry = new MiningTelemetryRecorder(sessionId, promptQuery, requestedLimit, new Date(startedAt).toISOString());
  const recordTrace = (event: Omit<MiningTraceEvent, 'id' | 'timestamp'> & { timestamp?: string }) => {
    const recorded = telemetry.record(event);
    activeSessionEvents.set(sessionId, telemetry.getEvents().slice(-100));
    return recorded;
  };
  const traceLogFields = () => {
    const trace = telemetry.getTrace();
    return {
      traceEvents: trace.events,
      providerSummary: trace.providerSummary,
      costSummary: trace.costSummary,
      phaseTimeline: trace.phaseTimeline,
      schemaVersion: trace.schemaVersion
    };
  };
  const safeInsertSearchLog = (entry: Parameters<typeof insertSearchLog>[0]) => {
    try {
      insertSearchLog({ ...entry, ...traceLogFields() });
    } catch (error) {
      console.warn('[find-leads] failed to write search log:', error instanceof Error ? error.message : String(error));
    }
  };
  const estimateTokens = (value: unknown) => Math.ceil(String(value || '').length / 4);
  const summarizeLLM = (purpose: string, promptText: string, output: unknown, latencyMs: number, parseRetries = 0) => {
    const route = getLLMRouteLabel();
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(typeof output === 'string' ? output : JSON.stringify(output || ''));
    return {
      purpose,
      model: route.model,
      route: route.route,
      fallbackUsed: false,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimateLLMCostUsd(inputTokens, outputTokens),
      parseRetries
    };
  };
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
    batchScrapesAttempted: 0,
    batchScrapesSucceeded: 0,
    batchScrapesPartial: 0,
    batchScrapesFailed: 0,
    profileRetryQueued: 0,
    profileRetryAttempted: 0,
    profileRetrySucceeded: 0,
    transientFailures: 0,
    transportFailures: 0,
    providerDisabled: 0,
    emptyResponses: 0,
    negativeCacheWrites: 0,
    negativeCacheSkippedTransient: 0,
    processRestarts: 0,
    rejectionReasons: {} as Record<string, number>,
    failureReasons: {} as Record<string, number>
  };

  const incrementCounter = (counts: Record<string, number>, reason: string) => {
    counts[reason] = (counts[reason] || 0) + 1;
  };

  const stats = {
    requested: requestedLimit,
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
    brightDataSearchResults: 0,
    emailDiscovery: {
      mode: String(req.body.emailDiscovery || process.env.EMAIL_DISCOVERY_MODE || 'accepted_only'),
      attempted: 0,
      found: 0,
      confirmedPublic: 0,
      companyPublic: 0,
      patternLikely: 0,
      domainOnly: 0,
      notFound: 0,
      failed: 0,
      cachePruned: 0
    }
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
    logEvent(`--- NEW ADAPTIVE MINING SESSION: ${sessionId} ---`);
    recordTrace({
      phase: 'session',
      operation: 'start',
      status: 'started',
      provider: 'system',
      counts: { requested: stats.requested },
      metadata: { queryLength: String(promptQuery || '').length }
    });
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries: [],
      status: 'running',
      errorMessage: '',
      rawResultsCount: 0,
      leadsFound: 0,
      detailedLogs: sessionLogs.join('\n'),
      debugLogs: JSON.stringify(debugLogs)
    });

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
    const profileConcurrency = Math.max(Number(process.env.BRIGHTDATA_PROFILE_CONCURRENCY || 1), 1);
    const profileMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_PROFILE_MAX_PER_SEARCH || 0) || Math.max(targetLimit * 2, 10), 0);
    const companyIntentEnabled = process.env.BRIGHTDATA_COMPANY_INTENT_ENABLED === 'true';
    const companyIntentMinScore = Math.min(Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MIN_SCORE || 8), 1), 10);
    const companyIntentMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MAX_PER_SEARCH || 3), 0);
    const profileEnrichmentStage = process.env.BRIGHTDATA_PROFILE_ENRICHMENT_STAGE || 'post_filter';

    if (!query) throw new Error('Search criteria/query is required');
    if (!hasOpenAIKey()) throw new Error('OPENAI_API_KEY is not configured. Add it to your .env file to enable real lead discovery.');

    const expiredRows = pruneExpiredEnrichmentCache();
    if (expiredRows > 0) logEvent(`Pruned ${expiredRows} expired enrichment cache rows.`);
    const expiredEmailRows = pruneExpiredEmailDiscoveryCache();
    stats.emailDiscovery.cachePruned = expiredEmailRows;
    if (expiredEmailRows > 0) logEvent(`Pruned ${expiredEmailRows} expired email discovery cache rows.`);

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
    const brightDataReady = shouldAttemptBrightData();
    let brightDataProviderDisabled = !brightDataReady;
    let brightDataToolDegraded = false;
    let brightDataTransportRetryAfter = 0;
    const urlRetryQueue = new Set<string>();
    let previousRoundSummary: Record<string, any> = {};

    if (!brightDataReady) {
      const status = getBrightDataStatus();
      brightDataProviderDisabled = status.health === 'provider_disabled' || status.health === 'unconfigured';
      logEvent(isBrightDataConfigured() ? 'Bright Data is temporarily unavailable. Continuing with cache/Tavily fallbacks.' : 'Bright Data token not configured. Continuing Tavily-only.');
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
      if (remaining <= 2 && round > 1) {
        logEvent(`Round ${round}: target near completion (remaining: ${remaining}). Skipping LLM Strategist planning to optimize efficiency.`);
      } else {
        const strategyStarted = Date.now();
        try {
          recordTrace({
            phase: 'strategy',
            operation: 'strategist_planning',
            status: 'started',
            provider: 'llm',
            round,
            metadata: { promptLength: strategistPrompt.length }
          });
          const queryResult = await openAIStructured<any>(
            strategistPrompt,
            searchQueriesSchema,
            STRATEGIST_SYSTEM_PROMPT,
            { maxTokens: 800, temperature: 0.1 }
          );
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'llm_request',
            label: `strategist_round_${round}`,
            model: process.env.OPENAI_MODEL || 'gpt-5.5',
            prompt: strategistPrompt,
            systemInstruction: STRATEGIST_SYSTEM_PROMPT,
            response: queryResult
          });
          planItems = normalizeQueryPlanItems(queryResult);
          recordTrace({
            phase: 'strategy',
            operation: 'strategist_planning',
            status: 'success',
            provider: 'llm',
            round,
            latencyMs: Date.now() - strategyStarted,
            counts: { generatedQueries: planItems.length },
            llm: summarizeLLM('strategy', strategistPrompt, queryResult, Date.now() - strategyStarted)
          });
        } catch (e: any) {
          recordTrace({
            phase: 'strategy',
            operation: 'strategist_planning',
            status: 'error',
            provider: 'llm',
            round,
            latencyMs: Date.now() - strategyStarted,
            error: { message: e.message || String(e) },
            llm: summarizeLLM('strategy', strategistPrompt, '', Date.now() - strategyStarted)
          });
          logEvent(`WARN: Strategist failed in round ${round}: ${e.message}. Using fallback queries.`);
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'llm_error',
            label: `strategist_round_${round}`,
            prompt: strategistPrompt,
            error: e.message
          });
        }
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
      recordTrace({
        phase: 'search',
        operation: 'tavily_round_search',
        status: 'started',
        provider: 'tavily',
        round,
        counts: { queries: roundPlans.length },
        tavily: {
          searchDepth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
          maxResults: Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS || 10), 1), 20),
          includeDomains: ['linkedin.com/in']
        }
      });
      const searchResults = await Promise.all(roundPlans.map(async (plan, index) => {
        const searchStarted = Date.now();
        try {
          const res = await tavilySearch(plan.executableQuery, ['linkedin.com/in']);
          const resultsCount = res.items?.length || 0;
          recordTrace({
            phase: 'search',
            operation: 'tavily_search',
            status: 'success',
            provider: 'tavily',
            round,
            query: plan.executableQuery,
            latencyMs: Date.now() - searchStarted,
            counts: { rawCandidates: resultsCount },
            tavily: {
              searchDepth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
              maxResults: Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS || 10), 1), 20),
              includeDomains: ['linkedin.com/in']
            }
          });
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'tavily_search',
            query: plan.executableQuery,
            resultsCount,
            results: res.items?.map((item: any) => ({ title: item.title, url: item.url, snippet: item.content || item.raw_content }))
          });
          return res;
        } catch (e: any) {
          recordTrace({
            phase: 'search',
            operation: 'tavily_search',
            status: 'error',
            provider: 'tavily',
            round,
            query: plan.executableQuery,
            latencyMs: Date.now() - searchStarted,
            error: { message: e.message || String(e) }
          });
          logEvent(`WARN: Tavily Search failed for query "${plan.executableQuery}": ${e.message}`);
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'tavily_error',
            query: plan.executableQuery,
            error: e.message
          });
          return { text: '', sources: [], items: [], _failedQueryIndex: index };
        }
      }));

      let roundItems: any[] = [];      for (let resultIndex = 0; resultIndex < searchResults.length; resultIndex++) {
        const result = searchResults[resultIndex];
        const items = Array.isArray(result.items) ? result.items : [];
        for (const item of items) {
          item.sourceProvider = 'tavily';
          roundItems.push({ item, resultIndex });
        }
      }

      // 1b. Bright Data Fallback/Secondary Search
      let usingBrightDataSearch = false;
      if (brightDataReady && !brightDataProviderDisabled && brightDataSearchMode !== 'off') {
        const isFallbackTriggered = brightDataSearchMode === 'fallback' && roundItems.length < 5;
        const isSecondaryTriggered = brightDataSearchMode === 'secondary';

        if (isFallbackTriggered || isSecondaryTriggered) {
          usingBrightDataSearch = true;
          stats.sourceProvider = stats.sourceProvider === 'tavily' && roundItems.length === 0 ? 'brightdata_search' : 'mixed';
          
          const bdSearchPlans = isSecondaryTriggered ? roundPlans.slice(0, 2) : roundPlans;
          logEvent(`Round ${round}: executing ${bdSearchPlans.length} Bright Data searches (mode: ${brightDataSearchMode}).`);
          
          brightDataStats.searchAttempted += bdSearchPlans.length;
          
          const bdResults = await Promise.all(bdSearchPlans.map(async plan => {
            const bdSearchStarted = Date.now();
            try {
              const results = await brightDataSearch(plan.executableQuery);
              recordTrace({
                phase: 'search',
                operation: 'brightdata_search',
                status: 'success',
                provider: 'brightdata',
                round,
                query: plan.executableQuery,
                latencyMs: Date.now() - bdSearchStarted,
                counts: { rawCandidates: results.length },
                brightData: getBrightDataStatus()
              });
              return results;
            } catch (e: any) {
              const classified = classifyBrightDataError(e);
              incrementCounter(brightDataStats.failureReasons, classified.reasonCode);
              if (classified.reasonCode === 'target_transient') brightDataStats.transientFailures++;
              if (classified.reasonCode === 'transport_transient') {
                brightDataStats.transportFailures++;
                brightDataStats.processRestarts++;
                brightDataTransportRetryAfter = Date.now() + 5_000;
              }
              if (classified.providerDisabled) {
                brightDataStats.providerDisabled++;
                brightDataProviderDisabled = true;
              }
              recordTrace({
                phase: 'search',
                operation: 'brightdata_search',
                status: 'error',
                provider: 'brightdata',
                round,
                query: plan.executableQuery,
                latencyMs: Date.now() - bdSearchStarted,
                error: { message: classified.reasonCode + ': ' + classified.message },
                brightData: getBrightDataStatus()
              });
              logEvent(`WARN: Bright Data Search failed: ${classified.message}`);
              return [];
            }
          }));
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
        
        // Skip immediately if the candidate already exists in our CRM!
        if (username && existingKeys.has(`linkedin:${username}`)) {
          noteRejection('duplicate_existing_lead', queryRun);
          continue;
        }
        if (normalizedUrl && existingKeys.has(`linkedin:${normalizedUrl}`)) {
          noteRejection('duplicate_existing_lead', queryRun);
          continue;
        }

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

      const extractionChunkChars = Math.min(Math.max(Number(process.env.LEAD_EXTRACTION_CHUNK_CHARS || 3200), 1800), 9000);
      const chunks = chunkEvidenceBlocks(evidenceBlocks, extractionChunkChars);
      logEvent(`Round ${round}: extracting ${chunks.length} evidence batches in parallel.`);
      recordTrace({
        phase: 'extraction',
        operation: 'chunk_evidence',
        status: 'info',
        provider: 'system',
        round,
        counts: { chunks: chunks.length, evidenceBlocks: evidenceBlocks.length }
      });

      const extractionTasks = chunks.map((chunk, idx) => async () => {
        const chunkIndex = idx + 1;
        const extractionStarted = Date.now();
        const prompt = `Extract distinct, qualified B2B prospects from the source-labeled evidence below.\n\nRules:\n- Include only people with at least a full name and a title, company, or headline.\n- Do not invent data. Use empty strings for missing fields.\n- Preserve LINK as contactDetails.linkedinUrl.\n- Preserve SOURCE_PROVIDER as sourceProvider.\n- Score conservatively from 1-10 using only visible evidence.\n- Add evidenceReasons as 1-3 short reasons the prospect matches the user query.\n\nUser search criteria:\n${query}\n\nEvidence:\n${chunk}`;
        try {
          const extracted = await openAIStructured<any[]>(
            prompt,
            bulkLeadsArraySchema,
            EXTRACTION_SYSTEM_PROMPT,
            { maxTokens: Math.min(Math.max(Number(process.env.LEAD_EXTRACTION_MAX_TOKENS || 3000), 1500), 8000), temperature: 0.0 }
          );
          const extractedLeads = Array.isArray(extracted) ? extracted : [];
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'llm_request',
            label: `extraction_round_${round}_chunk_${chunkIndex}`,
            model: process.env.OPENAI_MODEL || 'gpt-5.5',
            prompt,
            systemInstruction: EXTRACTION_SYSTEM_PROMPT,
            response: extractedLeads
          });
          logEvent(`Round ${round}, chunk ${chunkIndex}/${chunks.length}: extracted ${extractedLeads.length} profiles.`);
          recordTrace({
            phase: 'extraction',
            operation: 'llm_extract_chunk',
            status: 'success',
            provider: 'llm',
            round,
            chunk: { index: chunkIndex, total: chunks.length, inputChars: chunk.length },
            latencyMs: Date.now() - extractionStarted,
            counts: { extractedProfiles: extractedLeads.length },
            llm: summarizeLLM('extraction', prompt, extractedLeads, Date.now() - extractionStarted)
          });
          if (extractedLeads.length === 0) {
            noteRejection('llm_extraction_empty');
          }
          return extractedLeads;
        } catch (e: any) {
          recordTrace({
            phase: 'extraction',
            operation: 'llm_extract_chunk',
            status: 'error',
            provider: 'llm',
            round,
            chunk: { index: chunkIndex, total: chunks.length, inputChars: chunk.length },
            latencyMs: Date.now() - extractionStarted,
            error: { message: e.message || String(e) },
            llm: summarizeLLM('extraction', prompt, '', Date.now() - extractionStarted)
          });
          logEvent(`WARN: Extraction chunk ${chunkIndex}/${chunks.length} failed: ${e.message}`);
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'llm_error',
            label: `extraction_round_${round}_chunk_${chunkIndex}`,
            prompt,
            error: e.message
          });
          return [];
        }
      });

      const extractionConcurrency = Math.min(Math.max(Number(process.env.LEAD_EXTRACTION_CONCURRENCY || 1), 1), 4);
      const extractionResults = await asyncQueue(extractionTasks, extractionConcurrency);
      let provisionalLeads: any[] = [];
      for (const extractedLeads of extractionResults) {
        provisionalLeads.push(...extractedLeads);
      }

      recordTrace({
        phase: 'filtering',
        operation: 'provisional_leads_ready',
        status: 'success',
        provider: 'system',
        round,
        counts: { provisionalLeads: provisionalLeads.length }
      });

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

      recordTrace({
        phase: 'filtering',
        operation: 'lead_filtering',
        status: 'success',
        provider: 'system',
        round,
        counts: { postFilterLeads: postFilterLeads.length },
        metadata: { rejectionReasons: stats.rejectionReasons }
      });

      // 4. Post-Filter Bright Data Profile Enrichment (Deep Scrape)
      if (profileEnrichmentStage === 'post_filter') {
        type EnrichmentTarget = {
          lead: any;
          evidenceMeta: EvidenceMeta;
          queryRun?: QueryRunStats;
          url: string;
          normalizedUrl: string;
          username: string;
          reserved: boolean;
          enriched: boolean;
          retryAttempts: number;
          highValue: boolean;
        };

        const selectedRows = postFilterLeads.filter(({ lead, evidenceMeta }) => {
          const score = effectiveScore(lead);
          return (score >= minScore - 1 && score <= minScore + 1) || evidenceMeta.evidenceQuality !== 'good';
        }).slice(0, profileMaxPerSearch);

        logEvent('Round ' + round + ': ' + selectedRows.length + ' leads selected for deep profile enrichment.');
        recordTrace({
          phase: 'enrichment',
          operation: 'brightdata_profile_selection',
          status: selectedRows.length > 0 ? 'started' : 'skipped',
          provider: 'brightdata',
          round,
          counts: { selectedForEnrichment: selectedRows.length },
          brightData: getBrightDataStatus()
        });

        const refreshLeadEvidence = (target: EnrichmentTarget) => {
          const { lead, evidenceMeta } = target;
          lead.decisionMakerVerification = verifyDecisionMakerFromEvidence({
            query: promptQuery,
            fullName: lead.fullName,
            currentTitle: lead.currentTitle,
            currentCompany: lead.currentCompany,
            headline: lead.headline,
            evidenceText: evidenceMeta.evidenceBlock
          });
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
        };

        const classifyAndRecordBrightDataFailure = (error: unknown, operation: string, url?: string) => {
          const classified = classifyBrightDataError(error);
          stats.brightDataFailures++;
          brightDataStats.failed++;
          incrementCounter(brightDataStats.failureReasons, classified.reasonCode);
          if (classified.reasonCode === 'target_transient') brightDataStats.transientFailures++;
          if (classified.reasonCode === 'transport_transient') {
            brightDataStats.transportFailures++;
            brightDataStats.processRestarts++;
            brightDataTransportRetryAfter = Date.now() + 5_000;
          }
          if (classified.providerDisabled) {
            brightDataStats.providerDisabled++;
            brightDataProviderDisabled = true;
          }
          if (classified.reasonCode === 'target_transient' || classified.reasonCode === 'target_blocked') {
            brightDataToolDegraded = true;
          }
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: operation,
            url,
            reasonCode: classified.reasonCode,
            retryable: classified.retryable,
            providerDisabled: classified.providerDisabled,
            error: classified.message
          });
          return classified;
        };

        const queueRetry = (target: EnrichmentTarget, reason: string) => {
          if (!target.highValue || brightDataProviderDisabled) return;
          if (urlRetryQueue.has(target.normalizedUrl)) return;
          urlRetryQueue.add(target.normalizedUrl);
          brightDataStats.profileRetryQueued++;
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'brightdata_profile_retry',
            url: target.url,
            status: 'queued',
            reason
          });
        };

        const applyMarkdownToTarget = (target: EnrichmentTarget, markdown: string, source: 'batch' | 'retry') => {
          if (!markdown || markdown.trim().length === 0) {
            brightDataStats.emptyResponses++;
            brightDataStats.negativeCacheSkippedTransient++;
            queueRetry(target, 'empty_body');
            debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_transient_skip_cache', url: target.url, reason: 'empty_body' });
            return false;
          }

          const title = target.lead.currentTitle || target.lead.headline || 'Untitled';
          const snippet = target.evidenceMeta.evidenceBlock;
          const parsed = parseLinkedInEvidence(markdown, { title, url: target.url, snippet });
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: source === 'batch' ? 'brightdata_batch_parse' : 'brightdata_parse',
            url: target.url,
            quality: parsed.quality,
            rejectionReason: parsed.rejectionReason,
            evidenceBlock: parsed.evidenceBlock
          });

          if (parsed.quality === 'good' || parsed.quality === 'partial') {
            target.evidenceMeta.sourceProvider = 'brightdata';
            target.evidenceMeta.evidenceQuality = parsed.quality;
            target.evidenceMeta.evidenceBlock = parsed.evidenceBlock;
            target.enriched = true;
            brightDataStats.profileScrapesSucceeded++;
            if (source === 'retry') brightDataStats.profileRetrySucceeded++;
            upsertEnrichmentCacheEntry({
              normalizedUrl: target.normalizedUrl,
              linkedinUsername: target.username,
              personName: parsed.personName,
              companyName: parsed.companyName,
              evidenceBlock: parsed.evidenceBlock,
              scrapeQuality: parsed.quality,
              sourceProvider: 'brightdata'
            }, ttlDays);
            stats.cacheWrites++;
            refreshLeadEvidence(target);
            return true;
          }

          const mappedReason = mapBrightDataRejection(parsed.rejectionReason);
          incrementRejection(brightDataStats.rejectionReasons, mappedReason);
          noteRejection(mappedReason, target.queryRun);
          logEvent('Bright Data scrape rejected for ' + target.username + ': ' + (parsed.rejectionReason || 'low quality'));

          upsertNegativeEnrichmentCacheEntry({
            normalizedUrl: target.normalizedUrl,
            linkedinUsername: target.username,
            evidenceBlock: mappedReason,
            scrapeQuality: 'bad',
            sourceProvider: 'brightdata'
          }, parsed.rejectionReason === 'blocked_or_login_wall' ? 0.25 : undefined);
          brightDataStats.negativeCacheWrites++;
          return false;
        };

        const targetsByUrl = new Map<string, EnrichmentTarget>();
        let reservedSlots = 0;
        for (const { lead, evidenceMeta, queryRun } of selectedRows) {
          const rawUrl = evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl;
          if (!rawUrl) continue;
          const normalizedUrl = normalizeLinkedInUrl(rawUrl);
          const username = extractLinkedInUsername(rawUrl);
          if (!normalizedUrl || !username || targetsByUrl.has(normalizedUrl)) continue;

          const positiveCache = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
          if (positiveCache) {
            stats.cacheHits++;
            brightDataStats.cacheHits++;
            evidenceMeta.sourceProvider = 'cache';
            evidenceMeta.evidenceQuality = positiveCache.scrapeQuality === 'good' ? 'good' : 'partial';
            evidenceMeta.evidenceBlock = positiveCache.evidenceBlock;
            const cachedTarget: EnrichmentTarget = { lead, evidenceMeta, queryRun, url: rawUrl, normalizedUrl, username, reserved: false, enriched: true, retryAttempts: 0, highValue: true };
            refreshLeadEvidence(cachedTarget);
            continue;
          }

          const negativeCache = getNegativeEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
          if (negativeCache) {
            brightDataStats.negativeCacheHits++;
            const reason = negativeCache.evidenceBlock as RejectionReason;
            incrementRejection(brightDataStats.rejectionReasons, reason);
            noteRejection(reason, queryRun);
            continue;
          }

          if (reservedSlots >= enrichmentCap) break;
          const score = effectiveScore(lead);
          const target: EnrichmentTarget = {
            lead,
            evidenceMeta,
            queryRun,
            url: rawUrl,
            normalizedUrl,
            username,
            reserved: true,
            enriched: false,
            retryAttempts: 0,
            highValue: score >= minScore - 1
          };
          reservedSlots++;
          stats.enriched++;
          targetsByUrl.set(normalizedUrl, target);
        }

        const uncachedTargets = Array.from(targetsByUrl.values());
        if (brightDataProviderDisabled) {
          brightDataStats.skipped += uncachedTargets.length;
        }

        const batchSize = BRIGHTDATA_SCRAPE_BATCH_MAX_URLS;
        for (let i = 0; i < uncachedTargets.length && !brightDataProviderDisabled; i += batchSize) {
          if (brightDataTransportRetryAfter && Date.now() < brightDataTransportRetryAfter) break;
          const batchTargets = uncachedTargets.slice(i, i + batchSize);
          const batchUrls = batchTargets.map(target => target.url);
          const started = Date.now();
          brightDataStats.attempted++;
          brightDataStats.profileScrapesAttempted += batchTargets.length;
          brightDataStats.batchScrapesAttempted++;
          try {
            const batchResults = await scrapeBatchAsMarkdown(batchUrls);
            const resultByKey = new Map<string, string>();
            for (const item of batchResults) {
              const normalized = normalizeLinkedInUrl(item.url);
              const username = extractLinkedInUsername(item.url);
              if (normalized) resultByKey.set(normalized, item.content);
              if (username) resultByKey.set('user:' + username, item.content);
            }

            let successCount = 0;
            for (const target of batchTargets) {
              const markdown = resultByKey.get(target.normalizedUrl) || resultByKey.get('user:' + target.username) || '';
              if (markdown && applyMarkdownToTarget(target, markdown, 'batch')) successCount++;
              if (!markdown) {
                brightDataStats.emptyResponses++;
                queueRetry(target, 'batch_miss');
              }
            }

            if (successCount === batchTargets.length) {
              brightDataStats.batchScrapesSucceeded++;
              brightDataStats.succeeded++;
            } else if (successCount > 0) {
              brightDataStats.batchScrapesPartial++;
              brightDataStats.succeeded++;
              debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_batch_partial', urls: batchUrls, successCount, expectedCount: batchTargets.length });
            } else {
              brightDataStats.batchScrapesFailed++;
              for (const target of batchTargets) queueRetry(target, 'batch_no_successes');
            }

            debugLogs.push({
              timestamp: new Date().toISOString(),
              type: 'brightdata_batch_scrape',
              urls: batchUrls,
              resultCount: batchResults.length,
              successCount
            });
            recordTrace({
              phase: 'enrichment',
              operation: 'brightdata_batch_scrape',
              status: successCount > 0 ? 'success' : 'skipped',
              provider: 'brightdata',
              round,
              latencyMs: Date.now() - started,
              counts: { requestedUrls: batchTargets.length, returnedUrls: batchResults.length, enrichedProfiles: successCount },
              brightData: getBrightDataStatus()
            });
          } catch (error) {
            brightDataStats.batchScrapesFailed++;
            const classified = classifyAndRecordBrightDataFailure(error, 'brightdata_batch_error');
            recordTrace({
              phase: 'enrichment',
              operation: 'brightdata_batch_scrape',
              status: 'error',
              provider: 'brightdata',
              round,
              latencyMs: Date.now() - started,
              error: { message: classified.reasonCode + ': ' + classified.message },
              brightData: getBrightDataStatus()
            });
            if (classified.providerDisabled) break;
            for (const target of batchTargets) {
              if (isBrightDataRetryableError(classified)) {
                brightDataStats.negativeCacheSkippedTransient++;
                queueRetry(target, classified.reasonCode);
              } else if (classified.reasonCode === 'target_blocked') {
                upsertNegativeEnrichmentCacheEntry({
                  normalizedUrl: target.normalizedUrl,
                  linkedinUsername: target.username,
                  evidenceBlock: 'brightdata_login_wall',
                  scrapeQuality: 'bad',
                  sourceProvider: 'brightdata'
                }, 0.25);
                brightDataStats.negativeCacheWrites++;
              }
            }
          }
        }

        const retryMax = Math.min(Math.max(Number(process.env.BRIGHTDATA_PROFILE_RETRY_MAX || 2), 0), 3);
        const retryDelays = [3_000, 10_000, 20_000];
        const retryTargets = uncachedTargets.filter(target => urlRetryQueue.has(target.normalizedUrl) && !target.enriched);
        for (const target of retryTargets) {
          if (brightDataProviderDisabled) break;
          for (let attempt = 0; attempt < retryMax && !target.enriched && !brightDataProviderDisabled; attempt++) {
            if (brightDataTransportRetryAfter && Date.now() < brightDataTransportRetryAfter) {
              await new Promise(resolve => setTimeout(resolve, Math.max(0, brightDataTransportRetryAfter - Date.now())));
            }
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, retryDelays[Math.min(attempt - 1, retryDelays.length - 1)]));
            const started = Date.now();
            target.retryAttempts++;
            brightDataStats.profileRetryAttempted++;
            brightDataStats.profileScrapesAttempted++;
            try {
              const markdown = await scrapeAsMarkdown(target.url);
              debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_profile_retry', url: target.url, status: 'success', attempt: attempt + 1, response: markdown ? { length: markdown.length, preview: markdown.slice(0, 300) } : null });
              applyMarkdownToTarget(target, markdown || '', 'retry');
              recordTrace({
                phase: 'enrichment',
                operation: 'brightdata_profile_retry',
                status: target.enriched ? 'success' : 'skipped',
                provider: 'brightdata',
                round,
                latencyMs: Date.now() - started,
                counts: { attempt: attempt + 1, markdownChars: markdown?.length || 0 },
                brightData: { ...getBrightDataStatus(), target: target.url }
              });
              if (!target.enriched) break;
            } catch (error) {
              const classified = classifyAndRecordBrightDataFailure(error, 'brightdata_profile_retry', target.url);
              if (classified.retryable) brightDataStats.negativeCacheSkippedTransient++;
              recordTrace({
                phase: 'enrichment',
                operation: 'brightdata_profile_retry',
                status: 'error',
                provider: 'brightdata',
                round,
                latencyMs: Date.now() - started,
                error: { message: classified.reasonCode + ': ' + classified.message },
                brightData: { ...getBrightDataStatus(), target: target.url }
              });
              if (classified.providerDisabled || !classified.retryable) break;
            }
          }
          urlRetryQueue.delete(target.normalizedUrl);
        }

        const reservedButUnenriched = uncachedTargets.filter(target => target.reserved && !target.enriched).length;
        if (reservedButUnenriched > 0) stats.enriched = Math.max(0, stats.enriched - reservedButUnenriched);
        if (brightDataToolDegraded) logEvent('Bright Data profile enrichment had target-level failures, but provider remains available for other Bright Data work.');
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
            if ((!websiteUrl || websiteUrl.includes('linkedin.com')) && !brightDataProviderDisabled) {
              try {
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
              } catch (error) {
                const classified = classifyBrightDataError(error);
                incrementCounter(brightDataStats.failureReasons, classified.reasonCode);
                if (classified.reasonCode === 'target_transient') brightDataStats.transientFailures++;
                if (classified.reasonCode === 'transport_transient') {
                  brightDataStats.transportFailures++;
                  brightDataStats.processRestarts++;
                  brightDataTransportRetryAfter = Date.now() + 5_000;
                }
                if (classified.providerDisabled) {
                  brightDataStats.providerDisabled++;
                  brightDataProviderDisabled = true;
                }
                debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_company_search_error', companyName, reasonCode: classified.reasonCode, error: classified.message });
              }
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

    const emailDiscoveryMode = String(req.body.emailDiscovery || process.env.EMAIL_DISCOVERY_MODE || 'accepted_only').toLowerCase();
    stats.emailDiscovery.mode = emailDiscoveryMode;
    if (emailDiscoveryMode !== 'off') {
      const maxEmailDiscovery = Math.min(
        finalLeads.length,
        Math.max(Number(process.env.EMAIL_DISCOVERY_MAX_PER_SEARCH || targetLimit), 0)
      );
      const profileForEmailDiscovery = (lead: any) => lead.profile || lead;
      const leadsForEmailDiscovery = finalLeads.slice(0, maxEmailDiscovery).filter((lead: any) => {
        const profile = profileForEmailDiscovery(lead);
        if (emailDiscoveryMode === 'missing_only') return !profile.contactDetails?.email;
        return true;
      });
      stats.emailDiscovery.attempted = leadsForEmailDiscovery.length;
      if (leadsForEmailDiscovery.length > 0) {
        logEvent(`Email discovery: processing ${leadsForEmailDiscovery.length} accepted leads using free-first providers.`);
        recordTrace({
          phase: 'email_discovery',
          operation: 'email_discovery_batch',
          status: 'started',
          provider: 'email',
          counts: { leads: leadsForEmailDiscovery.length }
        });
      }

      const emailTasks = leadsForEmailDiscovery.map((lead: any) => async () => {
        try {
          const profile = profileForEmailDiscovery(lead);
          const contactDetails = profile.contactDetails || {};
          const companyWebsite = contactDetails.website || lead.companyAccount?.website;
          const hasLookupInput = Boolean(
            profile.fullName ||
            profile.currentCompany ||
            companyWebsite ||
            contactDetails.linkedinUrl
          );

          if (!hasLookupInput) {
            stats.emailDiscovery.notFound++;
            recordTrace({
              phase: 'email_discovery',
              operation: 'email_lookup',
              status: 'skipped',
              provider: 'email',
              email: { status: 'missing_lookup_input' }
            });
            debugLogs.push({
              timestamp: new Date().toISOString(),
              type: 'email_discovery_skipped',
              reason: 'missing_lookup_input'
            });
            return;
          }

          const emailStarted = Date.now();
          const result = await discoverProspectEmail({
            fullName: profile.fullName,
            currentCompany: profile.currentCompany,
            companyWebsite,
            linkedinUrl: contactDetails.linkedinUrl,
            title: profile.currentTitle,
            location: profile.location
          });
          Object.assign(lead, applyEmailDiscoveryToLead(lead, result));
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'email_discovery_result',
            lead: profile.fullName,
            company: profile.currentCompany,
            status: result.status,
            bestEmail: result.bestEmail,
            companyDomain: result.companyDomain,
            confidence: result.confidence,
            sourceTypes: result.sources.map(source => source.type)
          });
          recordTrace({
            phase: 'email_discovery',
            operation: 'email_lookup',
            status: 'success',
            provider: 'email',
            latencyMs: Date.now() - emailStarted,
            email: {
              status: result.status,
              evidenceCount: result.sources.length,
              sourceTypes: result.sources.map(source => source.type)
            },
            metadata: { lead: profile.fullName, company: profile.currentCompany }
          });
          if (result.bestEmail) stats.emailDiscovery.found++;
          if (result.status === 'confirmed_public') stats.emailDiscovery.confirmedPublic++;
          else if (result.status === 'company_public') stats.emailDiscovery.companyPublic++;
          else if (result.status === 'pattern_likely') stats.emailDiscovery.patternLikely++;
          else if (result.status === 'domain_only') stats.emailDiscovery.domainOnly++;
          else stats.emailDiscovery.notFound++;
        } catch (e: any) {
          stats.emailDiscovery.failed++;
          recordTrace({
            phase: 'email_discovery',
            operation: 'email_lookup',
            status: 'error',
            provider: 'email',
            error: { message: e.message || String(e) }
          });
          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: 'email_discovery_error',
            lead: profileForEmailDiscovery(lead).fullName,
            error: e.message || String(e)
          });
        }
      });

      await asyncQueue(emailTasks, Math.min(profileConcurrency, 3));
    }

    if (leadsFound >= targetLimit) {
      stats.stopReason = 'target_reached';
    } else if (stats.stopReason === 'not_started') {
      stats.stopReason = stats.rounds >= maxRounds ? 'max_rounds' : 'exhausted';
    }

    logEvent(`Session complete: returned ${leadsFound}/${targetLimit}. Stop reason: ${stats.stopReason}. Stats: ${JSON.stringify(stats)}`);

    const now = new Date().toISOString();
    const mappedLeads = finalLeads.map((p: any, i: number) => {
      const hasAccountContext = !!p.companyAccount;
      const backendFinalScore = Number(p.scoreBreakdown?.finalScore || p.scoreOverride || 0);
      const compositeScore = backendFinalScore > 0
        ? Math.round(backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore)
        : p.companyAccount?.operationalPainScore || Math.floor(Math.random() * 35) + 60;
      const predictiveScore = Math.min(96, Math.floor(compositeScore * (hasAccountContext ? 0.96 : 0.9)));
      return {
        id: `lead-bulk-${Date.now()}-${i}`,
        profile: p,
        stage: 'SCRAPED',
        notes: hasAccountContext
          ? `LinkedIn-indexed lead with account context. ${p.companyAccount?.painSummary || 'Review profile and advance to outreach.'}`
          : 'Discovered via Tavily LinkedIn-indexed search.',
        createdAt: now,
        tags: hasAccountContext
          ? ['LinkedIn Indexed', 'Account Context', p.industry || 'Tech']
          : ['LinkedIn Indexed', p.industry || 'Tech'],
        fitScore: p.scoreBreakdown?.fitScore,
        intentScore: p.scoreBreakdown?.intentScore,
        timingScore: p.scoreBreakdown?.timingScore,
        compositeScore,
        predictiveScore,
        companyAccount: p.companyAccount,
        decisionMakerVerification: p.decisionMakerVerification,
        sourceProvider: p.sourceProvider || 'tavily',
        evidenceReasons: p.evidenceReasons,
        evidence: p.evidence,
        scoreBreakdown: p.scoreBreakdown,
        buyingSignalsDetected: p.companyAccount?.buyingSignals?.map((signal: any) => signal.label)
      };
    });

    const persistStarted = Date.now();
    try {
      upsertLeads(mappedLeads);
      recordTrace({
        phase: 'persistence',
        operation: 'upsert_leads',
        status: 'success',
        provider: 'sqlite',
        latencyMs: Date.now() - persistStarted,
        counts: { leads: mappedLeads.length }
      });
      logEvent(`Successfully auto-persisted ${mappedLeads.length} leads on the backend.`);
    } catch (e: any) {
      console.error('Failed to auto-persist leads on backend:', e);
      recordTrace({
        phase: 'persistence',
        operation: 'upsert_leads',
        status: 'error',
        provider: 'sqlite',
        latencyMs: Date.now() - persistStarted,
        error: { message: e.message || String(e) }
      });
      logEvent(`Error auto-persisting leads on backend: ${e.message}`);
    }

    telemetry.finish('success', stats);
    const traceSummary = telemetry.getSummary();
    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'success',
      errorMessage: '',
      rawResultsCount,
      leadsFound,
      detailedLogs: detailedLogsText,
      debugLogs: JSON.stringify(debugLogs)
    });

    res.json({ leads: mappedLeads, stats, traceSummary, sandboxMode: false, sessionId });

  } catch (error: any) {
    console.error('Error in /api/find-leads:', error);
    telemetry.finish('error', { ...stats, error: error.message || 'Failed to locate leads.' });
    const traceSummary = telemetry.getSummary();

    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'error',
      errorMessage: error.message || 'Failed to locate leads.',
      rawResultsCount,
      leadsFound: 0,
      detailedLogs: detailedLogsText,
      debugLogs: JSON.stringify(debugLogs)
    });

    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to locate leads.', stats, traceSummary, sessionId });
    }
  } finally {
    activeSessions.delete(sessionId);
    activeSessionEvents.delete(sessionId);
    await closeBrightDataClient({ onlyIfIdle: true, onlyIfUnhealthy: true, reason: 'find-leads-complete' });
  }
});

router.post('/email-discovery', async (req, res): Promise<any> => {
  try {
    const profile = req.body?.profile || req.body?.lead?.profile || req.body;
    if (!profile?.fullName && !profile?.currentCompany && !profile?.contactDetails?.website) {
      return res.status(400).json({ error: 'Provide a profile, lead, company, or website for email discovery.' });
    }

    const result = await discoverProspectEmail({
      fullName: profile.fullName,
      currentCompany: profile.currentCompany,
      companyWebsite: profile.contactDetails?.website || req.body?.companyWebsite,
      linkedinUrl: profile.contactDetails?.linkedinUrl,
      title: profile.currentTitle,
      location: profile.location
    });

    res.json({ emailDiscovery: result, profile: applyEmailDiscoveryToLead(profile, result), sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/email-discovery:', error);
    res.status(500).json({ error: error.message || 'Email discovery failed.' });
  }
});

router.post('/leads/:id/find-email', async (req, res): Promise<any> => {
  try {
    const leads = readStoredLeads() as any[];
    const leadIndex = leads.findIndex((lead: any) => lead.id === req.params.id);
    const lead = req.body?.lead || leads[leadIndex];
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const profile = lead.profile || lead;
    const result = await discoverProspectEmail({
      fullName: profile.fullName,
      currentCompany: profile.currentCompany,
      companyWebsite: profile.contactDetails?.website || lead.companyAccount?.website,
      linkedinUrl: profile.contactDetails?.linkedinUrl,
      title: profile.currentTitle,
      location: profile.location
    });

    const updatedLead = applyEmailDiscoveryToLead(lead, result);
    if (leadIndex >= 0) {
      leads[leadIndex] = updatedLead;
      replaceStoredLeads(leads);
    }

    res.json({ lead: updatedLead, emailDiscovery: result, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/leads/:id/find-email:', error);
    res.status(500).json({ error: error.message || 'Email discovery failed.' });
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

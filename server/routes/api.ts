import { Router } from 'express';
import crypto from 'crypto';
import { LEAD_STAGE_SET as leadStages, REVIEW_STATUS_SET as reviewStatuses, NEXT_ACTION_SET as nextActions } from '../../src/types.js';
import { buildProfileDedupeKeys, hasDuplicateProfile, normalizeDedupeValue, getProfileDomain, getLinkedInHandle } from '../../src/utils/leadDedupe.js';

import { readStoredLeads, readLeadsSummary, readExistingIdentityKeys, readLeadsStageSummary, readStoredLeadById, hasLeadStoreBeenInitialized, replaceStoredLeads, normalizeIncomingLeads, getLeadsDb, insertSearchLog, readSearchLogs, readSearchLogById, readMiningSessionById, readMiningSessions, upsertMiningSession, LeadNotFoundError, LeadRevisionConflictError, pruneExpiredEnrichmentCache, getEnrichmentCacheEntry, upsertEnrichmentCacheEntry, getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry, upsertLeadInExistingTransaction, upsertLeadWithIdentity, deleteLead, upsertLeadsWithIdentity, transferLeadIdentities, insertLeadActivity, readLeadActivities, upsertOutreachDraft, readOutreachDrafts, deleteOutreachDraft, readSavedSearches, readSavedSearchById, upsertSavedSearch, deleteSavedSearch, markSavedSearchRun, readQueryPerformance, recordQueryPerformance, readProviderUsage, recordProviderUsage, reserveProviderUsage } from '../db.js';
import { hasOpenAIKey, hasTavilyKey, tavilySearch, tavilyExtract, openAIStructured, singleProfileSchema, APEX_SYSTEM_PROMPT, leadsArraySchema, searchQueriesSchema, searchSpecSchema, openAIText, STRATEGIST_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, bulkLeadsArraySchema, getLLMProviderSummaries, getTavilyKeyStatus, createLLMSessionCircuitBreaker, type LLMProviderAttempt, type LLMUsage } from '../services/llm.js';
import { BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, chunkBrightDataBatchItems, closeBrightDataClient, getBrightDataStatus, getBrightDataCapabilities, isBrightDataConfigured, scrapeAsMarkdown, scrapeBatchAsMarkdown, brightDataSearch, shouldAttemptBrightData, classifyBrightDataError, executeBrightDataSearchWithRetry, isBrightDataRetryableError } from '../services/brightdata.js';
import { buildTavilyEvidence, extractLinkedInUsername, normalizeLinkedInUrl, parseLinkedInEvidence } from '../services/linkedinEvidence.js';
import { computeScoreBreakdown, rankLeadForFinalSelection, type EvidenceQuality, type LeadSourceProvider } from '../leadSearch/scoring.js';
import { createLeadEvidence, inferTavilyEvidenceQuality } from '../leadSearch/evidence.js';
import { normalizeQueryPlanItems, toLinkedInSearchQuery, type ProviderRunStats, type QueryRunStats, type SearchQueryPlanItem } from '../leadSearch/strategist.js';
import { incrementRejection, mapBrightDataRejection, type RejectionReason } from '../leadSearch/rejections.js';
import { verifyDecisionMakerFromEvidence } from '../leadSearch/verification.js';
import { checkCompanyIntent, findCompanyWebsite } from '../leadSearch/companyIntent.js';
import { enrichLeadProfile } from '../leadSearch/profileEnrichment.js';
import { MiningTelemetryRecorder, estimateLLMCostUsd, getLLMRouteLabel, type MiningTraceEvent } from '../leadSearch/telemetry.js';
import { buildFallbackQueryPlan as buildScoutFallbackQueryPlan, buildFallbackSearchSpec, buildRetrievalTasks, buildSearchSpecPrompt, buildStrategistPrompt as buildScoutStrategistPrompt, normalizeSearchSpec, type DiscoveryMode, type SearchSpec } from '../leadSearch/searchSpec.js';
import { ScoutFreeTierBudget, brightDataFreeTierCapabilities, tavilyFreeTierCapabilities, isProviderCreditReservationEnabled } from '../leadSearch/freeTier.js';
import { resolveDiscoveryProviderMode, resolveBrightDataSearchMode, shouldRunTavilyForTask, shouldRunBrightDataForTask } from '../leadSearch/discoveryRouting.js';
import { fuseObservations, type ScoutObservation } from '../leadSearch/observations.js';
import { buildScoutEvidence, selectDiversifiedLeads } from '../leadSearch/scoutScoring.js';
import { chunkEvidenceBlocksByTokenBudget, estimateTokenCount, fitOutputTokenBudget } from '../leadSearch/llmBudget.js';
import { buildDeterministicProspectContract, buildProspectContractPrompt, buildRecoveryQueryPrompt, enforceContractQueries, normalizeProspectContract, prospectContractSchema, PROSPECT_CONTRACT_POLICY_VERSION, searchSpecFromProspectContract, type ProspectContract } from '../leadSearch/prospectContract.js';
import { FINALIST_JUDGE_SYSTEM_PROMPT, buildFinalistJudgePrompt, finalistCandidateFromLead, finalistJudgeSchema, partitionCandidatesByStrictEvidence, validateFinalistJudgments, type FinalistCandidate } from '../leadSearch/finalistJudge.js';
import { buildRoundDiagnostics } from '../leadSearch/roundDiagnostics.js';
import { buildCollectionCapacity } from '../leadSearch/collectionCapacity.js';
import { scheduleAdaptiveRetrievalTasks } from '../leadSearch/adaptiveScheduler.js';
import { runProviderQueue } from '../leadSearch/providerQueue.js';
import { executeTargetFulfillmentSession } from '../leadSearch/targetFulfillment.js';
import { discoveryEngine } from '../leadSearch/discoveryEngine.js';

const router = Router();

let _llmHealthCache: { result: Record<string, any>; expiresAt: number } | null = null;
const LLM_HEALTH_CACHE_MS = 60_000;

const getTraceBrightDataStatus = () => {
  const status = getBrightDataStatus();
  return { ...status, transport: status.transport || undefined };
};

const isSafeSessionId = (value: string) => /^[A-Za-z0-9_-]{8,80}$/.test(value);
const isSafeLeadId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

const isPersistableLead = (lead: unknown): lead is Record<string, any> => {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return false;
  const value = lead as Record<string, any>;
  return Boolean(
    isSafeLeadId(String(value.id || '')) &&
    value.profile && typeof value.profile === 'object' && !Array.isArray(value.profile) &&
    typeof value.profile.fullName === 'string' &&
    leadStages.has(value.stage) &&
    (value.reviewStatus === undefined || reviewStatuses.has(value.reviewStatus)) &&
    (value.nextAction === undefined || nextActions.has(value.nextAction))
  );
};

router.get('/leads', (req, res): any => {
  try {
    const { stage, reviewStatus, nextAction, search, limit, offset, summaryOnly } = req.query as Record<string, string | undefined>;
    const parsedLimit = limit !== undefined ? Math.min(Math.max(Number(limit) || 1, 1), 2000) : undefined;
    const parsedOffset = offset !== undefined ? Math.max(Number(offset) || 0, 0) : undefined;
    const isSummary = summaryOnly === 'true';

    const result = readLeadsSummary({
      stage,
      reviewStatus,
      nextAction,
      search,
      limit: parsedLimit,
      offset: parsedOffset,
      summaryOnly: isSummary
    });

    res.json({
      apiVersion: 1,
      leads: result.leads,
      total: result.total,
      initialized: hasLeadStoreBeenInitialized()
    });
  } catch (error: any) {
    console.error('Failed to read leads from SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to read leads' });
  }
});

router.put('/leads', (req, res): any => {
  if (!process.env.APEX_ALLOW_LEGACY_REPLACE) {
    return res.status(405).json({
      error: 'Bulk lead replacement is disabled. Set APEX_ALLOW_LEGACY_REPLACE=true in .env to enable it.',
      code: 'LEGACY_REPLACE_DISABLED'
    });
  }
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads || leads.length > 1_000 || !leads.every(isPersistableLead)) {
      return res.status(400).json({ error: 'Expected up to 1,000 valid lead records.' });
    }

    replaceStoredLeads(leads);
    res.json({ apiVersion: 1, success: true, count: leads.length });
  } catch (error: any) {
    console.error('Failed to persist leads to SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to persist leads' });
  }
});

router.patch('/leads/:id', (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    const lead = { ...(req.body?.lead || {}), id: req.params.id };
    if (!lead.createdAt) {
      lead.createdAt = new Date().toISOString();
    }
    if (!isPersistableLead(lead)) {
      return res.status(400).json({ error: 'Expected a valid lead object.' });
    }
    const previousLead = readStoredLeadById(req.params.id);
    const previousStage = previousLead?.stage;

    const writeResult = upsertLeadWithIdentity(lead, {
      requireExisting: req.body?.allowCreate !== true,
    });
    const storedLead = writeResult.lead;

    if (writeResult.disposition !== 'duplicate' && storedLead.stage && previousStage && previousStage !== storedLead.stage) {
      insertLeadActivity({
        leadId: storedLead.id,
        type: 'stage_change',
        fromValue: previousStage,
        toValue: storedLead.stage,
        actor: 'user',
        createdAt: new Date().toISOString()
      });
    }

    res.json({ apiVersion: 1, success: true, disposition: writeResult.disposition, lead: storedLead });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res.status(409).json({ apiVersion: 1, error: error.message, code: 'LEAD_NO_LONGER_EXISTS' });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res.status(409).json({ apiVersion: 1, error: error.message, code: 'LEAD_REVISION_CONFLICT', lead: error.currentLead });
    }
    console.error(`Failed to upsert lead ${req.params.id} to SQLite:`, error);
    res.status(500).json({ error: error.message || 'Failed to upsert lead' });
  }
});

router.delete('/leads/:id', (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    deleteLead(req.params.id);
    res.json({ apiVersion: 1, success: true });
  } catch (error: any) {
    console.error(`Failed to delete lead ${req.params.id} from SQLite:`, error);
    res.status(500).json({ error: error.message || 'Failed to delete lead' });
  }
});

router.get('/leads/:id/activities', (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
    const activities = readLeadActivities(req.params.id, limit);
    res.json({ apiVersion: 1, activities });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to read lead activities.' });
  }
});

router.post('/leads/:id/merge', (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid winner lead id.' });
    }
    const duplicateId = typeof req.body?.duplicateId === 'string' ? req.body.duplicateId.trim() : '';
    if (!duplicateId || !isSafeLeadId(duplicateId)) {
      return res.status(400).json({ error: 'duplicateId must be a valid lead id string.' });
    }
    if (req.params.id === duplicateId) {
      return res.status(400).json({ error: 'A lead cannot be merged into itself.' });
    }

    const db = getLeadsDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const winner = readStoredLeadById(req.params.id);
      const duplicate = readStoredLeadById(duplicateId);

      if (!winner) {
        db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Winner lead not found.' });
      }
      if (!duplicate) {
        db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Duplicate lead not found.' });
      }

      // Merge strategy: keep winner's fields; fill blanks from duplicate.
      const mergeField = <T>(winVal: T, dupVal: T): T =>
        (winVal === null || winVal === undefined || winVal === '') ? dupVal : winVal;

      const mergedProfile = {
        ...duplicate.profile,   // Start with duplicate as base
        ...winner.profile,      // Winner fields overwrite
        // Specifically fill in any blank profile fields from duplicate:
        headline: mergeField(winner.profile.headline, duplicate.profile.headline),
        summary: mergeField(winner.profile.summary, duplicate.profile.summary),
        location: mergeField(winner.profile.location, duplicate.profile.location),
        industry: mergeField(winner.profile.industry, duplicate.profile.industry),
        seniorityLevel: mergeField(winner.profile.seniorityLevel, duplicate.profile.seniorityLevel),
        companySizeEst: mergeField(winner.profile.companySizeEst, duplicate.profile.companySizeEst),
        contactDetails: {
          ...(duplicate.profile.contactDetails || {}),
          ...(winner.profile.contactDetails || {}),
          // If winner has no email but duplicate does, use duplicate's.
          email: mergeField(winner.profile.contactDetails?.email, duplicate.profile.contactDetails?.email),
          phone: mergeField(winner.profile.contactDetails?.phone, duplicate.profile.contactDetails?.phone),
          linkedinUrl: mergeField(winner.profile.contactDetails?.linkedinUrl, duplicate.profile.contactDetails?.linkedinUrl),
        },
        skills: Array.from(new Set([...(winner.profile.skills || []), ...(duplicate.profile.skills || [])])),
        experiences: winner.profile.experiences?.length ? winner.profile.experiences : (duplicate.profile.experiences || []),
        education: winner.profile.education?.length ? winner.profile.education : (duplicate.profile.education || []),
      };

      // Union tags, deduplicated.
      const mergedTags = Array.from(new Set([...(winner.tags || []), ...(duplicate.tags || [])]));

      const mergedLead = {
        ...winner,
        profile: mergedProfile,
        tags: mergedTags,
        notes: winner.notes || duplicate.notes || '',
        lastEnrichedAt: winner.lastEnrichedAt || duplicate.lastEnrichedAt,
        companyAccount: winner.companyAccount || duplicate.companyAccount,
        evidence: winner.evidence || duplicate.evidence,
        reviewStatus: mergeField(winner.reviewStatus, duplicate.reviewStatus) || 'UNREVIEWED',
        nextAction: mergeField(winner.nextAction, duplicate.nextAction) || 'NONE'
      };

      const mergedWrite = upsertLeadInExistingTransaction(db, mergedLead, { requireExisting: true });
      if (mergedWrite.disposition === 'duplicate' && mergedWrite.lead.id !== winner.id) {
        throw new Error('Cannot merge because the winner LinkedIn identity belongs to another prospect.');
      }
      transferLeadIdentities(db, duplicateId, winner.id);
      db.prepare('DELETE FROM leads WHERE id = ?').run(duplicateId);

      // Log the merge activity.
      insertLeadActivity({
        leadId: winner.id,
        type: 'merge',
        fromValue: duplicateId,
        toValue: winner.id,
        actor: 'user',
        createdAt: new Date().toISOString()
      });

      db.exec('COMMIT');

      const savedMerged = readStoredLeadById(winner.id);
      res.json({ apiVersion: 1, lead: savedMerged, deleted: duplicateId });
    } catch (innerError) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw innerError;
    }
  } catch (error: any) {
    console.error('Failed to merge leads:', error);
    res.status(500).json({ error: error.message || 'Lead merge failed.' });
  }
});

router.delete('/leads', (req, res): any => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 1_000 || !ids.every((id) => typeof id === 'string' && isSafeLeadId(id))) {
      return res.status(400).json({ error: 'Expected up to 1,000 valid lead ids in request body.' });
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
    res.json({ apiVersion: 1, success: true, count: ids.length });
  } catch (error: any) {
    console.error('Failed to bulk delete leads from SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk delete leads' });
  }
});

router.post('/leads/bulk', (req, res): any => {
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads || leads.length > 1_000 || !leads.every(isPersistableLead)) {
      return res.status(400).json({ error: 'Expected up to 1,000 valid lead records.' });
    }
    const writeResults = upsertLeadsWithIdentity(leads, {
      requireExisting: req.body?.requireExisting === true,
    });
    const duplicates = writeResults
      .filter((result) => result.disposition === 'duplicate')
      .map((result) => ({
        incomingId: result.incomingLeadId,
        existingLeadId: result.lead.id,
        identityKey: result.identityKey,
        lead: result.lead,
      }));
    const createdCount = writeResults.filter((result) => result.disposition === 'created').length;
    const updatedCount = writeResults.filter((result) => result.disposition === 'updated').length;
    res.json({
      apiVersion: 1,
      success: true,
      count: writeResults.length,
      leads: writeResults.map((result) => result.lead),
      createdCount,
      updatedCount,
      duplicateCount: duplicates.length,
      duplicates,
    });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res.status(409).json({ apiVersion: 1, error: error.message, code: 'LEAD_NO_LONGER_EXISTS' });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res.status(409).json({ apiVersion: 1, error: error.message, code: 'LEAD_REVISION_CONFLICT', lead: error.currentLead });
    }
    console.error('Failed to bulk upsert leads in SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk upsert leads' });
  }
});


// Active Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: hasOpenAIKey(),
    hasTavilyKey: hasTavilyKey(),
    hasOAuth: false,
    hasGoogleClient: false,
    brightData: getBrightDataStatus(),
    providerCapabilities: {
      tavily: { ...tavilyFreeTierCapabilities(), configured: hasTavilyKey() },
      brightData: getBrightDataCapabilities()
    },
  });
});

router.get('/key-rotation-status', (req, res) => {
  res.json({
    tavily: getTavilyKeyStatus(),
    brightData: getBrightDataStatus().keyPool
  });
});

router.get('/llm-health', async (req, res) => {
  const configuredProviders = getLLMProviderSummaries();
  const force = req.query.force === 'true';

  if (!force && _llmHealthCache && Date.now() < _llmHealthCache.expiresAt) {
    return res.json({ ..._llmHealthCache.result, cached: true, configuredProviders });
  }

  try {
    const response = await openAIText("Reply with exactly ok");
    const isOk = response.text.trim().toLowerCase().includes('ok');
    const result: Record<string, any> = {
      mode: 'direct-fallback',
      provider: response.provider,
      baseUrl: response.baseUrl,
      model: response.model,
      ok: isOk,
      cached: false,
      ...(isOk ? {} : { error: `Unexpected response: ${response.text}` })
    };
    _llmHealthCache = { result, expiresAt: Date.now() + LLM_HEALTH_CACHE_MS };
    res.json({ ...result, configuredProviders });
  } catch (error: any) {
    _llmHealthCache = null; // Do not cache failures
    res.json({
      mode: 'direct-fallback',
      configuredProviders,
      ok: false,
      cached: false,
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
// Search Logging & Mining Session Utilities
// -----------------------------------------------------------------------------

router.get('/search-logs', (req, res): any => {
  try {
    const sessionById = new Map(readMiningSessions(100).map((session) => [session.id, session]));
    const logs = readSearchLogs().map((log: any) => ({
      id: log.id,
      timestamp: log.timestamp,
      prompt: log.prompt,
      generatedQueries: log.generatedQueries,
      status: sessionById.get(log.id)?.status || log.status,
      errorMessage: sessionById.get(log.id)?.errorMessage || log.errorMessage,
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
    res.json({ apiVersion: 1, logs });
  } catch (error: any) {
    console.error('Failed to read search logs:', error);
    res.status(500).json({ error: 'Failed to retrieve search logs.' });
  }
});

router.get('/search-logs/:id', (req, res): any => {
  try {
    const log = readSearchLogById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Search log not found.' });
    res.json({ apiVersion: 1, log });
  } catch (error: any) {
    console.error('Failed to read search log:', error);
    res.status(500).json({ error: 'Failed to retrieve search log.' });
  }
});

router.get('/search-logs/:id/live', (req, res) => {
  const logs = discoveryEngine.getLiveLogs(req.params.id) || [];
  const traceEvents = discoveryEngine.getLiveTrace(req.params.id) || [];
  res.json({ apiVersion: 1, logs, traceEvents, session: readMiningSessionById(req.params.id) });
});

router.get('/mining-sessions/:sessionId/stream', (req, res): any => {
  const { sessionId } = req.params;
  if (!isSafeSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastLogCount = 0;
  let lastTraceCount = 0;

  const sendDelta = () => {
    const logs = discoveryEngine.getLiveLogs(sessionId) || [];
    const traceEvents = discoveryEngine.getLiveTrace(sessionId) || [];
    const session = readMiningSessionById(sessionId);

    const newLogs = logs.slice(lastLogCount);
    const newTrace = traceEvents.slice(lastTraceCount);
    lastLogCount = logs.length;
    lastTraceCount = traceEvents.length;

    if (newLogs.length > 0 || newTrace.length > 0 || (session && session.status !== 'running')) {
      res.write(`data: ${JSON.stringify({ logs: newLogs, traceEvents: newTrace, session })}\n\n`);
    }

    if (session && session.status !== 'running' && session.status !== 'cancellation_requested') {
      res.write('event: end\ndata: {}\n\n');
      clearInterval(interval);
      res.end();
    }
  };

  sendDelta();
  const interval = setInterval(sendDelta, 250);
  req.on('close', () => clearInterval(interval));
});

router.get('/mining-sessions', (req, res): any => {
  try {
    res.json({ apiVersion: 1, sessions: readMiningSessions(Number(req.query.limit || 25)) });
  } catch (error: any) {
    console.error('Failed to read mining sessions:', error);
    res.status(500).json({ error: 'Failed to retrieve mining sessions.' });
  }
});

router.get('/mining-sessions/:sessionId', (req, res): any => {
  if (!isSafeSessionId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid sessionId.' });
  const session = readMiningSessionById(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Mining session not found.' });
  res.json({ apiVersion: 1, session });
});

router.post('/mining-sessions/:sessionId/cancel', (req, res): any => {
  const { sessionId } = req.params;
  if (!isSafeSessionId(sessionId)) return res.status(400).json({ error: 'Invalid sessionId.' });
  if (!discoveryEngine.isActive(sessionId)) return res.status(404).json({ error: 'Mining session is not active.', sessionId });

  discoveryEngine.cancel(sessionId);
  const cancellationRequestedAt = new Date().toISOString();
  discoveryEngine.addLog(sessionId, `[${cancellationRequestedAt}] Cancellation requested by local user.`);
  const session = upsertMiningSession({ id: sessionId, status: 'cancellation_requested', cancellationRequestedAt });
  res.status(202).json({ apiVersion: 1, success: true, sessionId, status: 'cancellation_requested', session });
});

router.get('/provider-capabilities', (req, res): any => {
  try {
    const discoveryProviderMode = resolveDiscoveryProviderMode({
      brightDataConfigured: isBrightDataConfigured(),
      tavilyConfigured: hasTavilyKey()
    });
    const brightDataSearchMode = resolveBrightDataSearchMode({ discoveryMode: discoveryProviderMode });
    res.json({
      apiVersion: 1,
      discoveryProviderMode,
      brightDataSearchMode,
      creditReservation: isProviderCreditReservationEnabled() ? 'enabled' : 'disabled',
      keyRotation: 'preferred',
      tavily: {
        ...tavilyFreeTierCapabilities(),
        configured: hasTavilyKey(),
        usage: readProviderUsage('tavily'),
        keyPool: getTavilyKeyStatus()
      },
      brightData: {
        ...getBrightDataCapabilities(),
        usage: readProviderUsage('brightdata'),
        status: getBrightDataStatus(),
        batchTool: getBrightDataStatus().batchTool
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Could not read provider capabilities.' });
  }
});

router.get('/saved-searches', (req, res): any => {
  try {
    res.json({ apiVersion: 1, searches: readSavedSearches(Number(req.query.limit || 50)) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Could not read saved searches.' });
  }
});

router.post('/saved-searches', (req, res): any => {
  try {
    const query = String(req.body?.query || '').trim();
    const spec = normalizeSearchSpec(req.body?.spec, query);
    const record = upsertSavedSearch({
      id: typeof req.body?.id === 'string' ? req.body.id : undefined,
      name: String(req.body?.name || '').trim(),
      query,
      spec,
      mode: spec.mode,
      maxPerCompany: spec.maxPerCompany
    });
    res.status(201).json({ apiVersion: 1, search: record });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Could not save search.' });
  }
});

router.delete('/saved-searches/:id', (req, res): any => {
  try {
    res.json({ apiVersion: 1, deleted: deleteSavedSearch(req.params.id) > 0 });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Could not delete saved search.' });
  }
});

router.post('/lead-search/preview', async (req, res): Promise<any> => {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Search criteria/query is required.' });
  const requestedMode = req.body?.discoveryMode as DiscoveryMode | undefined;
  let spec = normalizeSearchSpec(req.body?.searchSpec, query);
  if (!req.body?.searchSpec) {
    spec = buildFallbackSearchSpec(query, requestedMode);
    if (hasOpenAIKey()) {
      try {
        spec = normalizeSearchSpec(await openAIStructured(
          buildSearchSpecPrompt(query),
          searchSpecSchema,
          STRATEGIST_SYSTEM_PROMPT,
          { maxTokens: 700, temperature: 0 }
        ), query);
      } catch {
        // A deterministic preview still lets the user edit and run a search when LLM planning is unavailable.
      }
    }
  }
  const tasks = buildRetrievalTasks(buildScoutFallbackQueryPlan(query, spec), spec);
  res.json({
    apiVersion: 1,
    spec,
    tasks,
    capabilities: {
      tavily: { ...tavilyFreeTierCapabilities(), configured: hasTavilyKey() },
      brightData: getBrightDataCapabilities()
    }
  });
});

router.get('/mining-sessions/:sessionId/trace', (req, res): any => {
  try {
    const log = readSearchLogById(req.params.sessionId);
    const session = readMiningSessionById(req.params.sessionId);
    if (!log && !session) return res.status(404).json({ error: 'Mining session trace not found.' });
    res.json({
      apiVersion: 1,
      session,
      sessionId: log?.id || session?.id,
      timestamp: log?.timestamp || session?.startedAt,
      prompt: log?.prompt || session?.prompt,
      status: session?.status || log?.status,
      errorMessage: session?.errorMessage || log?.errorMessage,
      rawResultsCount: log?.rawResultsCount || 0,
      leadsFound: log?.leadsFound || 0,
      detailedLogs: log?.detailedLogs || '',
      debugLogs: log?.debugLogs || '',
      traceEvents: log?.traceEvents || [],
      providerSummary: log?.providerSummary || {},
      costSummary: log?.costSummary || {},
      phaseTimeline: log?.phaseTimeline || [],
      schemaVersion: log?.schemaVersion || 1
    });
  } catch (error: any) {
    console.error('Failed to read mining session trace:', error);
    res.status(500).json({ error: 'Failed to retrieve mining session trace.' });
  }
});
// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
router.post('/find-leads', async (req, res): Promise<any> => {
  const suppliedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (suppliedSessionId && !isSafeSessionId(suppliedSessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  try {
    const result = await discoveryEngine.execute({
      sessionId: suppliedSessionId || undefined,
      promptQuery: req.body?.query,
      requestedLimit: req.body?.limit,
      discoveryProviderMode: req.body?.discoveryMode || req.body?.discoveryProviderMode,
      searchSpec: req.body?.searchSpec,
      excludeList: req.body?.excludeList
    });
    return res.status(200).json(result);
  } catch (error: any) {
    const cancelled = error.name === 'AbortError' || String(error.message || '').includes('cancelled');
    if (error.message?.includes('already active')) {
      return res.status(409).json({ error: error.message, sessionId: suppliedSessionId });
    }
    if (error.message?.includes('must be a non-empty string')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(cancelled ? 499 : 500).json({ error: error.message || 'Failed to locate leads.', cancelled });
  } finally {
    await closeBrightDataClient({ onlyIfIdle: true, onlyIfUnhealthy: true, reason: 'find-leads-complete' });
  }
});

router.post('/leads/:id/enrich-profile', async (req, res): Promise<any> => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lead id.' });
    }
    const lead = readStoredLeadById(req.params.id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const enrichRes = await enrichLeadProfile(lead, {
      force: req.body?.forceRefresh === true
    });
    const currentLead = enrichRes.lead;
    const profileEnrichment = enrichRes.result;

    const latestLead = readStoredLeadById(req.params.id);
    if (!latestLead) throw new LeadNotFoundError(req.params.id);
    let storedLead = latestLead;
    if (profileEnrichment.status !== 'error' && profileEnrichment.updatedFields.length > 0) {
      const latestProfile = latestLead.profile || {};
      const enrichedProfile = currentLead.profile || {};
      const mergedLead = {
        ...latestLead,
        profile: {
          ...latestProfile,
          fullName: (!latestProfile.fullName || latestProfile.fullName === 'Unknown')
            ? enrichedProfile.fullName || latestProfile.fullName
            : latestProfile.fullName,
          currentCompany: (!latestProfile.currentCompany || latestProfile.currentCompany === 'Unknown')
            ? enrichedProfile.currentCompany || latestProfile.currentCompany
            : latestProfile.currentCompany,
          headline: latestProfile.headline || enrichedProfile.headline,
          location: latestProfile.location || enrichedProfile.location,
          industry: latestProfile.industry || enrichedProfile.industry,
          contactDetails: {
            ...(enrichedProfile.contactDetails || {}),
            ...(latestProfile.contactDetails || {}),
            email: latestProfile.contactDetails?.email || enrichedProfile.contactDetails?.email,
          },
        },
        decisionMakerVerification: currentLead.decisionMakerVerification,
        evidence: currentLead.evidence,
        scoreBreakdown: currentLead.scoreBreakdown,
        scoreOverride: currentLead.scoreOverride,
        lastEnrichedAt: currentLead.lastEnrichedAt,
      };
      storedLead = upsertLeadWithIdentity(mergedLead, { requireExisting: true }).lead;
    }

    if (profileEnrichment.status === 'error') {
      return res.status(502).json({
        error: profileEnrichment.error || 'Profile enrichment provider failed.',
        lead: latestLead,
        profileEnrichment,
        sandboxMode: false
      });
    }

    res.json({
      lead: storedLead,
      profileEnrichment,
      sandboxMode: false
    });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res.status(409).json({ error: error.message, code: 'LEAD_NO_LONGER_EXISTS' });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res.status(409).json({ error: error.message, code: 'LEAD_REVISION_CONFLICT', lead: error.currentLead });
    }
    console.error('Error in /api/leads/:id/enrich-profile:', error);
    res.status(500).json({ error: error.message || 'Profile enrichment failed.' });
  }
});
// -- Outreach Draft Endpoints -------------------------------------------------

router.get('/outreach-drafts', (req, res): any => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    res.json({ apiVersion: 1, drafts: readOutreachDrafts(limit) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to read outreach drafts.' });
  }
});

router.post('/outreach-drafts', (req, res): any => {
  try {
    const { id, leadId, leadName, companyName, tone, medium, sequenceStep, wordCount, body } = req.body || {};
    if (
      typeof id !== 'string' || !id.trim() ||
      typeof leadId !== 'string' || !leadId.trim() ||
      typeof leadName !== 'string' || !leadName.trim() ||
      typeof body !== 'string' || !body.trim()
    ) {
      return res.status(400).json({ error: 'id, leadId, leadName, and body are required strings.' });
    }
    if (!isSafeLeadId(id) || !isSafeLeadId(leadId)) {
      return res.status(400).json({ error: 'Invalid id or leadId format.' });
    }
    const draft = upsertOutreachDraft({
      id: id.trim(),
      leadId: leadId.trim(),
      leadName: String(leadName).trim(),
      companyName: typeof companyName === 'string' ? companyName.trim() : undefined,
      tone: String(tone || 'neutral').trim(),
      medium: String(medium || 'email').trim(),
      sequenceStep: String(sequenceStep || 'Step 1').trim(),
      wordCount: Number(wordCount || 0),
      body: String(body).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    res.json({ apiVersion: 1, draft });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to save outreach draft.' });
  }
});

router.delete('/outreach-drafts/:id', (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid draft id.' });
    }
    deleteOutreachDraft(req.params.id);
    res.json({ apiVersion: 1, success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete outreach draft.' });
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
      return res.status(503).json({ error: 'No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file to enable AI outreach generation.' });
    }

    console.log(`[generate-outbound] Generating outreach for: ${profile.fullName}`);
    const buyingSignalText = Array.isArray(buyingSignals)
      ? buyingSignals
        .map((signal) => typeof signal === 'string'
          ? signal
          : [signal?.label, signal?.evidence].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('; ')
      : typeof buyingSignals === 'string'
        ? buyingSignals
        : '';

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
- Buying Signals: ${buyingSignalText || 'None provided'}

## Campaign Settings
- Tone: ${tone || 'Professional'}
- Pitch Type: ${pitchType || 'Cold outreach'}
- Value Proposition: ${valueProposition || 'Not specified'}
- Sender: ${senderName || 'Sales Rep'} from ${senderCompany || 'Our Company'}
- Sequence Step: ${sequenceStep || 'Step 1 - First Touch'}
- Custom Instruction: ${customInstruction || 'None'}
- Channel: ${companyAccount ? 'Company LinkedIn Account' : 'Personal LinkedIn / Email'}

## Output Requirements
Return plain text only. Do not use HTML, markdown, or unsupported performance claims.
Follow the Golden Rules strictly:
1. Never start with "I"
2. Be specific - reference something real from their profile
3. One CTA only
4. LinkedIn connection note: max 300 characters
5. Cold email: max 150 words
6. No spam words: guaranteed, synergy, leverage, disruptive, game-changing, revolutionary

Use normal paragraph breaks so the result can be pasted into email, LinkedIn, or a mailto link.`;

    const { text: rawText } = await openAIText(prompt, APEX_SYSTEM_PROMPT);

    if (!rawText) {
      throw new Error('Failed to generate outreach copy.');
    }

    const text = rawText
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .trim();

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
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'Query is required' });
    if (query.length > 2_000) return res.status(400).json({ error: 'Query must be 2,000 characters or fewer.' });

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file to enable the AI Copilot.' });
    }

    // The database is canonical. Do not accept a browser-provided lead dump,
    // and omit contact details/notes from the model context by default.
    const { count: totalLeads, stageCounts } = readLeadsStageSummary();
    const stageSummary = Object.entries(stageCounts)
      .map(([stage, count]) => `- ${stage}: ${count}`)
      .join('\n');

    const topLeads = readLeadsSummary({ limit: 50 }).leads;
    const leadsContext = topLeads.length === 0
      ? 'The CRM pipeline is currently empty.'
      : topLeads
        .slice()
        .sort((a, b) => Number(b.compositeScore ?? b.score ?? 0) - Number(a.compositeScore ?? a.score ?? 0))
        .map((l: any, i: number) =>
          `${i + 1}. ${l.profile?.fullName || l.fullName || 'Unknown'} - ${l.profile?.currentTitle || l.title || 'Unknown'} at ${l.profile?.currentCompany || l.company || 'Unknown'} | Stage: ${l.stage || 'Unknown'} | Fit: ${l.fitScore ?? '?'}/10 | Intent: ${l.intentScore ?? '?'}/10`
        ).join('\n');

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
Total Leads: ${totalLeads}

### Pipeline Stage Breakdown:
${stageSummary}

### Active Leads List (Showing top 50 by qualification):
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

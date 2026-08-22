import {
  upsertLeadsWithIdentity,
  upsertMiningSession,
  readSavedSearchById,
  markSavedSearchRun
} from '../../db.js';
import type { SessionContext } from '../pipelineTypes.js';

export function mapCandidateToPersistedLead(p: any, fallbackId?: string, now = new Date().toISOString()): Record<string, any> {
  const leadId = p.id || fallbackId || `lead-${crypto.randomUUID()}`;
  p.id = leadId;
  const hasAccountContext = !p.companyAccount;
  const rawBackendScore = Number(p.finalSelectionScore || p.scoreBreakdown?.finalScore || p.scoreOverride || 0);
  const backendFinalScore = rawBackendScore <= 1.0 && rawBackendScore > 0 ? rawBackendScore * 10 : rawBackendScore;
  const compositeScore = backendFinalScore > 0
    ? Math.round(backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore)
    : Math.round(Math.min(Math.max(Number(p.companyAccount?.operationalPainScore || 0), 0), 10) * 10);
  const predictiveScore = compositeScore > 0
    ? Math.min(96, Math.floor(compositeScore * (hasAccountContext ? 0.96 : 0.9)))
    : 0;
  return {
    id: leadId,
    profile: p,
    stage: 'SCRAPED',
    notes: hasAccountContext
      ? `LinkedIn-indexed lead with account context. ${p.companyAccount?.painSummary || 'Review profile and advance to outreach.'}`
      : 'Discovered via Tavily LinkedIn-indexed search.',
    createdAt: p.createdAt || now,
    tags: Array.from(new Set([
      'LinkedIn Indexed',
      ...(hasAccountContext ? ['Account Context'] : []),
      p.industry || 'Tech',
      ...(Array.isArray(p.tags) ? p.tags : []),
      ...(p.postIntentEvidence?.quality && p.postIntentEvidence.quality !== 'none' ? [`LinkedIn Post: ${String(p.postIntentEvidence.intentCategory || '').replace(/_/g, ' ')}`] : []),
      ...(p.corroborated || p.companyIntentEvidence?.evidenceQuality === 'good' || p.companyIntentEvidence?.evidenceQuality === 'partial' ? ['Intent Corroborated'] : []),
      ...(p.qualification?.verdict === 'qualified_partial' ? ['Signal Unverified'] : []),
      ...(p.evidence?.corroborated || (p.scout?.sourceCount && p.scout.sourceCount > 1) ? ['Corroborated'] : [])
    ].filter(Boolean))),
    fitScore: p.scoreBreakdown?.fitScore,
    intentScore: p.scoreBreakdown?.intentScore,
    timingScore: p.scoreBreakdown?.timingScore,
    compositeScore,
    predictiveScore,
    companyAccount: p.companyAccount,
    decisionMakerVerification: p.decisionMakerVerification,
    scout: p.scout,
    finalSelectionScore: p.finalSelectionScore,
    discoveryLane: p.discoveryLane,
    sourceProvider: p.sourceProvider || 'tavily',
    evidenceReasons: p.evidenceReasons,
    evidence: p.evidence,
    scoreBreakdown: p.scoreBreakdown,
    postIntentEvidence: p.postIntentEvidence,
    intentEnrichmentState: p.intentEnrichmentState,
    paretoSkyline: p.paretoSkyline,
    confidenceInterval: p.scoreBreakdown?.confidenceInterval || p.confidenceInterval,
    reviewStatus: 'UNREVIEWED',
    nextAction: 'NONE',
    buyingSignalsDetected: Array.from(new Set([
      ...(p.companyAccount?.buyingSignals?.map((signal: any) => signal.label) || []),
      ...(p.postIntentEvidence?.buyingSignals || [])
    ].filter(Boolean)))
  };
}

export type PersistStageInput = {
  finalLeads: any[];
  leadsFound: number;
  rawResultsCount: number;
  generatedQueries: string[];
  stats: any;
  savedSearchId?: string;
  persistedLeadIds: Set<string>;
  sessionLogs: string[];
  safeInsertSearchLog: (log: any) => void;
};

export type PersistStageOutput = {
  result: any;
  persistedCount: number;
  persistenceStatus: 'complete' | 'partial' | 'failed';
  mappedLeads: Record<string, any>[];
};

export async function executePersistStage(
  ctx: SessionContext,
  input: PersistStageInput
): Promise<PersistStageOutput> {
  const {
    finalLeads,
    leadsFound,
    rawResultsCount,
    generatedQueries,
    stats,
    savedSearchId,
    persistedLeadIds,
    sessionLogs,
    safeInsertSearchLog
  } = input;

  const { config, state, logEvent, recordTrace } = ctx;
  const { telemetry, debugLogs } = state;
  const { sessionId, promptQuery, targetLimit } = config;

  const now = new Date().toISOString();
  const mappedLeads: Record<string, any>[] = finalLeads.map((p: any) =>
    mapCandidateToPersistedLead(p, p.id || `lead-${crypto.randomUUID()}`, now)
  );

  let persistence = { createdCount: 0, updatedCount: 0, duplicateCount: 0 };
  let persistedCount = persistedLeadIds.size;
  const persistStarted = Date.now();

  try {
    const writeResults = upsertLeadsWithIdentity(mappedLeads);
    const persistedLeads = writeResults.map((result) => result.lead);
    for (let i = 0; i < finalLeads.length; i++) {
      const res = writeResults[i];
      if (res?.lead?.id) {
        finalLeads[i].id = res.lead.id;
        persistedLeadIds.add(res.lead.id);
      }
    }
    persistedCount = persistedLeadIds.size;
    persistence = {
      createdCount: writeResults.filter((result) => result.disposition === 'created').length,
      updatedCount: writeResults.filter((result) => result.disposition === 'updated').length,
      duplicateCount: writeResults.filter((result) => result.disposition === 'duplicate').length,
    };
    recordTrace({
      phase: 'persistence',
      operation: 'upsert_leads',
      status: 'success',
      provider: 'sqlite',
      latencyMs: Date.now() - persistStarted,
      counts: { leads: mappedLeads.length, ...persistence }
    });
    logEvent(`Successfully auto-persisted ${persistence.createdCount} new leads; ${persistence.duplicateCount} LinkedIn duplicates returned existing prospects.`);
    mappedLeads.splice(0, mappedLeads.length, ...persistedLeads);
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
    if (persistedCount === 0) {
      throw new Error(`Failed to persist discovered leads: ${e.message || String(e)}`);
    }
  }

  const persistenceStatus: 'complete' | 'partial' | 'failed' =
    persistence.createdCount + persistence.updatedCount + persistence.duplicateCount >= mappedLeads.length
      ? 'complete'
      : (persistedCount > 0 ? 'partial' : 'failed');

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

  upsertMiningSession({
    id: sessionId,
    status: 'success',
    completedAt: new Date().toISOString(),
    stats: { ...stats, persistedCount, persistenceStatus },
    traceSummary
  });

  if (typeof savedSearchId === 'string' && readSavedSearchById(savedSearchId)) {
    markSavedSearchRun(savedSearchId);
  }

  const result = {
    apiVersion: 1,
    leads: mappedLeads,
    persistence,
    persistenceStatus,
    stats,
    traceSummary,
    sandboxMode: false,
    sessionId,
    total: mappedLeads.length,
    requestedLimit: targetLimit,
    shortfall: Math.max(0, targetLimit - mappedLeads.length),
    shortfallReason: mappedLeads.length < targetLimit ? `Found ${mappedLeads.length}/${targetLimit} verified matches after exhausting search queries.` : undefined,
    stopReason: stats.stopReason,
    cancelled: false
  };

  return {
    result,
    persistedCount,
    persistenceStatus,
    mappedLeads
  };
}

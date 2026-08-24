import {
  upsertLeadsWithIdentity,
  upsertMiningSession,
  readSavedSearchById,
  markSavedSearchRun,
  updateSavedSearchExcludeList,
} from "../../db.js";
import { extractLinkedInUsername } from "../../services/linkedinEvidence.js";
import { mapCandidateToPersistedLead } from "../leadMapping.js";
import type { SessionContext } from "../pipelineTypes.js";

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
  persistenceStatus: "complete" | "partial" | "failed";
  mappedLeads: Record<string, any>[];
};

export async function executePersistStage(
  ctx: SessionContext,
  input: PersistStageInput,
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
    safeInsertSearchLog,
  } = input;

  const { config, state, logEvent, recordTrace } = ctx;
  const { telemetry, debugLogs } = state;
  const { sessionId, promptQuery, targetLimit } = config;

  const now = new Date().toISOString();
  const mappedLeads: Record<string, any>[] = finalLeads.map((p: any) =>
    mapCandidateToPersistedLead(p, p.id || `lead-${crypto.randomUUID()}`, now),
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
      createdCount: writeResults.filter(
        (result) => result.disposition === "created",
      ).length,
      updatedCount: writeResults.filter(
        (result) => result.disposition === "updated",
      ).length,
      duplicateCount: writeResults.filter(
        (result) => result.disposition === "duplicate",
      ).length,
    };
    recordTrace({
      phase: "persistence",
      operation: "upsert_leads",
      status: "success",
      provider: "sqlite",
      latencyMs: Date.now() - persistStarted,
      counts: { leads: mappedLeads.length, ...persistence },
    });
    logEvent(
      `Successfully auto-persisted ${persistence.createdCount} new leads; ${persistence.duplicateCount} LinkedIn duplicates returned existing prospects.`,
    );
    mappedLeads.splice(0, mappedLeads.length, ...persistedLeads);
  } catch (e: any) {
    console.error("Failed to auto-persist leads on backend:", e);
    recordTrace({
      phase: "persistence",
      operation: "upsert_leads",
      status: "error",
      provider: "sqlite",
      latencyMs: Date.now() - persistStarted,
      error: { message: e.message || String(e) },
    });
    logEvent(`Error auto-persisting leads on backend: ${e.message}`);
    if (persistedCount === 0) {
      throw new Error(
        `Failed to persist discovered leads: ${e.message || String(e)}`,
      );
    }
  }

  const persistenceStatus: "complete" | "partial" | "failed" =
    persistence.createdCount +
      persistence.updatedCount +
      persistence.duplicateCount >=
    mappedLeads.length
      ? "complete"
      : persistedCount > 0
        ? "partial"
        : "failed";

  telemetry.finish("success", stats);
  const traceSummary = telemetry.getSummary();
  const detailedLogsText = `${sessionLogs.join("\n")}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
  safeInsertSearchLog({
    id: sessionId,
    timestamp: new Date().toISOString(),
    prompt: promptQuery,
    generatedQueries,
    status: "success",
    errorMessage: "",
    rawResultsCount,
    leadsFound,
    detailedLogs: detailedLogsText,
    debugLogs: JSON.stringify(debugLogs),
  });

  upsertMiningSession({
    id: sessionId,
    status: "success",
    completedAt: new Date().toISOString(),
    stats: { ...stats, persistedCount, persistenceStatus },
    traceSummary,
  });

  if (typeof savedSearchId === "string" && readSavedSearchById(savedSearchId)) {
    markSavedSearchRun(savedSearchId);
    const returnedIdentities = mappedLeads.flatMap((lead) => {
      const url =
        lead?.profile?.contactDetails?.linkedinUrl || lead?.sourceUrl || "";
      const username = extractLinkedInUsername(url);
      return username ? [`linkedin:${username}`] : [];
    });
    if (returnedIdentities.length > 0) {
      updateSavedSearchExcludeList(savedSearchId, returnedIdentities);
    }
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
    shortfallReason:
      mappedLeads.length < targetLimit
        ? `Found ${mappedLeads.length}/${targetLimit} verified matches after exhausting search queries.`
        : undefined,
    stopReason: stats.stopReason,
    cancelled: false,
  };

  return {
    result,
    persistedCount,
    persistenceStatus,
    mappedLeads,
  };
}

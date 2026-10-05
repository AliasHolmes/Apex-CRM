import crypto from "crypto";
import { getLeadScore } from "./scoring.js";
import { buildScopeKey } from "./adaptiveScheduler.js";
import { resolveTitleFromQualification } from "./titleResolution.js";

/**
 * Records which brief produced each lead. Without this every lead was persisted with
 * domainCluster "global", so per-cluster outcome attribution never happened.
 */
export function stampDiscoveryContext(
  leads: any[],
  context: { requirementsFingerprint: string; domainCluster: string },
): void {
  for (const lead of leads) {
    if (!lead || typeof lead !== "object") continue;
    if (!lead.discoveryRequirementsFingerprint) {
      lead.discoveryRequirementsFingerprint = context.requirementsFingerprint;
    }
    if (!lead.domainCluster || lead.domainCluster === "global") {
      lead.domainCluster = context.domainCluster;
    }
  }
}

/**
 * Canonical candidate-to-persisted-lead mapping.
 *
 * Single source of truth used by:
 *  - mid-session checkpoint persistence (discoveryEngine)
 *  - final persist stage (stages/persistStage)
 *
 * Note: assigns an id onto the candidate when missing so callers can track
 * which physical lead row a candidate maps to across checkpoint boundaries.
 */
export function mapCandidateToPersistedLead(
  p: any,
  fallbackId?: string,
  now = new Date().toISOString(),
): Record<string, any> {
  const leadId = p.id || fallbackId || `lead-${crypto.randomUUID()}`;
  p.id = leadId;

  const rawTitle = String(p.currentTitle || p.title || '').trim();
  const fullName = String(p.fullName || '').trim().toLowerCase();
  if (!rawTitle || rawTitle.toLowerCase() === fullName) {
    const titleRes = resolveTitleFromQualification({
      lead: p,
      qualification: p.qualification,
      contract: null,
      evidence: null,
    });
    if (titleRes?.title) {
      p.currentTitle = titleRes.title;
      p.titleSource = titleRes.source;
    }
  }

  const hasAccountContext = !!p.companyAccount;
  const backendFinalScore = getLeadScore(p, 0);
  const compositeScore =
    backendFinalScore > 0
      ? Math.round(
          backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore,
        )
      : Math.round(
          Math.min(
            Math.max(Number(p.companyAccount?.operationalPainScore || 0), 0),
            10,
          ) * 10,
        );
  const predictiveScore =
    compositeScore > 0
      ? Math.min(
          96,
          Math.floor(compositeScore * (hasAccountContext ? 0.96 : 0.9)),
        )
      : 0;
  return {
    id: leadId,
    profile: p,
    stage: "SCRAPED",
    notes: hasAccountContext
      ? `LinkedIn-indexed lead with account context. ${p.companyAccount?.painSummary || "Review profile and advance to outreach."}`
      : "Discovered via Tavily LinkedIn-indexed search.",
    createdAt: p.createdAt || now,
    tags: Array.from(
      new Set(
        [
          "LinkedIn Indexed",
          ...(hasAccountContext ? ["Account Context"] : []),
          p.industry || "Tech",
          ...(Array.isArray(p.tags) ? p.tags : []),
          ...(p.postIntentEvidence?.quality &&
          p.postIntentEvidence.quality !== "none"
            ? [
                `LinkedIn Post: ${String(p.postIntentEvidence.intentCategory || "").replace(/_/g, " ")}`,
              ]
            : []),
          ...(p.corroborated ||
          p.companyIntentEvidence?.evidenceQuality === "good" ||
          p.companyIntentEvidence?.evidenceQuality === "partial"
            ? ["Intent Corroborated"]
            : []),
          ...(p.qualification?.verdict === "qualified_partial"
            ? ["Signal Unverified"]
            : []),
          ...(p.evidence?.corroborated ||
          (p.scout?.sourceCount && p.scout.sourceCount > 1)
            ? ["Corroborated"]
            : []),
        ].filter(Boolean),
      ),
    ),
    fitScore: p.scoreBreakdown?.fitScore,
    intentScore: p.scoreBreakdown?.intentScore,
    timingScore: p.scoreBreakdown?.timingScore,
    compositeScore,
    predictiveScore,
    companyAccount: p.companyAccount,
    decisionMakerVerification: p.decisionMakerVerification,
    scout: p.scout,
    finalSelectionScore: p.finalSelectionScore,
    // G5: persist the producing arm at the top level so CRM feedback
    // (api.ts PATCH) can attribute outcomes to the scheduler scope key.
    discoveryFamily: p.discoveryFamily || p.scout?.family || p.evidence?.discoveryFamily || "general",
    discoveryLane: p.discoveryLane || p.scout?.lane || p.evidence?.discoveryLane || "person",
    sourceProvider: p.sourceProvider || "tavily",
    domainCluster: p.domainCluster || p.evidence?.domainCluster || "global",
    discoveryScopeKey: p.discoveryScopeKey || buildScopeKey({
      domainCluster: p.domainCluster || p.evidence?.domainCluster,
      family: p.discoveryFamily || p.scout?.family || p.evidence?.discoveryFamily || "general",
      lane: p.discoveryLane || p.scout?.lane || p.evidence?.discoveryLane || "person",
      provider: p.sourceProvider || "tavily",
    }),
    discoveryRequirementsFingerprint: p.discoveryRequirementsFingerprint || undefined,
    evidenceReasons: p.evidenceReasons,
    evidence: p.evidence,
    scoreBreakdown: p.scoreBreakdown,
    postIntentEvidence: p.postIntentEvidence,
    intentEnrichmentState: p.intentEnrichmentState,
    paretoSkyline: p.paretoSkyline,
    confidenceInterval:
      p.scoreBreakdown?.confidenceInterval || p.confidenceInterval,
    reviewStatus: "UNREVIEWED",
    nextAction: "NONE",
    buyingSignalsDetected: Array.from(
      new Set(
        [
          ...(Array.isArray(p.buyingSignalsDetected) ? p.buyingSignalsDetected : []),
          ...(p.companyAccount?.buyingSignals?.map(
            (signal: any) => signal.label,
          ) || []),
          ...(p.companyIntentEvidence?.buyingSignals || []),
          ...(p.postIntentEvidence?.intentKeywords || []),
          ...(p.postIntentEvidence?.quality &&
          p.postIntentEvidence.quality !== "none" &&
          p.postIntentEvidence.llmReason
            ? [p.postIntentEvidence.llmReason]
            : []),
        ].filter(Boolean),
      ),
    ),
  };
}

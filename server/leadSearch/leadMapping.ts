import crypto from "crypto";

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
  const hasAccountContext = !!p.companyAccount;
  const rawBackendScore = Number(
    p.finalSelectionScore ||
      p.scoreBreakdown?.finalScore ||
      p.scoreOverride ||
      0,
  );
  const backendFinalScore =
    rawBackendScore <= 1.0 && rawBackendScore > 0
      ? rawBackendScore * 10
      : rawBackendScore;
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
    discoveryLane: p.discoveryLane,
    sourceProvider: p.sourceProvider || "tavily",
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

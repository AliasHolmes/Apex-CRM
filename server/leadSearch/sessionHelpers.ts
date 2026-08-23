import { normalizeLinkedInUrl } from "../services/linkedinEvidence.js";
import type { EvidenceQuality, LeadSourceProvider } from "./scoring.js";

/**
 * Shared per-session helpers used across the discovery engine and stage
 * modules. Extracted from copy-pasted local closures so behavioral drift
 * between stages cannot recur.
 */

export type SessionEvidenceMeta = {
  evidenceBlock: string;
  evidenceQuality: EvidenceQuality;
  sourceProvider: LeadSourceProvider;
  sourceUrl: string;
  sourceQuery: string;
  sourceRound: number;
  sourceProviders?: string[];
  sourceCount?: number;
  lanes?: string[];
  corroborated?: boolean;
};

const normalizeDedupeValue = (value?: string) =>
  (value || "").trim().toLowerCase();

/** Resolve a lead's effective score from its breakdown with legacy fallbacks. */
export function effectiveScore(lead: any): number {
  const score = Number(lead?.scoreBreakdown?.finalScore || 0);
  if (score > 0) return score;
  const fit = Number(lead?.fitScore || 0);
  const composite = Number(lead?.compositeScore || 0);
  const predictive = Number(lead?.predictiveScore || 0);
  if (fit > 0) return fit;
  if (composite > 10) return composite / 10;
  if (composite > 0) return composite;
  if (predictive > 10) return predictive / 10;
  return predictive;
}

/** Build weak fallback evidence when no retrieval evidence was recorded. */
export function buildFallbackEvidence(
  lead: any,
  promptQuery: string,
  round: number,
): SessionEvidenceMeta {
  const sourceUrl = lead?.contactDetails?.linkedinUrl || "";
  const evidenceBlock = [
    sourceUrl ? `LINK: ${sourceUrl}` : "",
    lead?.headline ? `HEADLINE: ${lead.headline}` : "",
    lead?.summary ? `SUMMARY: ${lead.summary}` : "",
    Array.isArray(lead?.evidenceReasons) ? lead.evidenceReasons.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    evidenceBlock,
    evidenceQuality: "weak",
    sourceProvider:
      lead?.sourceProvider === "brightdata_search" ||
      lead?.sourceProvider === "brightdata"
        ? "brightdata"
        : "tavily",
    sourceUrl,
    sourceQuery: promptQuery,
    sourceRound: round || 1,
    sourceProviders: [lead?.sourceProvider || "tavily"],
    sourceCount: 1,
    lanes: [lead?.discoveryLane || "person"],
    corroborated: false,
  };
}

/** Look up recorded evidence for a lead across all known URL key forms. */
export function findEvidenceForLead<E extends SessionEvidenceMeta>(
  lead: any,
  evidenceByUrl: Map<string, E>,
): E | undefined {
  const linkedinUrl = lead?.contactDetails?.linkedinUrl || "";
  const fallbackUrl = lead?.sourceUrl || "";
  const candidateKeys = [
    normalizeLinkedInUrl(linkedinUrl),
    normalizeDedupeValue(linkedinUrl),
    linkedinUrl,
    normalizeLinkedInUrl(fallbackUrl),
    normalizeDedupeValue(fallbackUrl),
    fallbackUrl,
  ].filter(Boolean);

  for (const key of candidateKeys) {
    const found = evidenceByUrl.get(key);
    if (found) return found;
  }
  return undefined;
}

/** Increment a rejection/failure counter map by one. */
export function incrementCounter(
  counts: Record<string, number>,
  key: string,
): void {
  counts[key] = (counts[key] || 0) + 1;
}

/** Abort-aware sleep that rejects immediately when the signal fires. */
export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
  message = "Session cancelled",
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(message));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

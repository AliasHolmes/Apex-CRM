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

const TRANSIENT_LLM_ERROR =
  /rate.?limit|429|timeout|etimedout|econnreset|fetch failed|socket hang up|5\d\d|bad gateway|service unavailable|overloaded/i;

/** True when an LLM/provider error looks transient and worth retrying. */
export function isTransientLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return TRANSIENT_LLM_ERROR.test(message);
}

/**
 * Run an async task with bounded retries for transient failures only.
 * Parse/validation errors (non-transient) fail immediately. Abort-aware:
 * retries stop as soon as the signal fires.
 */
export async function runWithTransientRetry<T>(
  task: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 1, 3));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1500);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const isLastAttempt =
        attempt >= attempts ||
        !isTransientLLMError(error) ||
        options.signal?.aborted;
      if (isLastAttempt) throw error;
      const delayMs = baseDelayMs * attempt;
      options.onRetry?.(attempt + 1, delayMs, error);
      await sleepWithAbort(delayMs, options.signal);
    }
  }
  throw lastError;
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

/**
 * Build a compact evidence map for a session checkpoint.
 *
 * Candidates can register up to four URL-form keys each in evidenceByUrl;
 * persisting all of them bloats checkpoint_json. This keeps ONE canonical key
 * per referenced candidate (preferring the "linkedin:<username>" form) and
 * only for leads actually being checkpointed, so restored sessions retain
 * exactly the evidence they need.
 */
export function buildCheckpointEvidence<E extends SessionEvidenceMeta>(
  evidenceByUrl: Map<string, E>,
  acceptedLeads: any[],
  cap = 240,
): Record<string, E> {
  const result: Record<string, E> = {};
  let included = 0;

  for (const lead of acceptedLeads) {
    if (included >= cap) break;
    const linkedinUrl =
      lead?.contactDetails?.linkedinUrl || lead?.sourceUrl || "";
    if (!linkedinUrl) continue;

    // Prefer canonical prefixed form, then normalized URL, then raw string -
    // mirroring the lookup order of findEvidenceForLead.
    const candidateKeys = [
      `linkedin:${(linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1] || ""}`,
      normalizeLinkedInUrl(linkedinUrl),
      linkedinUrl,
    ].filter(Boolean);

    for (const key of candidateKeys) {
      const found = evidenceByUrl.get(key);
      if (found) {
        result[key] = found;
        included++;
        break;
      }
    }
  }
  return result;
}

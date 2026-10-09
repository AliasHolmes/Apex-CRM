import crypto from "crypto";
import { canonicalLinkedInIdentity, getLinkedInHandle } from "../../src/utils/leadDedupe.js";

/** Stable cross-session key for a LinkedIn profile URL ("linkedin:<handle>"), or "". */
export function candidateVerdictKeyForUrl(url?: string | null): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const identity = canonicalLinkedInIdentity(raw);
  if (identity) return identity;
  const handle = getLinkedInHandle(raw);
  return handle ? `linkedin:${handle}` : "";
}

/** Reads the LinkedIn URL from every field the pipeline actually populates. */
export function candidateVerdictKey(lead: Record<string, any> | null | undefined): string {
  const urls = [
    lead?.contactDetails?.linkedinUrl,
    lead?.profile?.contactDetails?.linkedinUrl,
    lead?.sourceUrl,
    lead?.evidence?.sourceUrl,
    lead?.url,
  ];
  for (const url of urls) {
    const key = candidateVerdictKeyForUrl(url);
    if (key) return key;
  }
  return "";
}

/** "default" is shared by every brief without requirements and must never key a cache. */
export function isCacheableFingerprint(fingerprint: string): boolean {
  return Boolean(fingerprint) && fingerprint !== "default";
}

/**
 * Order-independent hash of a candidate's evidence. The company-attribution item is
 * excluded because it is added mid-round, after the reuse check runs.
 *
 * The hash covers each evidence item's id and length rather than its full text: the same
 * LinkedIn profile re-scraped in a later session yields re-worded snippet blocks with a
 * stable id set, and those should reuse the prior verdict (the grounding-relevant
 * passages are re-checked by the strict-citation verifier on reuse). Full-text hashing
 * made every re-scrape a cache miss and re-judged the same profile every session.
 */
export function computeEvidenceHash(
  evidence?: Array<{ id?: string; text?: string } | null | undefined>,
): string {
  const signature = (Array.isArray(evidence) ? evidence : [])
    .filter((item) => item && item.id !== "e_company_attr")
    .map((item) => `${String(item?.id || "e")}:${String(item?.text || "").replace(/\s+/g, " ").trim().length}`)
    .sort();
  if (signature.length === 0) return "";
  return crypto.createHash("sha256").update(signature.join("|")).digest("hex").slice(0, 16);
}

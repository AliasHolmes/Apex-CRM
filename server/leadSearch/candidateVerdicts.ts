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

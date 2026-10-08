import { COUNTRY_CANONICAL_MAP, ALL_KNOWN_METROS } from "./prospectContract.js";
import { normalizeAliasTerm } from "./aliasMap.js";
import type { ProspectContract } from "./prospectContract.js";

export type QuerySignature = {
  roleClass: string;
  orgClass: string;
  topicTokens: string[];
  geoAnchor: string;
};

export const QUERY_DEDUPE_TOPIC_JACCARD = 0.5;

const ROLE_CLASS_OWNER_PRINCIPAL = new Set([
  "founder",
  "co-founder",
  "cofounder",
  "owner",
  "proprietor",
  "ceo",
  "chief executive",
  "chief executive officer",
  "founder & ceo",
  "founder and ceo",
  "principal",
]);

const ROLE_CLASS_PARTNER = new Set([
  "managing partner",
  "partner",
  "general partner",
  "founding partner",
]);

const ROLE_CLASS_DIRECTOR = new Set([
  "managing director",
  "director",
  "md",
  "executive director",
]);

const ORG_CONTAINER_WORDS = new Set([
  "agency",
  "agencies",
  "consultancy",
  "consultancies",
  "consulting",
  "firm",
  "firms",
  "studio",
  "studios",
  "boutique",
  "boutiques",
  "practice",
  "practices",
  "company",
  "companies",
  "startup",
  "startups",
]);

const STOPWORDS = new Set([
  "in",
  "at",
  "for",
  "of",
  "with",
  "and",
  "or",
  "the",
  "a",
  "an",
  "based",
  "located",
  "near",
  "to",
  "from",
  "list",
  "directory",
  "directories",
  "profiles",
  "profile",
  "linkedin",
  "site",
  "top",
  "best",
]);

function lightStem(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t.length > 5 && t.endsWith("ing")) {
    t = t.slice(0, -3);
  } else if (t.length > 4 && t.endsWith("ed")) {
    t = t.slice(0, -2);
  } else if (t.length > 4 && t.endsWith("ies")) {
    t = t.slice(0, -3) + "y";
  } else if (t.length > 3 && t.endsWith("es")) {
    t = t.slice(0, -2);
  } else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) {
    t = t.slice(0, -1);
  }
  return t;
}

export function computeTopicJaccard(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function buildQuerySignature(
  query: string,
  options?: { contract?: ProspectContract },
): QuerySignature {
  const raw = String(query || "").toLowerCase();
  const cleaned = raw.replace(/[()",/\\|]/g, " ").replace(/\s+/g, " ").trim();

  // 1. Detect Geo Anchor (Metro first, then Country)
  let geoAnchor = "";
  const matchedGeoWords = new Set<string>();

  // Metro check
  for (const metro of ALL_KNOWN_METROS) {
    const mLower = metro.toLowerCase();
    const regex = new RegExp(`\\b${mLower.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (regex.test(cleaned)) {
      geoAnchor = mLower;
      for (const word of mLower.split(/\s+/)) {
        matchedGeoWords.add(word);
      }
      break;
    }
  }

  // Country check if no metro found
  if (!geoAnchor) {
    for (const [key, canonical] of Object.entries(COUNTRY_CANONICAL_MAP)) {
      const kLower = key.toLowerCase();
      const regex = new RegExp(`\\b${kLower.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      if (regex.test(cleaned)) {
        geoAnchor = canonical.toLowerCase();
        for (const word of kLower.split(/\s+/)) {
          matchedGeoWords.add(word);
        }
        break;
      }
    }
  }

  // 2. Detect Role Class
  let roleClass = "";
  const matchedRoleWords = new Set<string>();

  const checkRoleClass = (classSet: Set<string>, className: string): boolean => {
    for (const term of classSet) {
      const regex = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      if (regex.test(cleaned)) {
        roleClass = className;
        for (const word of term.split(/\s+/)) {
          matchedRoleWords.add(word);
        }
        return true;
      }
    }
    return false;
  };

  if (!checkRoleClass(ROLE_CLASS_OWNER_PRINCIPAL, "owner-principal")) {
    if (!checkRoleClass(ROLE_CLASS_PARTNER, "partner")) {
      if (!checkRoleClass(ROLE_CLASS_DIRECTOR, "director")) {
        // Fallback to contract acceptable terms if provided
        if (options?.contract?.requirements) {
          for (const req of options.contract.requirements) {
            if (req.scope === "person_role") {
              for (const term of req.acceptableTerms) {
                const regex = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
                if (regex.test(cleaned)) {
                  roleClass = normalizeAliasTerm(term) || term.toLowerCase();
                  for (const word of term.toLowerCase().split(/\s+/)) {
                    matchedRoleWords.add(word);
                  }
                  break;
                }
              }
            }
            if (roleClass) break;
          }
        }
      }
    }
  }

  if (!roleClass) {
    roleClass = "other_role";
  }

  // 3. Detect Org Class
  let orgClass = "";
  const matchedOrgWords = new Set<string>();
  for (const orgWord of ORG_CONTAINER_WORDS) {
    const regex = new RegExp(`\\b${orgWord}\\b`, "i");
    if (regex.test(cleaned)) {
      orgClass = "container_org";
      matchedOrgWords.add(orgWord);
      break;
    }
  }
  if (!orgClass) {
    orgClass = "other_org";
  }

  // 4. Topic Tokens: remainder after removing stopwords, role words, org words, and geo words
  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  const topicTokensSet = new Set<string>();

  for (const word of rawWords) {
    const stripped = word.replace(/[^a-z0-9]/g, "");
    if (!stripped || stripped.length <= 1) continue;
    if (STOPWORDS.has(stripped)) continue;
    if (matchedGeoWords.has(stripped)) continue;
    if (matchedRoleWords.has(stripped)) continue;
    if (matchedOrgWords.has(stripped)) continue;

    const stemmed = lightStem(stripped);
    if (stemmed.length > 1) {
      topicTokensSet.add(stemmed);
    }
  }

  const topicTokens = Array.from(topicTokensSet).sort();

  return {
    roleClass,
    orgClass,
    topicTokens,
    geoAnchor,
  };
}

export function isNearDuplicateQuery(
  sig: QuerySignature,
  historySigs: QuerySignature[],
  threshold = QUERY_DEDUPE_TOPIC_JACCARD,
): boolean {
  for (const prev of historySigs) {
    if (
      prev.roleClass === sig.roleClass &&
      prev.orgClass === sig.orgClass &&
      prev.geoAnchor === sig.geoAnchor
    ) {
      const similarity = computeTopicJaccard(prev.topicTokens, sig.topicTokens);
      if (similarity >= threshold) {
        return true;
      }
    }
  }
  return false;
}

export function isSignatureExhausted(
  sig: QuerySignature,
  exhaustedSigs: QuerySignature[],
  threshold = QUERY_DEDUPE_TOPIC_JACCARD,
): boolean {
  for (const ex of exhaustedSigs) {
    if (
      ex.roleClass === sig.roleClass &&
      ex.orgClass === sig.orgClass &&
      ex.geoAnchor === sig.geoAnchor
    ) {
      // Treat as exhausted only when the topical focus also matches. Without
      // this, "founder AI agency Berlin" and "founder logistics company Berlin"
      // (same role/org/geo, different verticals) are treated as identical and the
      // second is wrongly dropped, starving vertical diversification. Mirrors the
      // strictness of isNearDuplicateQuery. (Two empty topic sets => jaccard 1.0,
      // so genuinely identical topic-less queries are still throttled.)
      const similarity = computeTopicJaccard(ex.topicTokens, sig.topicTokens);
      if (similarity >= threshold) {
        return true;
      }
    }
  }
  return false;
}

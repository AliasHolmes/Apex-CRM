/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic profile-quality helpers: social-proof parsing, company-page
 * detection, and wrong-vertical agency detection.
 *
 * Single source of truth used by `checkStrictContradiction` (finalistJudge)
 * so dataset-dossier and SERP candidates face identical quality gates with
 * zero LLM cost.
 */

export type SocialProof = {
  followers: number | null;
  connections: number | null;
  influencer: boolean;
};

const toFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Parse dossier numeric fields (Bright Data dataset hits). */
export function parseSocialProofFromDossier(hit: Record<string, any> | null | undefined): SocialProof {
  if (!hit || typeof hit !== "object") return { followers: null, connections: null, influencer: false };
  return {
    followers: toFiniteNumber((hit as any).followers),
    connections: toFiniteNumber((hit as any).connections ?? (hit as any).connections_count),
    influencer: Boolean((hit as any).influencer),
  };
}

const COUNT_REGEX = /(\d[\d,]*)\s+(connections?|followers?)\b/i;

/** Parse "500 connections, 1694 followers" style SERP snippet text. */
export function parseSocialProofFromText(text: unknown): SocialProof {
  const out: SocialProof = { followers: null, connections: null, influencer: false };
  if (typeof text !== "string" || !text) return out;
  const global = new RegExp(COUNT_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    const n = toFiniteNumber(match[1]);
    if (n === null) continue;
    if (/^follower/i.test(match[2])) out.followers = n;
    else out.connections = n;
  }
  return out;
}

/** Merge dossier + snippet evidence; dossier wins on conflict. */
export function extractSocialProof(lead: Record<string, any> | null | undefined): SocialProof {
  const fromDossier = parseSocialProofFromDossier(
    (lead as any)?._rawDossier && typeof (lead as any)._rawDossier === "object"
      ? (lead as any)._rawDossier
      : null,
  );
  const snippets = [
    (lead as any)?.evidence?.evidenceBlock,
    ...(Array.isArray((lead as any)?.evidence?.snippets)
      ? (lead as any).evidence.snippets.map((s: any) => (typeof s === "string" ? s : s?.text || ""))
      : []),
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
  const fromText = parseSocialProofFromText(snippets);
  return {
    followers: fromDossier.followers ?? fromText.followers,
    connections: fromDossier.connections ?? fromText.connections,
    influencer: fromDossier.influencer,
  };
}

/**
 * Ghost-profile signature: an explicitly zero follower count on a tiny
 * network. Unknown counts (null) never fail — only measured zeros do.
 */
export function isGhostProfile(proof: SocialProof, maxConnections = 50): boolean {
  return proof.followers === 0 && (proof.connections ?? 0) < maxConnections && !proof.influencer;
}

const LEGAL_SUFFIX_PATTERN = /\b(inc|llc|ltd|limited|corp|corporation|company|co|pllc|pc|group|holdings|solutions|services|sas|spa|srl|gmbh|pty|pvt)\.?$/i;

export const normalizeCompanyNameForCompare = (value: unknown): string =>
  String(value || "")
    .toLowerCase()
    .replace(/[.,&'’"()|-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(LEGAL_SUFFIX_PATTERN, "")
    .trim();

const CORPORATE_ENTITY_NOUNS =
  /\b(agency|entertainment|realty|holdings|technologies|corporation|solutions|studios?|enterprises?|logistics|ventures?|associates|partners|brokerage|properties|industries|online|media group|marketing llc|marketing inc)\b/i;

const STARTS_WITH_ARTICLE = /^(the|a|an)\s+/i;

/**
 * Company page saved as a person (e.g. fullName "Verdeschi Realty" at company
 * "Verdeschi Realty", or "The Agency" at "The Agency (theagencyOnline.com)").
 * Detects direct equality, leading articles with corporate nouns, or explicit corporate descriptors.
 */
export function isCompanyPageProfile(input: {
  fullName?: unknown;
  company?: unknown;
}): boolean {
  const rawName = String(input.fullName || "").trim();
  if (!rawName || rawName.length < 2) return false;

  const name = normalizeCompanyNameForCompare(rawName);
  const company = normalizeCompanyNameForCompare(input.company);

  // 1. Direct equality between person name and company name
  if (name && company && name.length >= 3 && name === company) {
    return true;
  }

  // 2. Name starts with an article and has corporate entity keywords (e.g. "The Agency")
  if (STARTS_WITH_ARTICLE.test(rawName) && CORPORATE_ENTITY_NOUNS.test(rawName)) {
    return true;
  }

  // 3. Name contains explicit corporate/commercial entity nouns (e.g. "Lucky Branded Entertainment")
  if (
    /\b(entertainment|realty|holdings|technologies|enterprises?|brokerage|corporation|studios?)\b/i.test(
      rawName,
    )
  ) {
    return true;
  }

  // 4. Person name matches company name prefix/containment and contains corporate descriptors
  if (
    company &&
    (company.startsWith(name + " ") || name.startsWith(company + " ")) &&
    CORPORATE_ENTITY_NOUNS.test(rawName)
  ) {
    return true;
  }

  return false;
}

/**
 * Non-services verticals that contain the word "agency" but are not
 * client-services firms: real estate, insurance, cannabis retail, travel
 * retail, auto sales. Failing here requires the contract to NOT name the
 * vertical (a brief asking for "real estate agencies" must still match).
 */
export const NON_SERVICES_AGENCY_REGEX =
  /\b(real estate|realty|realtors?|property management|brokers?|brokerages?|insurance|allstate|state farm|farmers insurance|geico|progressive|liberty mutual|aaa\b|aaa club|mortgage|title company|cannabis|dispensar(?:y|ies)|marijuana|weed|travel agency|travel agent|talent agency|modeling agency|casting agency|bail bonds?|auto (?:insurance|dealership|sales|club)|motor club|car dealership|used cars)\b/i;

export function contractMentionsVertical(contractText: string): boolean {
  return NON_SERVICES_AGENCY_REGEX.test(contractText || "");
}

export function candidateMatchesNonServicesVertical(lead: Record<string, any>): string | null {
  const haystacks: Array<{ label: string; text: string }> = [
    { label: "industry", text: `${(lead as any)?.industry || ""} ${(lead as any)?.profile?.industry || ""}` },
    { label: "company", text: `${(lead as any)?.currentCompany || (lead as any)?.company || (lead as any)?.profile?.currentCompany || ""}` },
    {
      label: "profile",
      text: `${(lead as any)?.currentTitle || ""} ${(lead as any)?.headline || ""} ${(lead as any)?.summary || ""} ${(lead as any)?.about || ""}`,
    },
  ];
  for (const { text } of haystacks) {
    const match = text.match(NON_SERVICES_AGENCY_REGEX);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

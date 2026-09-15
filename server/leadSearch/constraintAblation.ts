import type { ProspectContract, ProspectRequirement } from './prospectContract.js';

export type AblationTier = 1 | 2 | 3 | 4;

export const ABLATION_TIERS = {
  TIER_1_IMMUTABLE_CORE: 1, // NEVER ablated (person_role, identity_hard, explicit immutable core)
  TIER_1_IDENTITY_HARD: 1, // Alias for backward compatibility
  TIER_2_LOCATION_ANCHOR: 2, // person_location, company_location
  TIER_3_DOMAIN_QUALIFIER: 3, // company_industry, company_type, company_size
  TIER_4_VOLATILE_CONTEXT: 4, // tech stack, tooling, funding, context_hard
} as const;

export type AblationResult = {
  ablatedQuery: string;
  ablatedRequirementId: string;
  ablatedTerm: string;
  tier: AblationTier;
};

const VOLATILE_CONTEXT_REGEX = /\b(stack|tool|tech|framework|cloud|database|snowflake|databricks|aws|gcp|azure|hubspot|salesforce|stripe|series\s+[a-e]|seed|funding|raised|venture|bootstrapped|invested|hiring)\b/i;

/**
 * Classifies a contract requirement into its ablation tier.
 *
 * Ordering matters, and the two rules below are deliberately in this order:
 *
 * 1. **Role / identity is unconditionally Tier 1.** These are checked BEFORE the
 *    volatile-context text scan. The scan is text-based, so a genuine role such as
 *    "Cloud Architect" or "Salesforce Administrator" contains a volatile keyword
 *    ('cloud', 'salesforce') and was previously downgraded to ablatable Tier 4.
 *    That let `ablateQueryTask` strip the entire identity anchor out of a query -
 *    measured: `'"cloud architect" London'` -> `'London'` - contradicting this
 *    module's Tier-1 guarantee ("NEVER ablated") and the immutable-core guard in
 *    `ablateQueryTask`.
 *
 * 2. **A volatile description still outranks a firmographic scope.** A requirement
 *    compiled as `company_type` but describing tooling ("Snowflake stack") is
 *    Tier 4 and stays ablatable - see `test/constraintAblation.test.ts`
 *    ("classifies volatile context / tech stack as Tier 4"). Only role/identity is
 *    exempt from this rule, because a stripped role yields an anchor-less query
 *    rather than a slightly looser one.
 */
export function classifyAblationTier(requirement: ProspectRequirement): AblationTier {
  // Rule 1: role and identity requirements can never be ablated.
  if (
    requirement.requirementClass === 'identity_hard' ||
    requirement.scope === 'person_role' ||
    (requirement as any).isImmutableCore
  ) {
    return ABLATION_TIERS.TIER_1_IMMUTABLE_CORE;
  }

  // Rule 2: volatile context (tools, tech stack, funding, signals) is ablated first.
  const fullText = `${requirement.description} ${requirement.sourcePhrase} ${(requirement.acceptableTerms || []).join(' ')}`;
  if (
    requirement.scope === 'signal' ||
    VOLATILE_CONTEXT_REGEX.test(fullText)
  ) {
    return ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT;
  }

  if (
    requirement.scope === 'company_type' ||
    requirement.scope === 'company_industry'
  ) {
    return ABLATION_TIERS.TIER_1_IMMUTABLE_CORE;
  }

  if (requirement.scope === 'person_location') {
    return ABLATION_TIERS.TIER_2_LOCATION_ANCHOR;
  }

  if (requirement.scope === 'company_size') {
    return ABLATION_TIERS.TIER_3_DOMAIN_QUALIFIER;
  }

  // All other hard requirements (stack, funding, tooling, context_hard) are Tier 4 volatile context
  return ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanQueryQuotes(q: string): string {
  let cleaned = q.replace(/""|''/g, ' ').replace(/\s+/g, ' ').trim();
  const quoteCount = (cleaned.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    cleaned = cleaned.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

/**
 * Given an executed search query and the prospect contract, dynamically relaxes
 * the lowest-priority requirement term (Tier 4 first, then Tier 3, then Tier 2).
 * Tier 1 (identity_hard) terms are strictly preserved and never ablated.
 */
export function ablateQueryTask(
  query: string,
  contract: ProspectContract,
  coveredRequirementIds?: string[],
): AblationResult | null {
  if (!query || query.trim().length < 8) return null;

  let candidateRequirements = contract.requirements.filter((req) => {
    if (req.importance !== 'hard') return false;
    if (coveredRequirementIds && coveredRequirementIds.length > 0) {
      if (!coveredRequirementIds.includes(req.id)) return false;
    }
    const tier = classifyAblationTier(req);
    // Tier 1 is never ablated
    return tier > ABLATION_TIERS.TIER_1_IMMUTABLE_CORE;
  });

  // Fall back to all non-identity hard contract requirements if filtered set is empty
  if (candidateRequirements.length === 0 && coveredRequirementIds && coveredRequirementIds.length > 0) {
    candidateRequirements = contract.requirements.filter((req) => {
      if (req.importance !== 'hard') return false;
      const tier = classifyAblationTier(req);
      return tier > ABLATION_TIERS.TIER_1_IMMUTABLE_CORE;
    });
  }

  if (candidateRequirements.length === 0) return null;

  // Find which requirement terms appear in the query
  type MatchCandidate = {
    requirement: ProspectRequirement;
    tier: AblationTier;
    term: string;
  };

  const matches: MatchCandidate[] = [];

  for (const req of candidateRequirements) {
    const tier = classifyAblationTier(req);
    const termsToTry = [...(req.acceptableTerms || []), req.sourcePhrase].filter(Boolean);

    for (const term of termsToTry) {
      const trimmed = term.trim();
      if (trimmed.length < 2) continue;

      const escaped = escapeRegex(trimmed);
      const testRegex = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)`, 'i');
      if (testRegex.test(query)) {
        matches.push({
          requirement: req,
          tier,
          term: trimmed,
        });
        break; // Match one term per requirement
      }
    }
  }

  if (matches.length === 0) return null;

  // Sort candidates by tier descending (Tier 4 first, then Tier 3, then Tier 2)
  // Tie-breaker: longer terms first so specific phrases are removed before shorter generic words
  matches.sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    return b.term.length - a.term.length;
  });

  // Ensure explicit immutable core terms (role and core vertical firmographics) can NEVER be ablated
  const immutableCoreReqs = contract.requirements.filter(
    (r) => classifyAblationTier(r) === ABLATION_TIERS.TIER_1_IMMUTABLE_CORE
  );
  const immutableCoreTerms = immutableCoreReqs
    .flatMap((r) => [...(r.acceptableTerms || []), r.sourcePhrase])
    .concat(contract.identitySpec?.companyTypes || [])
    .concat(contract.identitySpec?.industries || [])
    .map((t) => (t || '').trim().toLowerCase())
    .filter((t): t is string => Boolean(t && t.length >= 2 && !VOLATILE_CONTEXT_REGEX.test(t)));

  for (const match of matches) {
    const escaped = escapeRegex(match.term);
    const removeRegex = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)`, 'gi');
    const rawRelaxed = query
      .replace(removeRegex, '')
      .replace(/\s+/g, ' ')
      .trim();
    const relaxedQuery = cleanQueryQuotes(rawRelaxed);

    // If relaxing this match removes an immutable core term or core vertical, skip this match
    if (immutableCoreTerms.length > 0) {
      const queryLower = query.toLowerCase();
      const matchedCoreTerms = immutableCoreTerms.filter((term) => queryLower.includes(term));
      if (matchedCoreTerms.length > 0) {
        const relaxedLower = relaxedQuery.toLowerCase();
        const stillHasCoreTerms = matchedCoreTerms.every((term) =>
          relaxedLower.includes(term)
        );
        if (!stillHasCoreTerms) {
          continue;
        }
      }
    }

    // Verify the relaxed query is valid and actually changed
    if (relaxedQuery.length >= 4 && relaxedQuery !== query.trim()) {
      return {
        ablatedQuery: relaxedQuery,
        ablatedRequirementId: match.requirement.id,
        ablatedTerm: match.term,
        tier: match.tier,
      };
    }
  }

  return null;
}

export type AblationTracker = {
  rescuesCount: number;
  attemptsCount: number;
  ablatedTasks: Set<string>;
  maxAblatedPerRound: number;
};

export function createAblationTracker(maxAblatedPerRound = 2): AblationTracker {
  return {
    rescuesCount: 0,
    attemptsCount: 0,
    ablatedTasks: new Set<string>(),
    maxAblatedPerRound,
  };
}

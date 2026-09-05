import type { ProspectContract, ProspectRequirement } from './prospectContract.js';

export type AblationTier = 1 | 2 | 3 | 4;

export const ABLATION_TIERS = {
  TIER_1_IDENTITY_HARD: 1, // NEVER ablated (person_role, identity_hard)
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
 * Tier 1 (identity_hard / role) is immutable and can never be ablated.
 * Tier 4 (volatile context / stack / tooling) is ablated first.
 */
export function classifyAblationTier(requirement: ProspectRequirement): AblationTier {
  if (
    requirement.requirementClass === 'identity_hard' ||
    requirement.scope === 'person_role'
  ) {
    return ABLATION_TIERS.TIER_1_IDENTITY_HARD;
  }

  if (requirement.scope === 'person_location') {
    return ABLATION_TIERS.TIER_2_LOCATION_ANCHOR;
  }

  // Check if requirement represents specific volatile context (tools, tech stack, funding, signals)
  const fullText = `${requirement.description} ${requirement.sourcePhrase} ${(requirement.acceptableTerms || []).join(' ')}`;
  if (
    requirement.scope === 'signal' ||
    VOLATILE_CONTEXT_REGEX.test(fullText)
  ) {
    return ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT;
  }

  if (
    requirement.scope === 'company_industry' ||
    requirement.scope === 'company_type' ||
    requirement.scope === 'company_size'
  ) {
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
    return tier > ABLATION_TIERS.TIER_1_IDENTITY_HARD;
  });

  // Fall back to all non-identity hard contract requirements if filtered set is empty
  if (candidateRequirements.length === 0 && coveredRequirementIds && coveredRequirementIds.length > 0) {
    candidateRequirements = contract.requirements.filter((req) => {
      if (req.importance !== 'hard') return false;
      const tier = classifyAblationTier(req);
      return tier > ABLATION_TIERS.TIER_1_IDENTITY_HARD;
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

  for (const match of matches) {
    const escaped = escapeRegex(match.term);
    const removeRegex = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)`, 'gi');
    const rawRelaxed = query
      .replace(removeRegex, '')
      .replace(/\s+/g, ' ')
      .trim();
    const relaxedQuery = cleanQueryQuotes(rawRelaxed);

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

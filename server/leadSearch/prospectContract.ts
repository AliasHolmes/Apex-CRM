import { Type } from '../services/llm.js';
import type { SearchQueryPlanItem, SearchSpec } from './searchSpec.js';
import type { IntentSignalSpec } from './intentSignals.js';
import { isFlagEnabled } from './featureFlags.js';

// Bump this whenever normalization changes so old under-specified contracts
// cannot be reused from the SQLite cache.
export const PROSPECT_CONTRACT_POLICY_VERSION = 'evidence-contract-v8';

export type RequirementScope =
  | 'person_role'
  | 'person_location'
  | 'company_type'
  | 'company_industry'
  | 'company_size'
  | 'signal';

export type EvidenceModality = 'structured_profile' | 'open_web_signal' | 'inferred';

export type RequirementClass =
  | 'system_invariant'        // Validation guard, never in queries (e.g., URL validity)
  | 'identity_hard'           // Essential; required in every person query (e.g., "owner")
  | 'context_hard'            // Qualifying; distributed round-robin across queries (e.g., "New York")
  | 'evidence_required'       // Routing signal; guides evidence extraction (e.g., company size)
  | 'ranking_signal';         // Soft; for scoring, never in queries (e.g., "nice to have")

export type QueryHardness =
  | 'required_in_every_query'       // Append to every person query (identity_hard)
  | 'distributed_across_queries'   // Append to ~1 per N queries via round-robin (context_hard)
  | 'optional_for_queries';        // Never append (system_invariant, ranking_signal, etc.)

export type EvidenceSource =
  | 'linkedin_profile'
  | 'company_website'
  | 'job_postings'
  | 'news_articles'
  | 'social_media';

export type MatchRule = 'all_of' | 'any_of';

export type ProspectRequirement = {
  id: string;
  scope: RequirementScope;
  importance: 'hard' | 'soft';
  evidenceModality: EvidenceModality;
  description: string;
  /** Exact phrase from the user's brief. This prevents invented constraints. */
  sourcePhrase: string;
  acceptableTerms: string[];
  queryable: boolean;
  requirementClass?: RequirementClass;
  queryHardness?: QueryHardness;
  acceptableEvidenceSources?: EvidenceSource[];
  groupId?: string;
  matchRule?: MatchRule;
};

export type DecompositionMode = 'single_stream_identity' | 'dual_stream_intent';

export type IdentitySpec = {
  roles: string[];
  locations: string[];
  companyTypes: string[];
  industries: string[];
  seniorities?: string[];
};

export type IntentSpec = {
  toolingKeywords: string[];
  hiringSignals: string[];
  painSignals: string[];
  growthSignals: string[];
};

export type ProspectContract = {
  version: 1;
  policyVersion: typeof PROSPECT_CONTRACT_POLICY_VERSION;
  brief: string;
  decompositionMode?: DecompositionMode;
  identitySpec?: IdentitySpec;
  intentSpec?: IntentSpec;
  authorityRequired: boolean;
  requirements: ProspectRequirement[];
  exclusions: string[];
  initialQueries: SearchQueryPlanItem[];
  intentSignals?: IntentSignalSpec;
};

const clean = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();
const lower = (value: unknown) => clean(value).toLowerCase();
const unique = (items: string[], max = 25) => Array.from(new Set(items.map(clean).filter(Boolean))).slice(0, max);

const permittedScopes = new Set<RequirementScope>([
  'person_role', 'person_location', 'company_type', 'company_industry', 'company_size', 'signal'
]);

const requirementId = (scope: RequirementScope, index: number) => `${scope}-${index + 1}`;

// ============================================================================
// Phase 1: Requirement Classification (Deterministic)
// ============================================================================

const SYSTEM_INVARIANT_PATTERN = /linkedin.*url|duplicate|valid.*url|profile.*validity/i;

/**
 * Classify a requirement into one of five categories based on scope and importance.
 * This classification determines how the requirement is used in queries and routing.
 */
export function classifyRequirement(
  scope: RequirementScope,
  importance: 'hard' | 'soft',
  sourcePhrase: string
): RequirementClass {
  // Soft requirements are never query terms
  if (importance === 'soft') return 'ranking_signal';

  // System invariants: validation guards, never in queries
  if (scope === 'signal' && SYSTEM_INVARIANT_PATTERN.test(sourcePhrase)) {
    return 'system_invariant';
  }

  // Identity requirements: person role (owner, CEO, etc.)
  if (scope === 'person_role') return 'identity_hard';

  // Context requirements: location, industry, company type
  if (['person_location', 'company_type', 'company_industry'].includes(scope)) {
    return 'context_hard';
  }

  // Evidence routing: company size inferred data
  if (scope === 'company_size') return 'evidence_required';

  // Catch-all: default context for unclassified hard requirements
  return 'context_hard';
}

/**
 * Derive query hardness from requirement class.
 * This determines whether the requirement is appended to every query, distributed, or optional.
 */
export function assignQueryHardness(requirementClass: RequirementClass): QueryHardness {
  switch (requirementClass) {
    case 'system_invariant':
    case 'ranking_signal':
      return 'optional_for_queries';
    case 'identity_hard':
      return 'required_in_every_query';
    case 'context_hard':
    case 'evidence_required':
      return 'distributed_across_queries';
  }
}

const sourceAppearsInBrief = (phrase: string, brief: string) => {
  const normalizedPhrase = lower(phrase);
  return Boolean(normalizedPhrase && lower(brief).includes(normalizedPhrase));
};

const inferredAuthority = (requirements: ProspectRequirement[]) => requirements.some(requirement =>
  requirement.scope === 'person_role' && /\b(owners?|founders?|chief|ceo|president|partners?|vp|vice president|head|directors?|manager)\b/i.test(
    [requirement.description, ...requirement.acceptableTerms].join(' ')
  )
);

const includeTerms = (values: string[], brief: string) => unique(values.filter(value => sourceAppearsInBrief(value, brief)));

const expandAcceptableTerms = (scope: RequirementScope, terms: string[]): string[] => {
  const expanded = [...terms];
  const hasTerm = (list: string[], matches: string[]) =>
    list.some(t => matches.some(m => t.toLowerCase().includes(m)));

  if (scope === 'person_location') {
    if (hasTerm(terms, ['usa', 'united states', 'us', 'america'])) {
      expanded.push('USA', 'United States', 'US', 'U.S.', 'America');
    }
    if (hasTerm(terms, ['uk', 'united kingdom', 'britain', 'england'])) {
      expanded.push('UK', 'United Kingdom', 'Britain', 'England');
    }
    if (hasTerm(terms, ['canada', 'canadian'])) {
      expanded.push('Canada', 'Canadian');
    }
    if (hasTerm(terms, ['australia', 'australian', 'au'])) {
      expanded.push('Australia', 'Australian');
    }
    if (hasTerm(terms, ['new zealand', 'newzealand', 'nz'])) {
      expanded.push('New Zealand', 'NZ');
    }
  }

  if (scope === 'person_role') {
    if (terms.some(t => /\b(owner|owners?|firm owner|agency owner|founder|founders?|co-?founder|ceo|chief executive officer|president|managing partner|managing director|principal|partner|proprietor)\b/i.test(t))) {
      expanded.push('owner', 'owners', 'firm owner', 'agency owner', 'founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'principal', 'president', 'proprietor');
    }
  }

  if (scope === 'company_type') {
    if (terms.some(t => /\bai\s+agenc/i.test(t) || /\bagenc/i.test(t))) {
      expanded.push('AI agency', 'AI agencies', 'AI marketing agency', 'AI consultancy', 'AI studio', 'AI firm', 'artificial intelligence agency', 'AI-powered agency');
    }
  }

  return unique(expanded);
};

const INTENT_TRIGGER_PATTERN = /\b(hiring|recruiting|looking\s+for|seeking|using|evaluating|migrating|switching|scaling\s+past|manual\s+process|bottleneck|open\s+role|partner\s+program|white\s*label|subcontract)\b/i;

export function detectDecompositionMode(brief: string): DecompositionMode {
  const text = clean(brief);
  if (!text) return 'single_stream_identity';
  const words = text.split(/\s+/).filter(Boolean);
  if (INTENT_TRIGGER_PATTERN.test(text)) {
    return 'dual_stream_intent';
  }
  if (words.length > 14) {
    return 'dual_stream_intent';
  }
  return 'single_stream_identity';
}

/**
 * The fallback never adds an inferred audience. It keeps a search usable when
 * the contract compiler is unavailable, while still preserving supplied spec
 * constraints as hard requirements.
 */
export function buildDeterministicProspectContract(brief: string, spec: Partial<SearchSpec> = {}): ProspectContract {
  const requirements: ProspectRequirement[] = [];
  const add = (scope: RequirementScope, terms: string[], importance: 'hard' | 'soft' = 'hard') => {
    const accepted = expandAcceptableTerms(scope, includeTerms(terms, brief));
    if (!accepted.length) return;
    const reqClass = classifyRequirement(scope, importance, accepted[0]);
    const hardness = assignQueryHardness(reqClass);
    requirements.push({
      id: requirementId(scope, requirements.filter(item => item.scope === scope).length),
      scope,
      importance,
      requirementClass: reqClass,
      queryHardness: hardness,
      evidenceModality: scope === 'signal' ? 'open_web_signal' : scope === 'company_size' ? 'inferred' : 'structured_profile',
      description: accepted.slice(0, 3).join(' or '),
      sourcePhrase: accepted[0],
      acceptableTerms: accepted,
      queryable: reqClass !== 'system_invariant',
      acceptableEvidenceSources: []
    });
  };

  const addWithAlternatives = (
    scope: RequirementScope,
    sourcePhrase: string,
    acceptableTerms: string[],
    importance: 'hard' | 'soft' = 'hard'
  ) => {
    if (!sourceAppearsInBrief(sourcePhrase, brief)) return;
    const accepted = expandAcceptableTerms(scope, unique([sourcePhrase, ...acceptableTerms]));
    const reqClass = classifyRequirement(scope, importance, sourcePhrase);
    const hardness = assignQueryHardness(reqClass);
    requirements.push({
      id: requirementId(scope, requirements.filter(item => item.scope === scope).length),
      scope,
      importance,
      requirementClass: reqClass,
      queryHardness: hardness,
      evidenceModality: scope === 'signal' ? 'open_web_signal' : scope === 'company_size' ? 'inferred' : 'structured_profile',
      description: sourcePhrase,
      sourcePhrase,
      acceptableTerms: accepted,
      queryable: reqClass !== 'system_invariant',
      acceptableEvidenceSources: []
    });
  };

  const roleHints = ['owner', 'owners', 'founder', 'founders', 'co-founder', 'ceo', 'chief executive officer', 'president', 'partner', 'partners', 'vp', 'vice president', 'head of', 'director', 'directors'];
  const hintedRoles = roleHints.filter(term => new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(brief));
  const rolePattern = roleHints.map(term => term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');

  // Guard rails: free-text briefs routinely contain buying-signal timeframes
  // ("from the last 45 days seeking...") and role modifiers ("Managing
  // Partners", "Operations Directors"). The naive extractors below mistake
  // these for geographic locations and company types, producing unsatisfiable
  // hard requirements that silently zero out judge qualification rates.
  const JUNK_TERM_PATTERN = /\b(last|past|within|over|next|during|days?|weeks?|months?|years?|hours?|today|yesterday|seeking|hiring|recruiting|using|tools?|workflows?|signals?|employees|budget)\b/i;
  const isCleanRequirementTerm = (value: unknown) => {
    const v = String(value || '').trim();
    return v.length > 1 && v.length <= 48 && !JUNK_TERM_PATTERN.test(v);
  };
  const TITLE_MODIFIER_PATTERN = /^(?:managing|operations?|technical|executive|senior|junior|lead|principal|chief|global|regional|fractional|founding|head|director|directors|vp|vice|deputy|sales|marketing|revops|finance|co-?\s*founder|co-?\s*owner)\b/i;

  const ROLE_WORDS_PATTERN = /\b(owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i;
  const CONJUNCTION_STOP_PATTERN = /^(?:or|and|with|of|at|in|for|from|to|a|an|the|by|who|which)\b|\b(?:or|and|with|of|at|in|for|from|to|a|an|the|by|who|which)$/i;
  const COMPANY_TITLE_PREFIX_PATTERN = /^(?:managing|senior|junior|lead|principal|chief|executive|vp|vice|deputy|head|director|directors|founder|owner|ceo|president)\b/i;

  const isCleanCompanyTypeTerm = (value: unknown): boolean => {
    const v = clean(value);
    if (!v || v.length < 2 || v.length > 48) return false;
    if (ROLE_WORDS_PATTERN.test(v)) return false;
    if (CONJUNCTION_STOP_PATTERN.test(v)) return false;
    if (COMPANY_TITLE_PREFIX_PATTERN.test(v)) return false;
    if (JUNK_TERM_PATTERN.test(v)) return false;
    return true;
  };

  const rawLocMatch = clean(brief).match(/\b(?:in|near|from)\s+([A-Za-z0-9 ,.'&/-]{1,120})/i)?.[1] || '';
  const extractedLocations = rawLocMatch ? rawLocMatch.split(/,|\band\b|\//).map(s => s.trim()).filter(isCleanRequirementTerm) : [];

  // Pattern A: Prepositional Postfix "[Role] of/at/in/for (a/an)? [Company Type]"
  // e.g. "Founder or owner of a marketing agency with 5-50 employees" -> "marketing agency"
  const prepCompanyMatch = clean(brief).match(/\b(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b\s+(?:of|at|in|for)\s+(?:an?\s+)?([^,.]+?)(?=\s+(?:with|in|near|from|located|who|having|\d+|,|\.|$))/i)?.[1]?.trim() || '';

  // Pattern B: Direct Prefix "[Company Type] [Role]"
  // e.g. "AI agency owner" -> "AI agency"
  const prefixCompanyMatch = clean(brief).match(/\b([^,.]+?)\s+(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i)?.[1]?.trim() || '';

  // Pattern C: Headcount / Employee size
  // e.g. "with 5-50 employees"
  const sizeMatch = clean(brief).match(/\b(\d+)(?:\s*-\s*(\d+))?\s+employees?\b/i);
  const explicitCompanyKeywords = (spec?.company?.keywords || []).filter(keyword => lower(keyword) !== lower(brief) && isCleanCompanyTypeTerm(keyword));
  const ownerMatch = clean(brief).match(/\b(?:firm\s+)?owners?\b/i)?.[0] || '';
  const professionMatch = clean(brief).match(/\b(?:[a-z]+\s+){0,2}(?:lawyers?|attorneys?|dentists?|doctors?|brokers?|accountants?)\b/i)?.[0] || '';
  const firmMatch = clean(brief).match(/\b(?:[a-z]+\s+){0,3}firm\b/i)?.[0] || '';
  const intentMatch = clean(brief).match(/\b(hiring(?:\s+intent)?|recruiting|scaling|funding)\b/i)?.[0] || '';

  // Consolidate all hinted/extracted roles into a unified person_role requirement
  // with an any_of match rule so candidates with any qualifying executive title
  // (e.g. founder, CEO, owner, managing director) qualify without conjunction failures.
  const combinedRoleTerms = unique([
    ...(professionMatch && ownerMatch ? [`${professionMatch} ${ownerMatch}`, `${professionMatch} owner`, `${professionMatch} founder`] : []),
    ...(professionMatch ? [professionMatch, professionMatch.replace(/s\b/i, ''), professionMatch.endsWith('s') ? professionMatch : `${professionMatch}s`] : []),
    ...(spec?.person?.includeTitles || []),
    ...hintedRoles,
    ...(ownerMatch ? ['owner', 'owners', 'firm owner', 'firm owners'] : []),
  ]);

  if (combinedRoleTerms.length > 0) {
    const accepted = expandAcceptableTerms('person_role', combinedRoleTerms);
    const sourcePhrase = professionMatch
      ? (ownerMatch ? `${professionMatch} ${ownerMatch}` : professionMatch)
      : ownerMatch || (hintedRoles[0] || (spec?.person?.includeTitles?.[0] || 'executive'));
    const reqClass = classifyRequirement('person_role', 'hard', sourcePhrase);
    const hardness = assignQueryHardness(reqClass);
    requirements.push({
      id: 'person_role-1',
      scope: 'person_role',
      importance: 'hard',
      requirementClass: reqClass,
      queryHardness: hardness,
      evidenceModality: 'structured_profile',
      description: accepted.slice(0, 3).join(' or '),
      sourcePhrase,
      acceptableTerms: accepted,
      queryable: true,
      groupId: 'person_role_group',
      matchRule: 'any_of',
      acceptableEvidenceSources: []
    });
  }

  add('person_location', [...(spec?.person?.locations || []), ...(spec?.company?.locations || []), ...extractedLocations].filter(isCleanRequirementTerm));
  if (firmMatch && isCleanCompanyTypeTerm(firmMatch)) {
    addWithAlternatives('company_type', firmMatch, [firmMatch.replace(/lawyer firm/i, 'law firm')]);
  }
  if (prepCompanyMatch && isCleanCompanyTypeTerm(prepCompanyMatch)) {
    addWithAlternatives('company_type', prepCompanyMatch, [prepCompanyMatch]);
  } else if (prefixCompanyMatch && isCleanCompanyTypeTerm(prefixCompanyMatch)) {
    addWithAlternatives('company_type', prefixCompanyMatch, [prefixCompanyMatch]);
  }
  add('company_type', explicitCompanyKeywords);
  add('company_industry', spec?.company?.industries || []);
  if (sizeMatch) {
    const minEmployees = Number(sizeMatch[1]);
    const maxEmployees = sizeMatch[2] ? Number(sizeMatch[2]) : undefined;
    const sizePhrase = maxEmployees ? `${minEmployees}-${maxEmployees} employees` : `${minEmployees}+ employees`;
    addWithAlternatives('company_size', sizePhrase, [sizePhrase, `${minEmployees} to ${maxEmployees || ''} employees`].filter(Boolean), 'soft');
  }
  if (intentMatch) {
    addWithAlternatives('signal', intentMatch, ['hiring', 'careers', 'open roles', 'recruiting', 'growing team'], 'soft');
  }
  add('signal', spec?.signals?.include || [], 'soft');

  // A brief with no editable spec still needs one non-invented hard target.
  if (!requirements.length && clean(brief)) {
    const reqClass = classifyRequirement('company_type', 'hard', clean(brief));
    const hardness = assignQueryHardness(reqClass);
    requirements.push({
      id: 'brief-1',
      scope: 'company_type',
      importance: 'hard',
      requirementClass: reqClass,
      queryHardness: hardness,
      evidenceModality: 'structured_profile',
      description: clean(brief),
      sourcePhrase: clean(brief),
      acceptableTerms: [clean(brief)],
      queryable: reqClass !== 'system_invariant',
      acceptableEvidenceSources: []
    });
  }

  const exclusions = unique([
    ...(spec?.person?.excludeTitles || []),
    ...(spec?.exclusions?.companies || []),
    ...(spec?.exclusions?.domains || [])
  ]);

  // Deduplicate requirements of the same scope.
  // For person_role, always merge into a single any_of requirement so candidates
  // never have to satisfy multiple contradictory title criteria simultaneously.
  const deduped: ProspectRequirement[] = [];
  for (const req of requirements) {
    const existing = deduped.find(
      item => item.scope === req.scope &&
        (req.scope === 'person_role' ||
         lower(item.sourcePhrase) === lower(req.sourcePhrase) ||
         lower(item.sourcePhrase).includes(lower(req.sourcePhrase)) ||
         lower(req.sourcePhrase).includes(lower(item.sourcePhrase)))
    );
    if (existing) {
      // Merge acceptableTerms instead of creating a duplicate requirement.
      existing.acceptableTerms = unique([...existing.acceptableTerms, ...req.acceptableTerms]);
      if (req.scope === 'person_role') {
        existing.matchRule = 'any_of';
        existing.groupId = 'person_role_group';
        existing.description = existing.acceptableTerms.slice(0, 4).join(' or ');
      }
    } else {
      if (req.scope === 'person_role') {
        req.matchRule = 'any_of';
        req.groupId = 'person_role_group';
      }
      deduped.push(req);
    }
  }

  const fallback = buildContractFallbackQueries(brief, deduped);
  const decompositionMode = detectDecompositionMode(brief);
  
  // Ensure all requirements have requirementClass and queryHardness (defensive)
  for (const req of deduped) {
    if (!req.requirementClass) {
      req.requirementClass = classifyRequirement(req.scope, req.importance, req.sourcePhrase);
    }
    if (!req.queryHardness) {
      req.queryHardness = assignQueryHardness(req.requirementClass);
    }
    if (!req.acceptableEvidenceSources) {
      req.acceptableEvidenceSources = [];
    }
  }
  
  const identityRoles = unique(deduped.filter(r => r.scope === 'person_role').flatMap(r => r.acceptableTerms));
  const identityLocations = unique(deduped.filter(r => r.scope === 'person_location').flatMap(r => r.acceptableTerms));
  const identityCompanyTypes = unique(deduped.filter(r => r.scope === 'company_type').flatMap(r => r.acceptableTerms));
  const identityIndustries = unique(deduped.filter(r => r.scope === 'company_industry').flatMap(r => r.acceptableTerms));

  const identitySpec: IdentitySpec = {
    roles: identityRoles.length ? identityRoles : (spec?.person?.includeTitles || []),
    locations: identityLocations.length ? identityLocations : (spec?.person?.locations || []),
    companyTypes: identityCompanyTypes.length ? identityCompanyTypes : (spec?.company?.keywords || []),
    industries: identityIndustries.length ? identityIndustries : (spec?.company?.industries || []),
    seniorities: spec?.person?.seniorities
  };

  const intentRequirements = deduped.filter(r => r.scope === 'signal' || r.evidenceModality === 'open_web_signal');
  const intentTerms = intentRequirements.flatMap(r => r.acceptableTerms);

  const intentSpec: IntentSpec = {
    toolingKeywords: intentTerms.filter(t => /\b(n8n|zapier|make|hubspot|salesforce|supabase|airtable|react|python|aws)\b/i.test(t)),
    hiringSignals: intentTerms.filter(t => /\b(hiring|recruiting|role|specialist|developer|engineer|lead)\b/i.test(t)),
    painSignals: intentTerms.filter(t => /\b(manual|scaling|bottleneck|legacy|churn|slow)\b/i.test(t)),
    growthSignals: intentTerms.filter(t => /\b(funded|series|expanding|growing|launch)\b/i.test(t))
  };

  return {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: clean(brief),
    decompositionMode,
    identitySpec,
    intentSpec,
    authorityRequired: inferredAuthority(deduped),
    requirements: deduped,
    exclusions,
    initialQueries: fallback
  };
}

const queryTermsFor = (requirements: ProspectRequirement[]) => requirements
  .filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal')
  .map(item => item.acceptableTerms[0] || item.sourcePhrase)
  .filter(Boolean);

export function buildSignalLaneQueries(
  requirements: ProspectRequirement[],
  identitySpec?: IdentitySpec
): SearchQueryPlanItem[] {
  const companyNiche = identitySpec?.companyTypes?.[0] || requirements.find(r => r.scope === 'company_type')?.acceptableTerms?.[0] || '';
  return requirements
    .filter(r => (r.evidenceModality === 'open_web_signal' || r.scope === 'signal') && r.queryable)
    .map((r, i) => {
      let query = r.acceptableTerms.slice(0, 2).join(' ') || r.sourcePhrase;
      if (companyNiche && !lower(query).includes(lower(companyNiche))) {
        query = `${companyNiche} ${query}`.trim();
      }
      return {
        query: query.slice(0, 240),
        family: 'pain_signal' as const,
        intent: 'find_buying_signal' as const,
        expectedSignal: `Open-web evidence corroborating: ${r.description}`,
        priority: i + 1,
        lane: 'signal' as const,
        providerPreference: 'tavily' as const,
        searchDepth: 'basic' as const,
        coveredRequirementIds: [r.id],
        topic: 'general' as const
      };
    });
}

export function buildContractFallbackQueries(brief: string, requirements: ProspectRequirement[]): SearchQueryPlanItem[] {
  const hardRequirements = requirements.filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal');
  const isAgencyBrief = /\b(agenc|consult|studio|firm|services)\b/i.test(brief) ||
    requirements.some(r => (r.scope === 'company_type' || r.scope === 'company_industry') && /\b(agenc|consult|studio|firm|services)\b/i.test(`${r.description} ${r.acceptableTerms.join(' ')}`));
  const agencyDisambiguation = isAgencyBrief ? '-software -platform -SaaS' : '';
  
  if (isFlagEnabled.distributedQuery()) {
    const identityReqs = hardRequirements.filter(r => r.queryHardness === 'required_in_every_query' || r.requirementClass === 'identity_hard');
    const contextReqs = hardRequirements.filter(r => r.queryHardness === 'distributed_across_queries' || r.requirementClass === 'context_hard' || r.requirementClass === 'evidence_required');
    
    const variants = [0, 1, 2, 3].map(index => {
      const idTerms = identityReqs.map(r => r.acceptableTerms[index % Math.max(r.acceptableTerms.length, 1)] || r.sourcePhrase).filter(Boolean);
      const ctxReq = contextReqs.length ? contextReqs[index % contextReqs.length] : null;
      const ctxTerm = ctxReq ? (ctxReq.acceptableTerms[index % Math.max(ctxReq.acceptableTerms.length, 1)] || ctxReq.sourcePhrase) : '';
      const disambig = (index > 0 && agencyDisambiguation) ? agencyDisambiguation : '';
      return [...idTerms, ctxTerm, disambig].filter(Boolean).join(' ');
    });
    
    const base = queryTermsFor(requirements).join(' ') || clean(brief);
    const retrievalHints = ['', 'public profile', 'professional profile', 'leadership profile'];
    const personQueries = unique(variants.map((variant, index) => [variant || base, retrievalHints[index]].filter(Boolean).join(' ')), 4).map((query, index) => ({
      query: query.slice(0, 240).trim(),
      family: 'persona_title' as const,
      intent: 'find_decision_makers' as const,
      expectedSignal: 'Public profile evidence for distributed hard requirements',
      priority: index + 1,
      lane: 'person' as const,
      providerPreference: index === 0 ? 'tavily' as const : 'corroborate' as const,
      searchDepth: 'basic' as const,
      coveredRequirementIds: requirements.filter(item => item.importance === 'hard').map(item => item.id)
    }));
    const signalQueries = buildSignalLaneQueries(requirements);
    return [...personQueries, ...signalQueries];
  }

  const locationReq = hardRequirements.find(r => r.scope === 'person_location');
  const nonLocationReqs = hardRequirements.filter(r => r.scope !== 'person_location');
  const locationTerms = locationReq?.acceptableTerms && locationReq.acceptableTerms.length > 0
    ? locationReq.acceptableTerms
    : [''];

  const variants = [0, 1, 2, 3].map(index => {
    const nonLocTerms = nonLocationReqs
      .map(requirement => requirement.acceptableTerms[index % Math.max(requirement.acceptableTerms.length, 1)] || requirement.sourcePhrase)
      .filter(Boolean);
    const locTerm = locationTerms[index % locationTerms.length];
    const disambig = (index > 0 && agencyDisambiguation) ? agencyDisambiguation : '';
    return [...nonLocTerms, locTerm, disambig].filter(Boolean).join(' ');
  });
  const base = queryTermsFor(requirements).join(' ') || clean(brief);
  const retrievalHints = ['', 'public profile', 'professional profile', 'leadership profile'];
  const personQueries = unique(variants.map((variant, index) => [variant || base, retrievalHints[index]].filter(Boolean).join(' ')), 4).map((query, index) => ({
    query: query.slice(0, 240).trim(),
    family: 'persona_title' as const,
    intent: 'find_decision_makers' as const,
    expectedSignal: 'Public profile evidence for every hard requirement',
    priority: index + 1,
    lane: 'person' as const,
    providerPreference: index === 0 ? 'tavily' as const : 'corroborate' as const,
    searchDepth: 'basic' as const,
    coveredRequirementIds: requirements.filter(item => item.importance === 'hard').map(item => item.id)
  }));
  const signalQueries = buildSignalLaneQueries(requirements);
  return [...personQueries, ...signalQueries];
}

export const prospectContractSchema = {
  type: Type.OBJECT,
  properties: {
    decompositionMode: { type: Type.STRING },
    authorityRequired: { type: Type.BOOLEAN },
    exclusions: { type: Type.ARRAY, items: { type: Type.STRING } },
    identitySpec: {
      type: Type.OBJECT,
      properties: {
        roles: { type: Type.ARRAY, items: { type: Type.STRING } },
        locations: { type: Type.ARRAY, items: { type: Type.STRING } },
        companyTypes: { type: Type.ARRAY, items: { type: Type.STRING } },
        industries: { type: Type.ARRAY, items: { type: Type.STRING } }
      }
    },
    intentSpec: {
      type: Type.OBJECT,
      properties: {
        toolingKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        hiringSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        painSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        growthSignals: { type: Type.ARRAY, items: { type: Type.STRING } }
      }
    },
    requirements: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          scope: { type: Type.STRING },
          importance: { type: Type.STRING },
          evidenceModality: { type: Type.STRING },
          description: { type: Type.STRING },
          sourcePhrase: { type: Type.STRING },
          acceptableTerms: { type: Type.ARRAY, items: { type: Type.STRING } },
          queryable: { type: Type.BOOLEAN },
          requirementClass: { type: Type.STRING, enum: ['system_invariant', 'identity_hard', 'context_hard', 'evidence_required', 'ranking_signal'] },
          queryHardness: { type: Type.STRING, enum: ['required_in_every_query', 'distributed_across_queries', 'optional_for_queries'] },
          acceptableEvidenceSources: { type: Type.ARRAY, items: { type: Type.STRING, enum: ['linkedin_profile', 'company_website', 'job_postings', 'news_articles', 'social_media'] } },
          groupId: { type: Type.STRING },
          matchRule: { type: Type.STRING, enum: ['all_of', 'any_of'] }
        },
        required: ['scope', 'importance', 'description', 'sourcePhrase', 'acceptableTerms', 'queryable']
      }
    },
    initialQueries: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING },
          family: { type: Type.STRING },
          intent: { type: Type.STRING },
          priority: { type: Type.NUMBER },
          lane: { type: Type.STRING },
          providerPreference: { type: Type.STRING },
          searchDepth: { type: Type.STRING },
          coveredRequirementIds: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ['query']
      }
    }
  },
  required: ['authorityRequired', 'requirements', 'exclusions', 'initialQueries']
};

export const buildProspectContractPrompt = (brief: string, suppliedSpec?: unknown) => `You compile a strict prospecting contract and first retrieval plan.

User brief:
${clean(brief)}

${suppliedSpec ? `User-supplied editable search spec (these are immutable constraints):\n${JSON.stringify(suppliedSpec)}\n\n` : ''}Rules:
- Understand natural conversational phrasing: The brief may start with conversational command phrases like "Find", "Show me", "Search for", "Get me", "Look for", "Bring up", "Give me", "Target", "I want". These are conversational instructions and are NEVER a company name, company type, or requirement source phrase. Ignore them completely.
- Classify decompositionMode as 'single_stream_identity' (for short/simple persona briefs without explicit buying triggers) or 'dual_stream_intent' (for briefs with hiring, tooling, pain, or expansion triggers).
- For dual_stream_intent briefs: decouple identitySpec (roles, locations, companyTypes, industries) from intentSpec (toolingKeywords, hiringSignals, painSignals, growthSignals).
- In person-lane profile discovery queries, include ONLY identity terms (Role + Location + Company Type). NEVER include intent/hiring/tooling trigger words in person-lane queries.
- For open_web_signal / intent requirements (e.g. hiring for n8n, Zapier, Make.com, AI agents, workflow automation), generate dedicated signal-lane queries searching the open web.
- Comma-or-conjunction separated company niches (e.g. "marketing, lead-generation, SEO, or creative agencies") MUST be unified under a single company_type requirement whose acceptableTerms list all distinct expanded forms (e.g. ["marketing agency", "lead-generation agency", "SEO agency", "creative agency"]).
- Multiple requested roles (e.g. "founders, CEOs, or operations directors") MUST be unified into a single person_role requirement with matchRule: "any_of" and groupId: "person_role_group".
- Headcount / employee size ranges (e.g. "with 2 to 15 employees" or "(3 to 20 employees)") MUST be extracted as a company_size requirement with evidenceModality: "inferred" and importance: "soft".
- A hard requirement must be explicitly stated in the user brief or supplied search spec. Its sourcePhrase must be an exact contiguous phrase from the brief when it comes from the brief.
- At most 4 hard requirements (e.g. person_role, company_type, person_location) and at most 5 soft requirements.
- For each requirement, specify evidenceModality: 'structured_profile' for title/role/location/industry, 'open_web_signal' for hiring/funding/technology/pain triggers, 'inferred' for company size.
- acceptableTerms are short alternatives for the same stated requirement, never broader personas.
- Do not use Google dorks, site:, or the word LinkedIn in initialQueries.
- coveredRequirementIds may reference only the returned requirement ids.
Return only the requested JSON.`;

export const buildRecoveryQueryPrompt = (
  contract: ProspectContract,
  diagnostics: { missingHardRequirementIds: string[]; viableCandidates: number; classSummary?: any }
) => {
  let bottleneckGuidance = '';
  if (isFlagEnabled.enhancedDiagnostics() && diagnostics.classSummary?.bottleneckClass) {
    const bClass = diagnostics.classSummary.bottleneckClass;
    if (bClass === 'context_hard') {
      bottleneckGuidance = '\n- Bottleneck identified: Context Hard (Location/Industry/CompanyType). Vary geographic and firmographic acceptable terms while keeping role/persona identity strictly aligned.';
    } else if (bClass === 'identity_hard') {
      bottleneckGuidance = '\n- Bottleneck identified: Identity Hard (Role/Seniority). Vary role/title acceptable terms while keeping firmographics constant.';
    } else if (bClass === 'evidence_required') {
      bottleneckGuidance = '\n- Bottleneck identified: Evidence Required. Focus queries on open-web sources and company profile sites.';
    }
  }

  return `Generate exactly four distinct recovery retrieval queries for this immutable prospect contract.\n\nContract: ${JSON.stringify({ requirements: contract.requirements, exclusions: contract.exclusions })}\n\nRound evidence: ${JSON.stringify(diagnostics)}\n\nRules:\n- Preserve every hard requirement in every query.\n- Recover only the missing hard requirements; do not widen personas, geography, firmographics, or intent.\n- Use only contract terms. Do not use Google dorks, site:, or the word LinkedIn.\n- Vary only the contract's acceptable terms and retrieval phrasing such as public profile or professional profile.${bottleneckGuidance}\n- Return exactly four query objects.`;
};

/** Validate all model output before it influences retrieval. */
export function normalizeProspectContract(
  input: unknown,
  brief: string,
  fallback: ProspectContract
): ProspectContract {
  const raw = input && typeof input === 'object' ? input as Record<string, any> : {};
  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : [];
  const requirements: ProspectRequirement[] = [];
  const scopeCounts = new Map<RequirementScope, number>();
  for (const item of rawRequirements) {
    const scope = clean(item?.scope) as RequirementScope;
    if (!permittedScopes.has(scope)) continue;
    const sourcePhrase = clean(item?.sourcePhrase);
    const importance = item?.importance === 'soft' ? 'soft' : 'hard';
    if (importance === 'hard' && !sourceAppearsInBrief(sourcePhrase, brief)) continue;
    const terms = unique(Array.isArray(item?.acceptableTerms) ? item.acceptableTerms : [sourcePhrase]);
    if (!terms.length || !sourcePhrase) continue;
    const count = scopeCounts.get(scope) || 0;
    scopeCounts.set(scope, count + 1);
    const rawModality = clean(item?.evidenceModality);
    const evidenceModality: EvidenceModality = rawModality === 'open_web_signal' || rawModality === 'inferred' || rawModality === 'structured_profile'
      ? rawModality
      : (scope === 'signal' ? 'open_web_signal' : scope === 'company_size' ? 'inferred' : 'structured_profile');
    
    // Phase 1: Classify requirement deterministically
    let reqClass: RequirementClass = item?.requirementClass;
    if (!reqClass) {
      reqClass = classifyRequirement(scope, importance, sourcePhrase);
    }
    let hardness: QueryHardness = item?.queryHardness;
    if (!hardness) {
      hardness = assignQueryHardness(reqClass);
    }
    
    // Phase 3: Semantic grouping support
    const rawGroupId = clean(item?.groupId);
    const rawMatchRule = item?.matchRule === 'any_of' ? 'any_of' : (item?.matchRule === 'all_of' ? 'all_of' : undefined);

    requirements.push({
      id: clean(item?.id) || requirementId(scope, count),
      scope,
      importance,
      requirementClass: reqClass,
      queryHardness: hardness,
      evidenceModality,
      description: clean(item?.description) || sourcePhrase,
      sourcePhrase,
      acceptableTerms: terms,
      queryable: reqClass === 'system_invariant' ? false : (item?.queryable !== false),
      acceptableEvidenceSources: Array.isArray(item?.acceptableEvidenceSources) ? item.acceptableEvidenceSources : [],
      groupId: rawGroupId || undefined,
      matchRule: rawMatchRule
    });
  }

  const modelHard = requirements.filter(item => item.importance === 'hard');
  const modelSoft = requirements.filter(item => item.importance === 'soft');
  const fallbackHard = fallback.requirements.filter(item => item.importance === 'hard');
  const fallbackSoft = fallback.requirements.filter(item => item.importance === 'soft');

  const hard: ProspectRequirement[] = [];

  // Step 1: Roles from LLM (primary intelligence layer)
  const modelRoleReqs = modelHard.filter(m => m.scope === 'person_role');
  const fallbackRoleReqs = fallbackHard.filter(r => r.scope === 'person_role');

  if (modelRoleReqs.length > 0) {
    const combinedTerms = unique(modelRoleReqs.flatMap(r => r.acceptableTerms));
    const first = modelRoleReqs[0];
    hard.push({
      ...first,
      id: 'person_role-1',
      description: combinedTerms.slice(0, 4).join(' or '),
      acceptableTerms: combinedTerms,
      matchRule: 'any_of',
      groupId: 'person_role_group'
    });
  } else if (fallbackRoleReqs.length > 0) {
    // Emergency supplement: fallback role only if LLM found nothing
    const combinedTerms = unique(fallbackRoleReqs.flatMap(r => r.acceptableTerms));
    const first = fallbackRoleReqs[0];
    hard.push({
      ...first,
      id: 'person_role-1',
      description: combinedTerms.slice(0, 4).join(' or '),
      acceptableTerms: combinedTerms,
      matchRule: 'any_of',
      groupId: 'person_role_group'
    });
  }

  // Step 2: Fill remaining hard slots (up to 4) from LLM modelHard for non-role scopes
  for (const req of modelHard) {
    if (hard.length >= 4) break;
    if (req.scope === 'person_role') continue;
    const existing = hard.find(h => h.scope === req.scope);
    if (existing) {
      existing.acceptableTerms = unique([...existing.acceptableTerms, ...req.acceptableTerms]);
    } else {
      hard.push(req);
    }
  }

  // Step 3: If LLM produced no hard requirements at all, supplement from fallback
  if (hard.length === 0) {
    hard.push(...fallbackHard.slice(0, 4));
  } else {
    // If LLM produced some requirements but missed a location or company type present in fallback,
    // supplement only non-colliding scopes if under the 4-cap
    for (const fbReq of fallbackHard) {
      if (hard.length >= 4) break;
      if (!hard.some(h => h.scope === fbReq.scope)) {
        hard.push(fbReq);
      }
    }
  }

  // Step 4: Soft requirements (LLM primary, fallback supplement)
  const soft: ProspectRequirement[] = [...modelSoft];
  for (const fbSoft of fallbackSoft) {
    if (soft.length >= 5) break;
    if (!soft.some(s => s.scope === fbSoft.scope)) {
      soft.push(fbSoft);
    }
  }

  // Deduplicate requirements so person_role is strictly unified into at most 1 any_of requirement
  const dedupedNormalized: ProspectRequirement[] = [];
  for (const req of [...hard.slice(0, 4), ...soft.slice(0, 5)]) {
    const existing = dedupedNormalized.find(
      item => item.scope === req.scope &&
        (req.scope === 'person_role' || lower(item.sourcePhrase) === lower(req.sourcePhrase))
    );
    if (existing) {
      existing.acceptableTerms = unique([...existing.acceptableTerms, ...req.acceptableTerms]);
      if (req.scope === 'person_role') {
        existing.matchRule = 'any_of';
        existing.groupId = 'person_role_group';
        existing.description = existing.acceptableTerms.slice(0, 4).join(' or ');
      }
    } else {
      if (req.scope === 'person_role') {
        req.matchRule = 'any_of';
        req.groupId = 'person_role_group';
      }
      dedupedNormalized.push(req);
    }
  }
  const normalizedRequirements = dedupedNormalized;
  const exclusions = unique([
    ...(Array.isArray(raw.exclusions) ? raw.exclusions : []),
    ...fallback.exclusions
  ], 30);
  const initial = Array.isArray(raw.initialQueries) ? raw.initialQueries : [];
  const initialQueries = enforceContractQueries(initial, {
    ...fallback,
    requirements: normalizedRequirements,
    exclusions
  });

  const rawMode = clean(raw.decompositionMode);
  const decompositionMode: DecompositionMode =
    rawMode === 'dual_stream_intent' || rawMode === 'single_stream_identity'
      ? rawMode
      : fallback.decompositionMode || detectDecompositionMode(brief);

  const rawIdentity = raw.identitySpec && typeof raw.identitySpec === 'object' ? raw.identitySpec : {};
  const identitySpec: IdentitySpec = {
    roles: Array.isArray(rawIdentity.roles) && rawIdentity.roles.length ? unique(rawIdentity.roles) : fallback.identitySpec?.roles || [],
    locations: Array.isArray(rawIdentity.locations) && rawIdentity.locations.length ? unique(rawIdentity.locations) : fallback.identitySpec?.locations || [],
    companyTypes: Array.isArray(rawIdentity.companyTypes) && rawIdentity.companyTypes.length ? unique(rawIdentity.companyTypes) : fallback.identitySpec?.companyTypes || [],
    industries: Array.isArray(rawIdentity.industries) && rawIdentity.industries.length ? unique(rawIdentity.industries) : fallback.identitySpec?.industries || [],
    seniorities: fallback.identitySpec?.seniorities
  };

  const rawIntent = raw.intentSpec && typeof raw.intentSpec === 'object' ? raw.intentSpec : {};
  const intentSpec: IntentSpec = {
    toolingKeywords: Array.isArray(rawIntent.toolingKeywords) && rawIntent.toolingKeywords.length ? unique(rawIntent.toolingKeywords) : fallback.intentSpec?.toolingKeywords || [],
    hiringSignals: Array.isArray(rawIntent.hiringSignals) && rawIntent.hiringSignals.length ? unique(rawIntent.hiringSignals) : fallback.intentSpec?.hiringSignals || [],
    painSignals: Array.isArray(rawIntent.painSignals) && rawIntent.painSignals.length ? unique(rawIntent.painSignals) : fallback.intentSpec?.painSignals || [],
    growthSignals: Array.isArray(rawIntent.growthSignals) && rawIntent.growthSignals.length ? unique(rawIntent.growthSignals) : fallback.intentSpec?.growthSignals || []
  };

  // Ensure all normalized requirements have Phase 1 fields
  for (const req of normalizedRequirements) {
    if (!req.requirementClass) {
      req.requirementClass = classifyRequirement(req.scope, req.importance, req.sourcePhrase);
    }
    if (!req.queryHardness) {
      req.queryHardness = assignQueryHardness(req.requirementClass);
    }
    if (!req.acceptableEvidenceSources) {
      req.acceptableEvidenceSources = [];
    }
  }
  
  const finalRequirements = normalizedRequirements.length ? normalizedRequirements : fallback.requirements;

  return {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: clean(brief),
    decompositionMode,
    identitySpec,
    intentSpec,
    authorityRequired: Boolean(raw.authorityRequired) || inferredAuthority(finalRequirements),
    requirements: finalRequirements,
    exclusions,
    initialQueries: initialQueries.length ? initialQueries : buildContractFallbackQueries(brief, finalRequirements)
  };
}

const includesAny = (query: string, terms: string[]) => terms.some(term => lower(query).includes(lower(term)));

/** Reject or repair model queries so the retrieval surface cannot drift. */
export function enforceContractQueries(input: unknown, contract: ProspectContract): SearchQueryPlanItem[] {
  const rawItems = Array.isArray(input) ? input : [];
  const exclusions = contract.exclusions.map(lower).filter(Boolean);
  const seen = new Set<string>();
  const hardRequirements = contract.requirements.filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal');
  const intentTerms = new Set([
    ...(contract.intentSpec?.toolingKeywords || []).map(lower),
    ...(contract.intentSpec?.hiringSignals || []).map(lower),
    ...(contract.intentSpec?.painSignals || []).map(lower),
    ...(contract.intentSpec?.growthSignals || []).map(lower)
  ]);
  const normalized: SearchQueryPlanItem[] = [];
  for (const raw of rawItems.slice(0, 6)) {
    const candidate = typeof raw === 'string' ? { query: raw } : raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    let query = clean(candidate.query)
      .replace(/\bsite:[^\s]+/gi, '')
      .replace(/\blinkedin\b/gi, '')
      .replace(/\b(AND|OR|NOT)\b/g, ' ')
      .replace(/[()"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!query || query.length > 240 || exclusions.some(term => term && lower(query).includes(term))) continue;
    const isSignalLane = candidate.lane === 'signal' || candidate.family === 'pain_signal' || candidate.family === 'growth_signal' || candidate.family === 'tooling_signal';
    if (!isSignalLane) {
      if (isFlagEnabled.distributedQuery()) {
        const identityReqs = hardRequirements.filter(r => r.queryHardness === 'required_in_every_query' || r.requirementClass === 'identity_hard');
        const contextReqs = hardRequirements.filter(r => r.queryHardness === 'distributed_across_queries' || r.requirementClass === 'context_hard' || r.requirementClass === 'evidence_required');

        // 1. Identity terms: required in every persona query
        for (const req of identityReqs) {
          if (intentTerms.has(lower(req.sourcePhrase))) continue;
          if (!includesAny(query, req.acceptableTerms)) {
            const addition = req.acceptableTerms[0] || req.sourcePhrase;
            if ((query + ' ' + addition).length <= 240) {
              query = `${query} ${addition}`.trim();
            }
          }
        }

        // 2. Context terms: distributed round-robin across candidate queries
        if (contextReqs.length > 0) {
          const alreadyHasContext = contextReqs.some(cr => includesAny(query, cr.acceptableTerms));
          if (!alreadyHasContext) {
            const ctxReq = contextReqs[normalized.length % contextReqs.length];
            if (!intentTerms.has(lower(ctxReq.sourcePhrase))) {
              const addition = ctxReq.acceptableTerms[0] || ctxReq.sourcePhrase;
              if ((query + ' ' + addition).length <= 240) {
                query = `${query} ${addition}`.trim();
              }
            }
          }
        }
      } else {
        for (const requirement of hardRequirements) {
          if (intentTerms.has(lower(requirement.sourcePhrase))) continue;
          if (!includesAny(query, requirement.acceptableTerms)) {
            if (requirement.scope === 'person_location') {
              // If the query already has any location term from the contract, do not append a conflicting one
              const allLocationTerms = contract.requirements
                .filter(r => r.scope === 'person_location')
                .flatMap(r => r.acceptableTerms);
              if (includesAny(query, allLocationTerms)) continue;
            }
            query = `${query} ${requirement.acceptableTerms[0] || requirement.sourcePhrase}`.trim();
          }
        }
      }
    }
    const key = lower(query);
    if (!query || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      query,
      family: candidate.family,
      intent: candidate.intent,
      expectedSignal: clean(candidate.expectedSignal) || 'Public evidence for hard requirements',
      priority: Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : normalized.length + 1,
      lane: candidate.lane === 'account' || candidate.lane === 'signal' || candidate.lane === 'person' ? candidate.lane : 'person',
      providerPreference: ['tavily', 'brightdata', 'corroborate'].includes(candidate.providerPreference) ? candidate.providerPreference : 'tavily',
      searchDepth: ['basic', 'fast', 'ultra-fast', 'advanced'].includes(candidate.searchDepth) ? candidate.searchDepth : 'basic',
      coveredRequirementIds: isSignalLane
        ? contract.requirements.filter(r => r.importance === 'hard' && (r.evidenceModality === 'open_web_signal' || r.scope === 'signal')).map(r => r.id)
        : hardRequirements.map(requirement => requirement.id)
    });
  }
  // Recovery models sometimes emit a single broad query. Fill that gap with
  // deterministic contract-preserving variants so a thin plan cannot turn a
  // multi-round search into one attempt at a location-only query.
  if (normalized.length < 4) {
    for (const fallback of buildContractFallbackQueries(contract.brief, contract.requirements)) {
      if (normalized.length >= 4) break;
      const key = lower(fallback.query);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(fallback);
    }
  }
  // Also guarantee any hard open_web_signal requirements have their signal queries present
  const signalFallbacks = buildSignalLaneQueries(contract.requirements);
  for (const sigFallback of signalFallbacks) {
    const key = lower(sigFallback.query);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(sigFallback);
    }
  }
  return normalized;
}

export function searchSpecFromProspectContract(base: SearchSpec, contract: ProspectContract): SearchSpec {
  const byScope = (scope: RequirementScope) => contract.requirements
    .filter(requirement => requirement.scope === scope)
    .flatMap(requirement => requirement.acceptableTerms);
  const roles = byScope('person_role');
  const locations = byScope('person_location');
  const industries = byScope('company_industry');
  const companyTypes = byScope('company_type').filter(
    (t) =>
      !/\b(owner|owners|founder|founders|ceo|president|director|directors|executive|executives|vp|head)\b/i.test(t) &&
      !/^(or|and|with|of|at|in|for|from|to)\b|\b(or|and|with|of|at|in|for|from|to)$/i.test(t),
  );
  const signals = byScope('signal');
  return {
    ...base,
    person: {
      ...base.person,
      includeTitles: roles.length ? unique(roles) : base.person.includeTitles,
      locations: locations.length ? unique(locations) : base.person.locations,
      excludeTitles: base.person.excludeTitles
    },
    company: {
      ...base.company,
      industries: industries.length ? unique(industries) : base.company.industries,
      keywords: companyTypes.length ? unique(companyTypes) : base.company.keywords,
      locations: locations.length ? unique(locations) : base.company.locations
    },
    signals: { ...base.signals, include: signals.length ? unique(signals) : base.signals.include }
  };
}

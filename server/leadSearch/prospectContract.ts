import { Type } from '../services/llm.js';
import type { SearchQueryPlanItem, SearchSpec } from './searchSpec.js';
import type { IntentSignalSpec } from './intentSignals.js';

// Bump this whenever normalization changes so old under-specified contracts
// cannot be reused from the SQLite cache.
export const PROSPECT_CONTRACT_POLICY_VERSION = 'evidence-contract-v5';

export type RequirementScope =
  | 'person_role'
  | 'person_location'
  | 'company_type'
  | 'company_industry'
  | 'company_size'
  | 'signal';

export type EvidenceModality = 'structured_profile' | 'open_web_signal' | 'inferred';

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
const unique = (items: string[], max = 8) => Array.from(new Set(items.map(clean).filter(Boolean))).slice(0, max);

const permittedScopes = new Set<RequirementScope>([
  'person_role', 'person_location', 'company_type', 'company_industry', 'company_size', 'signal'
]);

const requirementId = (scope: RequirementScope, index: number) => `${scope}-${index + 1}`;

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
    if (terms.some(t => /\b(owner|owners?|firm owner|agency owner)\b/i.test(t))) {
      expanded.push('founder', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'principal', 'president', 'proprietor');
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
export function buildDeterministicProspectContract(brief: string, spec: SearchSpec): ProspectContract {
  const requirements: ProspectRequirement[] = [];
  const add = (scope: RequirementScope, terms: string[], importance: 'hard' | 'soft' = 'hard') => {
    const accepted = expandAcceptableTerms(scope, includeTerms(terms, brief));
    if (!accepted.length) return;
    requirements.push({
      id: requirementId(scope, requirements.filter(item => item.scope === scope).length),
      scope,
      importance,
      evidenceModality: scope === 'signal' ? 'open_web_signal' : scope === 'company_size' ? 'inferred' : 'structured_profile',
      description: accepted.slice(0, 3).join(' or '),
      sourcePhrase: accepted[0],
      acceptableTerms: accepted,
      queryable: true
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
    requirements.push({
      id: requirementId(scope, requirements.filter(item => item.scope === scope).length),
      scope,
      importance,
      evidenceModality: scope === 'signal' ? 'open_web_signal' : scope === 'company_size' ? 'inferred' : 'structured_profile',
      description: sourcePhrase,
      sourcePhrase,
      acceptableTerms: accepted,
      queryable: true
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

  const rawLocMatch = clean(brief).match(/\b(?:in|near|from)\s+([A-Za-z0-9 ,.'&/-]{1,120})/i)?.[1] || '';
  const extractedLocations = rawLocMatch ? rawLocMatch.split(/,|\band\b|\//).map(s => s.trim()).filter(isCleanRequirementTerm) : [];

  const companyTypeMatch = clean(brief).match(new RegExp('([A-Za-z0-9\\s-]{2,30}?)\\s+(?:' + rolePattern + ')\\b', 'i'))?.[1]?.trim() || '';
  const explicitCompanyKeywords = spec.company.keywords.filter(keyword => lower(keyword) !== lower(brief));
  const ownerMatch = clean(brief).match(/\b(?:firm\s+)?owners?\b/i)?.[0] || '';
  const professionMatch = clean(brief).match(/\b(?:[a-z]+\s+){0,2}(?:lawyers?|attorneys?|dentists?|doctors?|brokers?|accountants?)\b/i)?.[0] || '';
  const firmMatch = clean(brief).match(/\b(?:[a-z]+\s+){0,3}firm\b/i)?.[0] || '';
  const intentMatch = clean(brief).match(/\b(hiring(?:\s+intent)?|recruiting|scaling|funding)\b/i)?.[0] || '';

  // Keep ownership as one requirement even when the user writes "firm owners".
  // The dedicated requirement below carries the useful owner/firm-owner variants.
  const nonOwnershipHints = hintedRoles.filter(term => !/^owners?$/i.test(term));
  add('person_role', [...spec.person.includeTitles, ...nonOwnershipHints]);
  // Singular/plural ownership and professional titles are explicit criteria,
  // even when an LLM omitted them from its contract.
  addWithAlternatives('person_role', ownerMatch, ['owner', 'owners', 'firm owner', 'firm owners']);
  addWithAlternatives('person_role', professionMatch, [professionMatch.replace(/s\b/i, ''), professionMatch.endsWith('s') ? professionMatch : `${professionMatch}s`]);
  add('person_location', [...spec.person.locations, ...spec.company.locations, ...extractedLocations].filter(isCleanRequirementTerm));
  if (firmMatch && isCleanRequirementTerm(firmMatch)) {
    addWithAlternatives('company_type', firmMatch, [firmMatch.replace(/lawyer firm/i, 'law firm')]);
  }
  if (companyTypeMatch && !TITLE_MODIFIER_PATTERN.test(companyTypeMatch) && !/^(with|and|or|in|from|at|the|a|an)$/i.test(companyTypeMatch)) {
    addWithAlternatives('company_type', companyTypeMatch, [companyTypeMatch]);
  }
  add('company_type', explicitCompanyKeywords);
  add('company_industry', spec.company.industries);
  if (intentMatch) {
    addWithAlternatives('signal', intentMatch, ['hiring', 'careers', 'open roles', 'recruiting', 'growing team'], 'soft');
  }
  add('signal', spec.signals.include, 'soft');

  // A brief with no editable spec still needs one non-invented hard target.
  if (!requirements.length && clean(brief)) {
    requirements.push({
      id: 'brief-1',
      scope: 'company_type',
      importance: 'hard',
      evidenceModality: 'structured_profile',
      description: clean(brief),
      sourcePhrase: clean(brief),
      acceptableTerms: [clean(brief)],
      queryable: false
    });
  }

  const exclusions = unique([
    ...spec.person.excludeTitles,
    ...spec.exclusions.companies,
    ...spec.exclusions.domains
  ]);

  // Deduplicate requirements of the same scope that share a sourcePhrase root.
  // This prevents the contract from generating e.g. company_type-1 and company_type-2
  // for the same phrase ("Immigration lawyer firm" appearing twice), which forces
  // candidates to satisfy the same criterion twice simultaneously.
  const deduped: ProspectRequirement[] = [];
  for (const req of requirements) {
    const existing = deduped.find(
      item => item.scope === req.scope &&
        (lower(item.sourcePhrase) === lower(req.sourcePhrase) ||
         lower(item.sourcePhrase).includes(lower(req.sourcePhrase)) ||
         lower(req.sourcePhrase).includes(lower(item.sourcePhrase)))
    );
    if (existing) {
      // Merge acceptableTerms instead of creating a duplicate requirement.
      existing.acceptableTerms = unique([...existing.acceptableTerms, ...req.acceptableTerms]);
    } else {
      deduped.push(req);
    }
  }

  const fallback = buildContractFallbackQueries(brief, deduped);
  const decompositionMode = detectDecompositionMode(brief);
  const identityRoles = unique(deduped.filter(r => r.scope === 'person_role').flatMap(r => r.acceptableTerms));
  const identityLocations = unique(deduped.filter(r => r.scope === 'person_location').flatMap(r => r.acceptableTerms));
  const identityCompanyTypes = unique(deduped.filter(r => r.scope === 'company_type').flatMap(r => r.acceptableTerms));
  const identityIndustries = unique(deduped.filter(r => r.scope === 'company_industry').flatMap(r => r.acceptableTerms));

  const identitySpec: IdentitySpec = {
    roles: identityRoles.length ? identityRoles : spec.person.includeTitles,
    locations: identityLocations.length ? identityLocations : spec.person.locations,
    companyTypes: identityCompanyTypes.length ? identityCompanyTypes : spec.company.keywords,
    industries: identityIndustries.length ? identityIndustries : spec.company.industries,
    seniorities: spec.person.seniorities
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
  requirements: ProspectRequirement[]
): SearchQueryPlanItem[] {
  return requirements
    .filter(r => (r.evidenceModality === 'open_web_signal' || r.scope === 'signal') && r.queryable)
    .map((r, i) => ({
      query: r.acceptableTerms.slice(0, 3).join(' OR ') || r.sourcePhrase,
      family: 'pain_signal' as const,
      intent: 'find_buying_signal' as const,
      expectedSignal: `Open-web evidence corroborating: ${r.description}`,
      priority: i + 1,
      lane: 'signal' as const,
      providerPreference: 'tavily' as const,
      searchDepth: 'basic' as const,
      coveredRequirementIds: [r.id],
      topic: 'general' as const
    }));
}

export function buildContractFallbackQueries(brief: string, requirements: ProspectRequirement[]): SearchQueryPlanItem[] {
  const hardRequirements = requirements.filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal');
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
    return [...nonLocTerms, locTerm].filter(Boolean).join(' ');
  });
  const base = queryTermsFor(requirements).join(' ') || clean(brief);
  const retrievalHints = ['', 'public profile', 'professional profile', 'leadership profile'];
  const personQueries = unique(variants.map((variant, index) => [variant || base, retrievalHints[index]].filter(Boolean).join(' ')), 4).map((query, index) => ({
    query,
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
          queryable: { type: Type.BOOLEAN }
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
- Classify decompositionMode as 'single_stream_identity' (for short/simple persona briefs without explicit buying triggers) or 'dual_stream_intent' (for briefs with hiring, tooling, pain, or expansion triggers).
- For dual_stream_intent briefs: decouple identitySpec (roles, locations, companyTypes, industries) from intentSpec (toolingKeywords, hiringSignals, painSignals, growthSignals).
- In person-lane profile discovery queries, include ONLY identity terms (Role + Location + Company Type). NEVER include intent/hiring/tooling trigger words in person-lane queries.
- For open_web_signal / intent requirements, generate dedicated signal-lane queries searching the open web.
- A hard requirement must be explicitly stated in the user brief or supplied search spec. Its sourcePhrase must be an exact contiguous phrase from the brief when it comes from the brief.
- At most 5 hard and 5 soft requirements. A person role, profession, company type, or location explicitly requested is hard.
- For each requirement, specify evidenceModality: 'structured_profile' for title/role/location/industry, 'open_web_signal' for hiring/funding/technology/pain triggers, 'inferred' for company size.
- acceptableTerms are short alternatives for the same stated requirement, never broader personas.
- Do not use Google dorks, site:, or the word LinkedIn in initialQueries.
- coveredRequirementIds may reference only the returned requirement ids.
Return only the requested JSON.`;

export const buildRecoveryQueryPrompt = (contract: ProspectContract, diagnostics: { missingHardRequirementIds: string[]; viableCandidates: number }) => `Generate exactly four distinct recovery retrieval queries for this immutable prospect contract.\n\nContract: ${JSON.stringify({ requirements: contract.requirements, exclusions: contract.exclusions })}\n\nRound evidence: ${JSON.stringify(diagnostics)}\n\nRules:\n- Preserve every hard requirement in every query.\n- Recover only the missing hard requirements; do not widen personas, geography, firmographics, or intent.\n- Use only contract terms. Do not use Google dorks, site:, or the word LinkedIn.\n- Vary only the contract's acceptable terms and retrieval phrasing such as public profile or professional profile.\n- Return exactly four query objects.`;

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
    requirements.push({
      id: clean(item?.id) || requirementId(scope, count),
      scope,
      importance,
      evidenceModality,
      description: clean(item?.description) || sourcePhrase,
      sourcePhrase,
      acceptableTerms: terms,
      queryable: item?.queryable !== false
    });
  }

  const modelHard = requirements.filter(item => item.importance === 'hard');
  const soft = requirements.filter(item => item.importance === 'soft').slice(0, 5);
  // Cap at 4 hard requirements (down from 5). Satisfying 5 simultaneous hard
  // requirements from a single web search snippet is nearly impossible in
  // practice and causes the entire pipeline to loop to max rounds with 0 yield.
  // The deterministic contract takes precedence over extra model interpretations.
  const hard = fallback.requirements.filter(item => item.importance === 'hard').slice(0, 4);

  // Merge acceptableTerms from modelHard for scopes that already exist in hard
  for (const fallbackReq of hard) {
    const modelMatch = modelHard.find(m => m.scope === fallbackReq.scope);
    if (modelMatch) {
      fallbackReq.acceptableTerms = unique([...fallbackReq.acceptableTerms, ...modelMatch.acceptableTerms]);
    }
  }

  for (const requirement of modelHard) {
    if (hard.length >= 4) break;
    if (!hard.some(item => item.scope === requirement.scope && lower(item.sourcePhrase) === lower(requirement.sourcePhrase))) {
      hard.push(requirement);
    }
  }
  const normalizedRequirements = [...hard.slice(0, 4), ...soft.slice(0, 5)];
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

  return {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: clean(brief),
    decompositionMode,
    identitySpec,
    intentSpec,
    authorityRequired: Boolean(raw.authorityRequired) || inferredAuthority(normalizedRequirements),
    requirements: normalizedRequirements.length ? normalizedRequirements : fallback.requirements,
    exclusions,
    initialQueries: initialQueries.length ? initialQueries : buildContractFallbackQueries(brief, normalizedRequirements.length ? normalizedRequirements : fallback.requirements)
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
    let query = clean(candidate.query).replace(/\bsite:[^\s]+/gi, '').replace(/\blinkedin\b/gi, '').trim();
    if (!query || query.length > 240 || exclusions.some(term => term && lower(query).includes(term))) continue;
    const isSignalLane = candidate.lane === 'signal' || candidate.family === 'pain_signal' || candidate.family === 'growth_signal' || candidate.family === 'tooling_signal';
    if (!isSignalLane) {
      for (const requirement of hardRequirements) {
        if (intentTerms.has(lower(requirement.sourcePhrase))) continue;
        if (!includesAny(query, requirement.acceptableTerms)) {
          query = `${query} ${requirement.acceptableTerms[0] || requirement.sourcePhrase}`.trim();
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
  const companyTypes = byScope('company_type');
  const signals = byScope('signal');
  return {
    ...base,
    person: {
      ...base.person,
      includeTitles: roles.length ? unique(roles) : base.person.includeTitles,
      locations: locations.length ? unique(locations) : base.person.locations,
      excludeTitles: unique([...base.person.excludeTitles, ...contract.exclusions])
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

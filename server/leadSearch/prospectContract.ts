import { Type } from '../services/llm.js';
import type { SearchQueryPlanItem, SearchSpec } from './searchSpec.js';
import type { IntentSignalSpec } from './intentSignals.js';
import { deriveDomainCluster } from './adaptiveScheduler.js';
import { sanitizeQueryText } from './strategist.js';
import { aliasIncludes } from './aliasMap.js';

// Bumped to v9 to invalidate pre-upgrade cached contracts and enforce fresh intelligence compilation
export const PROSPECT_CONTRACT_POLICY_VERSION = 'evidence-contract-v9';

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
  policyVersion: typeof PROSPECT_CONTRACT_POLICY_VERSION | 'evidence-contract-v8' | string;
  brief: string;
  decompositionMode?: DecompositionMode;
  identitySpec?: IdentitySpec;
  intentSpec?: IntentSpec;
  authorityRequired: boolean;
  requirements: ProspectRequirement[];
  exclusions: string[];
  initialQueries: SearchQueryPlanItem[];
  intentSignals?: IntentSignalSpec;
  droppedUngroundedRequirements?: Array<{ phrase: string; scope: string }>;
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
  if (!normalizedPhrase) return false;
  // Exact substring fast path
  if (lower(brief).includes(normalizedPhrase)) return true;
  // Alias-aware grounding: MD<->managing director, US<->united states, VP<->vice president, etc.
  // Prevents silent drops of valid hard requirements expressed as acronyms/paraphrase.
  return aliasIncludes(brief, phrase);
};

const inferredAuthority = (requirements: ProspectRequirement[]) => requirements.some(requirement =>
  requirement.scope === 'person_role' && /\b(owners?|founders?|chief|ceo|president|partners?|vp|vice president|head|directors?|manager)\b/i.test(
    [requirement.description, ...requirement.acceptableTerms].join(' ')
  )
);

const includeTerms = (values: string[], brief: string) => unique(values.filter(value => sourceAppearsInBrief(value, brief)));

export type BusinessArchetype = {
  id: string;
  name: string;
  domainCluster: string;
  defaultRoles: string[];
  mandatoryNegativeFilters: string[];
  companyTypeExpansions: string[];
  roleExpansions: string[];
  exclusions: string[];
  seamDescription: string;
};

export const BUSINESS_ARCHETYPES: Record<string, BusinessArchetype> = {
  b2b_agency: {
    id: 'b2b_agency',
    name: 'B2B Agency & Client Services',
    domainCluster: 'b2b_agency',
    defaultRoles: ['owner', 'owners', 'firm owner', 'agency owner', 'founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'principal', 'president', 'proprietor'],
    mandatoryNegativeFilters: ['-software', '-saas', '-platform', '-recruiter'],
    companyTypeExpansions: [
      'agency', 'agencies', 'consultancy', 'consulting firm', 'services firm', 'solutions provider',
      'advisory firm', 'studio', 'firm', 'partner', 'integrator', 'AI agency', 'AI agencies',
      'AI consultancy', 'AI consulting firm', 'AI services firm', 'AI solutions provider', 'AI advisory firm',
      'AI studio', 'AI marketing agency', 'AI firm', 'artificial intelligence agency', 'AI-powered agency',
      'AI partner', 'AI integrator'
    ],
    roleExpansions: ['owner', 'owners', 'firm owner', 'agency owner', 'founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'principal', 'president', 'proprietor'],
    exclusions: ['Microsoft', 'Google', 'Meta', 'Apple', 'Amazon', 'OpenAI', 'DeepMind', 'Staff Engineer', 'Principal Engineer', 'Principal Product Manager', 'SaaS', 'Software Product', 'recruiter'],
    seamDescription: 'client services required; SaaS/products fail'
  },
  b2b_saas: {
    id: 'b2b_saas',
    name: 'B2B SaaS & Software Platform',
    domainCluster: 'b2b_saas',
    defaultRoles: ['founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'CTO', 'chief technology officer', 'VP Engineering', 'vice president engineering', 'VP Product', 'vice president product'],
    mandatoryNegativeFilters: ['-agency', '-consulting', '-devshop', '-freelance'],
    companyTypeExpansions: ['SaaS', 'software company', 'B2B SaaS', 'software platform', 'cloud software', 'enterprise software', 'software vendor'],
    roleExpansions: ['founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'CTO', 'chief technology officer', 'VP Engineering', 'vice president engineering', 'VP Product', 'vice president product'],
    exclusions: ['agency', 'consulting', 'devshop', 'freelance', 'marketing agency'],
    seamDescription: 'software license/SaaS platform required; agencies/client services fail'
  },
  healthcare_life_sciences: {
    id: 'healthcare_life_sciences',
    name: 'Healthcare & Life Sciences Practice',
    domainCluster: 'healthcare_life_sciences',
    defaultRoles: ['practice owner', 'medical director', 'managing physician', 'clinical director', 'CMO', 'chief medical officer', 'clinic owner', 'doctor', 'physician owner'],
    mandatoryNegativeFilters: ['-software', '-saas', '-staffing', '-nurse', '-billing'],
    companyTypeExpansions: ['medical practice', 'private practice', 'clinic', 'healthcare clinic', 'medical center', 'clinical practice', 'healthcare group'],
    roleExpansions: ['practice owner', 'medical director', 'managing physician', 'clinical director', 'CMO', 'chief medical officer', 'clinic owner', 'doctor', 'physician owner'],
    exclusions: ['software', 'saas', 'staffing', 'nurse', 'billing', 'recruiter', 'healthtech'],
    seamDescription: 'clinical/patient practice required; healthtech SaaS fails company_type'
  },
  professional_services: {
    id: 'professional_services',
    name: 'Professional Services (Legal & Accounting)',
    domainCluster: 'professional_services',
    defaultRoles: ['managing partner', 'equity partner', 'founding partner', 'name partner', 'senior partner', 'partner', 'practice leader', 'owner'],
    mandatoryNegativeFilters: ['-software', '-saas', '-paralegal', '-clerk', '-"law student"'],
    companyTypeExpansions: ['law firm', 'legal practice', 'accounting firm', 'cpa firm', 'tax firm', 'advisory firm', 'consulting firm'],
    roleExpansions: ['managing partner', 'equity partner', 'founding partner', 'name partner', 'senior partner', 'partner', 'practice leader', 'owner'],
    exclusions: ['software', 'saas', 'paralegal', 'clerk', 'law student', 'legaltech'],
    seamDescription: 'licensed firm required; legaltech SaaS fails'
  },
  local_services: {
    id: 'local_services',
    name: 'Local Services & Contracting',
    domainCluster: 'local_services',
    defaultRoles: ['owner', 'owners', 'founder', 'president', 'general manager', 'proprietor'],
    mandatoryNegativeFilters: ['-software', '-saas', '-national', '-franchise'],
    companyTypeExpansions: ['contractor', 'clinic', 'dental practice', 'plumbing company', 'hvac contractor', 'roofing contractor', 'electrical contractor', 'local business'],
    roleExpansions: ['owner', 'owners', 'founder', 'president', 'general manager', 'proprietor'],
    exclusions: ['software', 'saas', 'national', 'franchise', 'marketplace'],
    seamDescription: 'local physical service / contractor; national software/platforms fail'
  },
  manufacturing_industrial: {
    id: 'manufacturing_industrial',
    name: 'Manufacturing & Industrial Operations',
    domainCluster: 'manufacturing_industrial',
    defaultRoles: ['plant manager', 'director of manufacturing', 'VP Operations', 'vice president operations', 'president & owner', 'president', 'owner', 'founder'],
    mandatoryNegativeFilters: ['-software', '-saas', '-retail', '-warehouse'],
    companyTypeExpansions: ['manufacturing company', 'manufacturer', 'fabrication facility', 'industrial plant', 'factory', 'production facility'],
    roleExpansions: ['plant manager', 'director of manufacturing', 'VP Operations', 'vice president operations', 'president & owner', 'president', 'owner', 'founder'],
    exclusions: ['software', 'saas', 'retail', 'warehouse', 'drop shipping'],
    seamDescription: 'physical manufacturing, fabrication, industrial production required'
  },
  executive_coaching: {
    id: 'executive_coaching',
    name: 'Executive Coaching & Advisory',
    domainCluster: 'executive_coaching',
    defaultRoles: ['coach', 'executive coach', 'founder', 'CEO', 'principal consultant', 'managing director', 'practice owner', 'advisor', 'mentor'],
    mandatoryNegativeFilters: ['-recruiter', '-staffing', '-therapy', '-counselor'],
    companyTypeExpansions: ['coaching practice', 'coaching firm', 'advisory firm', 'consultancy', 'executive coaching', 'leadership development', 'mastermind', 'mentorship program'],
    roleExpansions: ['coach', 'executive coach', 'founder', 'CEO', 'principal consultant', 'managing director', 'practice owner', 'advisor', 'mentor'],
    exclusions: ['recruiter', 'staffing', 'therapy', 'counselor', 'life coach', 'fitness coach', 'health coach'],
    seamDescription: 'executive/business coaching required; therapy/life coaching fails'
  },
  ecommerce_retail: {
    id: 'ecommerce_retail',
    name: 'E-Commerce & Retail Brand',
    domainCluster: 'ecommerce_retail',
    defaultRoles: ['founder', 'CEO', 'owner', 'co-founder', 'brand owner', 'head of ecommerce', 'director of ecommerce', 'DTC founder'],
    mandatoryNegativeFilters: ['-developer', '-agency', '-marketplace', '-amazon employee'],
    companyTypeExpansions: ['ecommerce brand', 'DTC brand', 'Shopify store', 'online store', 'retail brand', 'consumer brand', 'e-commerce company', 'apparel brand'],
    roleExpansions: ['founder', 'CEO', 'owner', 'co-founder', 'brand owner', 'head of ecommerce', 'director of ecommerce', 'DTC founder'],
    exclusions: ['developer', 'agency', 'marketplace', 'Amazon employee', 'Shopify employee', 'platform engineer'],
    seamDescription: 'brand/store owner required; platform employees/agencies fail'
  }
};

export function resolveBusinessArchetype(briefOrQuery: string): BusinessArchetype | undefined {
  const cluster = deriveDomainCluster(briefOrQuery);
  if (cluster && BUSINESS_ARCHETYPES[cluster]) {
    return BUSINESS_ARCHETYPES[cluster];
  }
  const text = String(briefOrQuery || '').toLowerCase();
  if (/\b(agency|agencies|consulting|studio|client\s+services)\b/i.test(text)) return BUSINESS_ARCHETYPES.b2b_agency;
  if (/\b(saas|software\s+company|platform)\b/i.test(text)) return BUSINESS_ARCHETYPES.b2b_saas;
  if (/\b(coach|coaching|executive coach|mastermind|mentorship)\b/i.test(text)) return BUSINESS_ARCHETYPES.executive_coaching;
  if (/\b(ecommerce|e-commerce|shopify|d2c|apparel|retail|store|brand)\b/i.test(text)) return BUSINESS_ARCHETYPES.ecommerce_retail;
  if (/\b(medical|clinic|doctor|physician|healthcare)\b/i.test(text)) return BUSINESS_ARCHETYPES.healthcare_life_sciences;
  if (/\b(law\s*firm|attorney|lawyer|cpa|accounting|accounting\s+firm)\b/i.test(text)) return BUSINESS_ARCHETYPES.professional_services;
  if (/\b(manufacturing|industrial|factory|fabrication)\b/i.test(text)) return BUSINESS_ARCHETYPES.manufacturing_industrial;
  if (/\b(plumbing|hvac|roofing|electrician|contractor|dental)\b/i.test(text)) return BUSINESS_ARCHETYPES.local_services;
  return undefined;
}

export const COUNTRY_TO_METROS: Record<string, string[]> = {
  australia: ["Sydney", "Melbourne", "Brisbane", "Perth"],
  au: ["Sydney", "Melbourne", "Brisbane", "Perth"],
  uk: ["London", "Manchester", "Bristol", "Edinburgh", "Birmingham"],
  "united kingdom": ["London", "Manchester", "Bristol", "Edinburgh", "Birmingham"],
  britain: ["London", "Manchester", "Bristol", "Edinburgh", "Birmingham"],
  england: ["London", "Manchester", "Bristol", "Birmingham"],
  canada: ["Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary"],
  usa: ["Austin", "San Francisco", "New York", "Seattle", "Chicago", "Boston", "Denver", "Los Angeles", "Miami"],
  "united states": ["Austin", "San Francisco", "New York", "Seattle", "Chicago", "Boston", "Denver", "Los Angeles", "Miami"],
  us: ["Austin", "San Francisco", "New York", "Seattle", "Chicago", "Boston"],
  america: ["Austin", "San Francisco", "New York", "Seattle", "Chicago", "Boston"],
  "new zealand": ["Auckland", "Wellington", "Christchurch"],
  nz: ["Auckland", "Wellington", "Christchurch"],
  germany: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"],
  german: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"],
  de: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"],
  france: ["Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux"],
  french: ["Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux"],
  fr: ["Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux"],
  netherlands: ["Amsterdam", "Rotterdam", "Utrecht", "Eindhoven"],
  dutch: ["Amsterdam", "Rotterdam", "Utrecht", "Eindhoven"],
  nl: ["Amsterdam", "Rotterdam", "Utrecht", "Eindhoven"],
  ireland: ["Dublin", "Cork", "Galway"],
  irish: ["Dublin", "Cork", "Galway"],
  ie: ["Dublin", "Cork", "Galway"],
  spain: ["Madrid", "Barcelona", "Valencia", "Seville"],
  spanish: ["Madrid", "Barcelona", "Valencia", "Seville"],
  es: ["Madrid", "Barcelona", "Valencia", "Seville"],
  italy: ["Milan", "Rome", "Turin", "Bologna"],
  italian: ["Milan", "Rome", "Turin", "Bologna"],
  it: ["Milan", "Rome", "Turin", "Bologna"],
  switzerland: ["Zurich", "Geneva", "Basel", "Lausanne"],
  swiss: ["Zurich", "Geneva", "Basel", "Lausanne"],
  ch: ["Zurich", "Geneva", "Basel", "Lausanne"],
  sweden: ["Stockholm", "Gothenburg", "Malmo"],
  swedish: ["Stockholm", "Gothenburg", "Malmo"],
  se: ["Stockholm", "Gothenburg", "Malmo"],
  singapore: ["Singapore"],
  sg: ["Singapore"],
  japan: ["Tokyo", "Osaka", "Yokohama"],
  japanese: ["Tokyo", "Osaka", "Yokohama"],
  jp: ["Tokyo", "Osaka", "Yokohama"],
};

export const COUNTRY_CANONICAL_MAP: Record<string, string> = {
  usa: 'USA',
  'united states': 'USA',
  us: 'USA',
  'u.s.': 'USA',
  'u.s.a.': 'USA',
  america: 'USA',
  'united states of america': 'USA',
  uk: 'UK',
  'united kingdom': 'UK',
  britain: 'UK',
  'great britain': 'UK',
  england: 'UK',
  canada: 'Canada',
  canadian: 'Canada',
  australia: 'Australia',
  australian: 'Australia',
  au: 'Australia',
  'new zealand': 'New Zealand',
  newzealand: 'New Zealand',
  nz: 'New Zealand',
  germany: 'Germany',
  german: 'Germany',
  france: 'France',
  french: 'France',
  netherlands: 'Netherlands',
  dutch: 'Netherlands',
  singapore: 'Singapore',
  ireland: 'Ireland',
  irish: 'Ireland',
  spain: 'Spain',
  spanish: 'Spain',
  italy: 'Italy',
  italian: 'Italy',
  switzerland: 'Switzerland',
  swiss: 'Switzerland',
  sweden: 'Sweden',
  swedish: 'Sweden',
  japan: 'Japan',
  japanese: 'Japan',
};

const expandAcceptableTerms = (scope: RequirementScope, terms: string[]): string[] => {
  const expanded = [...terms];
  const hasTerm = (list: string[], matches: string[]) =>
    list.some(t => {
      const lowerT = t.toLowerCase().trim();
      return matches.some(m => {
        const lowerM = m.toLowerCase().trim();
        if (lowerT === lowerM) return true;
        const escaped = lowerM.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        return new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, 'i').test(lowerT);
      });
    });

  if (scope === 'person_location') {
    if (hasTerm(terms, ['usa', 'united states', 'us', 'america'])) {
      expanded.push('USA', 'United States', 'US', 'U.S.', 'America');
      expanded.push('Austin', 'San Francisco', 'New York', 'Seattle', 'Chicago', 'Boston', 'Denver', 'Los Angeles', 'Miami');
    }
    if (hasTerm(terms, ['uk', 'united kingdom', 'britain', 'england'])) {
      expanded.push('UK', 'United Kingdom', 'Britain', 'England');
      expanded.push('London', 'Manchester', 'Bristol', 'Edinburgh', 'Birmingham');
    }
    if (hasTerm(terms, ['canada', 'canadian'])) {
      expanded.push('Canada', 'Canadian');
      expanded.push('Toronto', 'Vancouver', 'Montreal', 'Ottawa', 'Calgary');
    }
    if (hasTerm(terms, ['australia', 'australian', 'au'])) {
      expanded.push('Australia', 'Australian');
      expanded.push('Sydney', 'Melbourne', 'Brisbane', 'Perth');
    }
    if (hasTerm(terms, ['new zealand', 'newzealand', 'nz'])) {
      expanded.push('New Zealand', 'NZ');
      expanded.push('Auckland', 'Wellington', 'Christchurch');
    }
    if (hasTerm(terms, ['germany', 'german', 'de'])) {
      expanded.push('Germany', 'German');
      expanded.push('Berlin', 'Munich', 'Frankfurt', 'Hamburg', 'Cologne', 'Stuttgart');
    }
    if (hasTerm(terms, ['france', 'french', 'fr'])) {
      expanded.push('France', 'French');
      expanded.push('Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux');
    }
    if (hasTerm(terms, ['netherlands', 'dutch', 'nl'])) {
      expanded.push('Netherlands', 'Dutch');
      expanded.push('Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven');
    }
    if (hasTerm(terms, ['ireland', 'irish', 'ie'])) {
      expanded.push('Ireland', 'Irish');
      expanded.push('Dublin', 'Cork', 'Galway');
    }
    if (hasTerm(terms, ['spain', 'spanish', 'es'])) {
      expanded.push('Spain', 'Spanish');
      expanded.push('Madrid', 'Barcelona', 'Valencia', 'Seville');
    }
    if (hasTerm(terms, ['italy', 'italian', 'it'])) {
      expanded.push('Italy', 'Italian');
      expanded.push('Milan', 'Rome', 'Turin', 'Bologna');
    }
    if (hasTerm(terms, ['switzerland', 'swiss', 'ch'])) {
      expanded.push('Switzerland', 'Swiss');
      expanded.push('Zurich', 'Geneva', 'Basel', 'Lausanne');
    }
    if (hasTerm(terms, ['sweden', 'swedish', 'se'])) {
      expanded.push('Sweden', 'Swedish');
      expanded.push('Stockholm', 'Gothenburg', 'Malmo');
    }
    if (hasTerm(terms, ['singapore', 'sg'])) {
      expanded.push('Singapore');
    }
    if (hasTerm(terms, ['japan', 'japanese', 'jp'])) {
      expanded.push('Japan', 'Japanese');
      expanded.push('Tokyo', 'Osaka', 'Yokohama');
    }
  }

  if (scope === 'person_role') {
    if (terms.some(t => /\b(owner|owners?|firm owner|agency owner|founder|founders?|co-?founder|ceo|chief executive officer|president|managing partner|managing director|principal|partner|proprietor)\b/i.test(t))) {
      expanded.push('owner', 'owners', 'firm owner', 'agency owner', 'founder', 'founders', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'principal', 'president', 'proprietor');
    }
    if (terms.some(t => /\b(cto|chief technology officer|vp engineering|vice president engineering|vp product|vice president product)\b/i.test(t))) {
      expanded.push('CTO', 'chief technology officer', 'VP Engineering', 'vice president engineering', 'VP Product', 'vice president product', 'founder', 'co-founder', 'CEO');
    }
    if (terms.some(t => /\b(practice owner|medical director|managing physician|clinical director|cmo|chief medical officer|clinic owner|doctor|physician)\b/i.test(t))) {
      expanded.push('practice owner', 'medical director', 'managing physician', 'clinical director', 'CMO', 'chief medical officer', 'clinic owner', 'doctor', 'physician owner');
    }
    if (terms.some(t => /\b(managing partner|equity partner|founding partner|name partner|senior partner|practice leader)\b/i.test(t))) {
      expanded.push('managing partner', 'equity partner', 'founding partner', 'name partner', 'senior partner', 'partner', 'practice leader', 'owner');
    }
    if (terms.some(t => /\b(plant manager|director of manufacturing|vp operations|vice president operations)\b/i.test(t))) {
      expanded.push('plant manager', 'director of manufacturing', 'VP Operations', 'vice president operations', 'president & owner', 'president', 'owner', 'founder');
    }
  }

  if (scope === 'company_type' || scope === 'company_industry') {
    if (terms.some(t => /\b(agenc|firm|consult|service|solution|advisory|studio|partner|integrat|business|provider)/i.test(t))) {
      const isAI = terms.some(t => /\b(ai|artificial intelligence|machine learning|ml)\b/i.test(t));
      if (isAI) {
        expanded.push(
          'AI agency',
          'AI agencies',
          'AI consultancy',
          'AI consulting firm',
          'AI services firm',
          'AI solutions provider',
          'AI advisory firm',
          'AI studio',
          'AI marketing agency',
          'AI firm',
          'artificial intelligence agency',
          'AI-powered agency',
          'AI partner',
          'AI integrator'
        );
      } else {
        expanded.push(
          'agency',
          'agencies',
          'consultancy',
          'consulting firm',
          'services firm',
          'solutions provider',
          'advisory firm',
          'studio',
          'firm',
          'partner',
          'integrator'
        );
      }
    }
    if (terms.some(t => /\b(saas|software|platform|cloud\s+software)\b/i.test(t))) {
      expanded.push('SaaS', 'software company', 'B2B SaaS', 'software platform', 'cloud software', 'enterprise software', 'software vendor');
    }
    if (terms.some(t => /\b(clinic|medical|healthcare|hospital|practice|dental)\b/i.test(t))) {
      expanded.push('medical practice', 'private practice', 'clinic', 'healthcare clinic', 'medical center', 'clinical practice', 'healthcare group');
    }
    if (terms.some(t => /\b(law\s*firm|legal|attorney|accounting|cpa|tax\s*firm)\b/i.test(t))) {
      expanded.push('law firm', 'legal practice', 'accounting firm', 'cpa firm', 'tax firm', 'advisory firm', 'consulting firm');
    }
    if (terms.some(t => /\b(manufacturing|industrial|manufacturer|fabrication|factory|production\s+plant)\b/i.test(t))) {
      expanded.push('manufacturing company', 'manufacturer', 'fabrication facility', 'industrial plant', 'factory', 'production facility');
    }
    if (terms.some(t => /\b(contractor|plumbing|hvac|roofing|electrician)\b/i.test(t))) {
      expanded.push('contractor', 'clinic', 'dental practice', 'plumbing company', 'hvac contractor', 'roofing contractor', 'electrical contractor', 'local business');
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

export function isAgencyContract(contractOrBrief: ProspectContract | string): boolean {
  if (!contractOrBrief) return false;
  const text = typeof contractOrBrief === 'string'
    ? contractOrBrief
    : `${contractOrBrief.brief || ''} ${(contractOrBrief.requirements || []).map(r => `${r.description} ${r.acceptableTerms?.join(' ') || ''}`).join(' ')}`;
  return /\b(agenc(y|ies)?|consultan(cy|cies|t|ts)?|consulting|studios?|integrat(or|ors)?|client\s+services?|advisory\s+firm)\b/i.test(text);
}

export const TOOL_LEXICONS_BY_CLUSTER: Record<string, RegExp> = {
  b2b_agency: /\b(n8n|zapier|make|hubspot|salesforce|supabase|airtable|notion|clickup|monday|asana|trello|slack|go\s?high\s?level|ghl|semrush|ahrefs|google\s?ads|meta\s?ads|mailchimp|activecampaign|klaviyo|figma|canva|webflow|wordpress)\b/i,
  b2b_saas: /\b(react|python|aws|gcp|azure|docker|kubernetes|terraform|datadog|stripe|segment|amplitude|mixpanel|postman|github|gitlab|jira|confluence|vercel|netlify|supabase|firebase)\b/i,
  executive_coaching: /\b(calendly|zoom|loom|kajabi|teachable|thinkific|circle|mighty\s?networks|convertkit|beehiiv|substack|notion|clickup)\b/i,
  ecommerce_retail: /\b(shopify|woocommerce|magento|bigcommerce|klaviyo|attentive|gorgias|recharge|skio|stamped|yotpo|aftership|shipbob|deliverr|amazon\s?seller|google\s?merchant)\b/i,
  healthcare_life_sciences: /\b(epic|cerner|athenahealth|drchrono|practice\s?fusion|kareo|nextgen|allscripts|meditech|veeva)\b/i,
  professional_services: /\b(clio|mycase|smokeball|practice\s?panther|bill4time|timeslips|quickbooks|xero|sage|thomson\s?reuters|lexisnexis|westlaw)\b/i,
  local_services: /\b(jobber|housecall\s?pro|servicetitan|fieldedge|successware|quickbooks|freshbooks|square|clover|yelp)\b/i,
  manufacturing_industrial: /\b(sap|oracle|epicor|infor|netsuite|syspro|plex|procore|autodesk|solidworks|mastercam)\b/i,
};

export const UNIVERSAL_TOOLS_REGEX = /\b(n8n|zapier|make|hubspot|salesforce|airtable|notion|slack|google\s?sheets|excel|power\s?bi|tableau|chatgpt|openai|anthropic|claude|python|aws)\b/i;

export function isRecognizedTool(term: string, cluster?: string): boolean {
  if (UNIVERSAL_TOOLS_REGEX.test(term)) return true;
  if (cluster && TOOL_LEXICONS_BY_CLUSTER[cluster]?.test(term)) return true;
  for (const regex of Object.values(TOOL_LEXICONS_BY_CLUSTER)) {
    if (regex.test(term)) return true;
  }
  return false;
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
    if (!sourceAppearsInBrief(sourcePhrase, brief)) {
      if (importance === 'hard') {
        console.warn(`[prospectContract] Dropping ungrounded hard requirement "${sourcePhrase}" (${scope}) not in brief.`);
      }
      return;
    }
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

  const ROLE_WORDS_PATTERN = /\b(owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i;
  const CONJUNCTION_STOP_PATTERN = /^(?:or|and|with|of|at|in|for|from|to|a|an|the|by|who|which)\b|\b(?:or|and|with|of|at|in|for|from|to|a|an|the|by|who|which)$/i;
  const COMPANY_TITLE_PREFIX_PATTERN = /^(?:managing|senior|junior|lead|principal|chief|executive|vp|vice|deputy|head|director|directors|founder|owner|ceo|president)\b/i;

  const ACTION_VERB_PREFIX_PATTERN = /^(?:find|search|get|locate|look\s+for|target|identify|seek|discover|show\s+me|give\s+me|i\s+want(?:\s+to)?|i\s+need(?:\s+to)?)\s+/i;
  const ACTION_VERB_ALONE_PATTERN = /^(?:find|search|get|locate|look|target|identify|seek|discover|show|want|need)$/i;

  const isCleanCompanyTypeTerm = (value: unknown): boolean => {
    const v = clean(value);
    if (!v || v.length < 2 || v.length > 48) return false;
    if (ROLE_WORDS_PATTERN.test(v)) return false;
    if (CONJUNCTION_STOP_PATTERN.test(v)) return false;
    if (COMPANY_TITLE_PREFIX_PATTERN.test(v)) return false;
    if (JUNK_TERM_PATTERN.test(v)) return false;
    if (ACTION_VERB_ALONE_PATTERN.test(v)) return false;
    return true;
  };

  const rawLocMatch = clean(brief).match(/\b(?:in|near|from)\s+([A-Za-z0-9 ,.'&/-]{1,120}?)(?=\s+\b(?:with|seeking|having|who|where|that|using|for)\b|[.,;]|$)/i)?.[1] || '';
  const extractedLocations = rawLocMatch ? rawLocMatch.split(/,|\band\b|\bor\b|\//).map(s => s.trim().replace(CONJUNCTION_STOP_PATTERN, '').trim()).filter(isCleanRequirementTerm) : [];

  // Pattern A: Prepositional Postfix "[Role] of/at/in/for (a/an)? [Company Type]"
  // e.g. "Founder or owner of a marketing agency with 5-50 employees" -> "marketing agency"
  const prepCompanyMatch = clean(brief).match(/\b(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b\s+(?:of|at|in|for)\s+(?:an?\s+)?([^,.]+?)(?=\s+(?:with|in|near|from|located|who|having|\d+|,|\.|$))/i)?.[1]?.trim() || '';

  // Pattern B: Direct Prefix "[Company Type] [Role]"
  // e.g. "AI agency owner" -> "AI agency"
  const rawPrefixMatch = clean(brief).match(/\b([^,.]+?)\s+(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i)?.[1]?.trim() || '';
  const prefixCompanyMatch = rawPrefixMatch.replace(ACTION_VERB_PREFIX_PATTERN, '').trim();

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

  const extractedCompanyTypes: string[] = [];
  const addCompanyType = (t: string) => {
    const cleaned = clean(t).replace(/\s+(?:in|near|from|located\s+in)\s+.*$/i, '').trim();
    if (cleaned && isCleanCompanyTypeTerm(cleaned) && !extractedCompanyTypes.includes(cleaned)) {
      extractedCompanyTypes.push(cleaned);
    }
  };

  if (prepCompanyMatch && isCleanCompanyTypeTerm(prepCompanyMatch)) {
    for (const sub of prepCompanyMatch.split(/,|\band\b|\bor\b/i).map(s => s.trim())) {
      addCompanyType(sub);
    }
    addCompanyType(prepCompanyMatch);
  }
  if (prefixCompanyMatch && isCleanCompanyTypeTerm(prefixCompanyMatch)) {
    for (const sub of prefixCompanyMatch.split(/,|\band\b|\bor\b/i).map(s => s.trim())) {
      addCompanyType(sub);
    }
    addCompanyType(prefixCompanyMatch);
  }
  if (firmMatch && isCleanCompanyTypeTerm(firmMatch)) {
    addCompanyType(firmMatch.replace(/lawyer firm/i, 'law firm'));
  }

  const roleStopRegex = /\b(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i;
  for (const segment of clean(brief).split(/,|\band\b|\bor\b/i).map(s => s.trim())) {
    if (!segment) continue;
    const rawPrefix = segment.match(/\b([^,.]+?)\s+(?:owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/i)?.[1]?.trim();
    const prefix = rawPrefix ? rawPrefix.replace(ACTION_VERB_PREFIX_PATTERN, '').trim() : '';
    const cleanSegment = segment.replace(ACTION_VERB_PREFIX_PATTERN, '').trim();
    if (prefix) {
      addCompanyType(prefix);
    } else if (cleanSegment && !roleStopRegex.test(cleanSegment)) {
      addCompanyType(cleanSegment);
    }
  }

  const primaryCompanyType = extractedCompanyTypes[0] || prefixCompanyMatch || prepCompanyMatch || firmMatch;
  if (primaryCompanyType && isCleanCompanyTypeTerm(primaryCompanyType)) {
    addWithAlternatives('company_type', primaryCompanyType, extractedCompanyTypes);
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

  // Extract recognized tools from the brief into soft signal requirements
  const detectedBriefTools: string[] = [];
  const wordsInBrief = clean(brief).split(/[\s,()]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
  const clusterForTools = deriveDomainCluster(brief);
  for (const w of wordsInBrief) {
    if (isRecognizedTool(w, clusterForTools) && !detectedBriefTools.includes(w)) {
      detectedBriefTools.push(w);
    }
  }
  if (detectedBriefTools.length > 0) {
    for (const tool of detectedBriefTools) {
      addWithAlternatives('signal', tool, [tool], 'soft');
    }
  }

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

  const archetype = resolveBusinessArchetype(brief);
  const isAgency = isAgencyContract(brief) || archetype?.id === 'b2b_agency';
  const defaultExclusions = archetype
    ? archetype.exclusions.filter(e => !e.startsWith('-'))
    : isAgency
      ? ['Microsoft', 'Google', 'Meta', 'Apple', 'Amazon', 'OpenAI', 'DeepMind', 'Staff Engineer', 'Principal Engineer', 'Principal Product Manager', 'SaaS', 'Software Product']
      : [];

  const exclusions = unique([
    ...defaultExclusions,
    ...(spec?.person?.excludeTitles || []),
    ...(spec?.exclusions?.companies || []),
    ...(spec?.exclusions?.domains || [])
  ].filter(e => !e.startsWith('-')));

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

  const domainCluster = deriveDomainCluster(brief);
  const intentSpec: IntentSpec = {
    toolingKeywords: intentTerms.filter(t => isRecognizedTool(t, domainCluster)),
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

export const ATS_SEARCH_DOMAINS = [
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
] as const;

export function buildAtsLaneQueries(
  _brief: string,
  requirements: ProspectRequirement[],
  identitySpec?: IdentitySpec
): SearchQueryPlanItem[] {
  const roleTerms = identitySpec?.roles?.slice(0, 2) ||
    requirements
      .filter(r => r.scope === 'person_role')
      .flatMap(r => r.acceptableTerms.slice(0, 2));

  const contextTerms = identitySpec?.companyTypes?.slice(0, 1) ||
    identitySpec?.industries?.slice(0, 1) ||
    requirements
      .filter(r => r.scope === 'company_type' || r.scope === 'company_industry')
      .flatMap(r => r.acceptableTerms.slice(0, 1));

  const role = roleTerms[0] || 'Software Engineer';
  const context = contextTerms[0] || '';

  const atsSiteUnion = '(site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:apply.workable.com)';
  const rawQuery = `${atsSiteUnion} "${role}" ${context}`.trim();

  return [{
    query: rawQuery.slice(0, 240),
    family: 'growth_signal' as const,
    intent: 'find_buying_signal' as const,
    expectedSignal: `Live ATS job requisitions on Greenhouse, Lever, Ashby, or Workable for ${role}`,
    priority: 1,
    lane: 'signal' as const,
    providerPreference: 'tavily' as const,
    searchDepth: 'basic' as const,
    coveredRequirementIds: requirements.filter(r => r.scope === 'signal' || r.scope === 'person_role').map(r => r.id),
    topic: 'general' as const,
  }];
}

export const includesAny = (query: string, terms: string[]) => terms.some(term => lower(query).includes(lower(term)));

export function computeCoveredRequirementIds(
  query: string,
  requirements: ProspectRequirement[],
  isSignalLane: boolean = false
): string[] {
  if (isSignalLane) {
    return requirements
      .filter(r => (r.evidenceModality === 'open_web_signal' || r.scope === 'signal'))
      .filter(r => includesAny(query, r.acceptableTerms) || r.importance === 'hard')
      .map(r => r.id);
  }

  const queryLower = lower(query);
  return requirements
    .filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal')
    .filter(req => {
      if (includesAny(queryLower, req.acceptableTerms)) return true;
      if (req.scope === 'person_location') {
        for (const term of req.acceptableTerms) {
          const cleanTerm = term.toLowerCase().trim();
          const metros = COUNTRY_TO_METROS[cleanTerm];
          if (metros && includesAny(queryLower, metros)) return true;
        }
      }
      return false;
    })
    .map(req => req.id);
}

export function buildContractFallbackQueries(
  brief: string,
  requirements: ProspectRequirement[],
  identitySpec?: IdentitySpec
): SearchQueryPlanItem[] {
  const isAgencyBrief = isAgencyContract(brief) ||
    requirements.some(r => (r.scope === 'company_type' || r.scope === 'company_industry') && isAgencyContract(`${r.description} ${r.acceptableTerms.join(' ')}`));
  const agencyDisambiguation = isAgencyBrief ? '-software -platform -SaaS' : '';

  // Extract single roles (e.g. founder, owner, CEO, managing director)
  const roleReqs = requirements.filter(r => r.scope === 'person_role');
  const extractedRoles = unique(roleReqs.flatMap(r => r.acceptableTerms || []));
  const defaultRoles = ['founder', 'owner', 'CEO', 'managing director'];
  const roles = extractedRoles.length > 0 ? extractedRoles : defaultRoles;

  // Extract single locations / geos / metros. Zero default-invention:
  // when no geo is mentioned, locations stay empty (global search).
  const locReqs = requirements.filter(r => r.scope === 'person_location');
  const extractedLocations = unique(locReqs.flatMap(r => r.acceptableTerms || []));
  const defaultLocations: string[] = [];

  // Detect distinct geopolitical countries mentioned in requirements or brief
  const detectedCountries: string[] = [];
  const seenCountryKeys = new Set<string>();

  for (const loc of extractedLocations) {
    const cleanLoc = loc.trim().toLowerCase();
    const canonical = COUNTRY_CANONICAL_MAP[cleanLoc];
    if (canonical && !seenCountryKeys.has(canonical.toLowerCase())) {
      seenCountryKeys.add(canonical.toLowerCase());
      detectedCountries.push(canonical);
    }
  }

  const briefLower = (brief || '').toLowerCase();
  for (const [key, canonical] of Object.entries(COUNTRY_CANONICAL_MAP)) {
    const escapedKey = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const keyRegex = new RegExp(`(^|[^a-zA-Z0-9])${escapedKey}([^a-zA-Z0-9]|$)`, 'i');
    if (!seenCountryKeys.has(canonical.toLowerCase()) && keyRegex.test(briefLower)) {
      seenCountryKeys.add(canonical.toLowerCase());
      detectedCountries.push(canonical);
    }
  }

  // Deduplicate synonym terms (e.g. don't keep United States if USA is present)
  const deduplicatedLocations: string[] = [];
  const seenDedupe = new Set<string>();
  for (const loc of extractedLocations) {
    const cleanLoc = loc.trim().toLowerCase();
    const canonical = COUNTRY_CANONICAL_MAP[cleanLoc] || cleanLoc;
    if (!seenDedupe.has(canonical.toLowerCase())) {
      seenDedupe.add(canonical.toLowerCase());
      deduplicatedLocations.push(loc);
    }
  }

  const locations = detectedCountries.length >= 2
    ? detectedCountries
    : (deduplicatedLocations.length > 0 ? deduplicatedLocations : defaultLocations);
  const hasGeo = locations.length > 0;

  // Extract core vertical / company type term (e.g. "AI agency")
  const compReq = requirements.find(r => r.scope === 'company_type' || r.scope === 'company_industry');
  let rawVertical = compReq?.acceptableTerms?.[0] || compReq?.sourcePhrase;
  if (!rawVertical) {
    if (isAgencyBrief) {
      rawVertical = 'AI agency';
    } else {
      const cleanedBrief = clean(brief)
        .replace(/^(?:find|search|get|locate|look\s+for|target|identify|seek|discover|show\s+me|give\s+me|i\s+want(?:\s+to)?|i\s+need(?:\s+to)?)\s+/i, '')
        .replace(/\b(?:with\s+)?(?:valid\s+)?(?:linkedin\s+)?(?:profile\s+)?urls?\b/gi, '')
        .replace(/\b(?:duplicate|profile\s+validity)\b/gi, '')
        .replace(/\b(owner|owners|founder|founders|co-founder|cofounder|ceo|president|partner|partners|director|directors|executive|executives|vp|head)\b/gi, '')
        .replace(/\b(?:with|in|at|of|for|from|to|near)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      rawVertical = cleanedBrief || '';
    }
  }
  const vertical = rawVertical && rawVertical.includes(' ') && !rawVertical.startsWith('"')
    ? `"${rawVertical}"`
    : rawVertical;

  // Generate Cartesian grid of single roles x single locations (global when no geo).
  // Global mode varies by role + discovery modifier to keep 4 unique queries
  // (role cycling alone collapses to 2 when roles=2 and loc='').
  const globalModifiers = ['', 'leadership', 'portfolio', 'team'];
  const gridQueries: string[] = [];
  const maxPairs = 4;
  for (let i = 0; i < maxPairs; i++) {
    const role = roles[i % roles.length];
    const loc = hasGeo ? locations[i % locations.length] : globalModifiers[i % globalModifiers.length];
    const parts = [vertical, role, loc].filter(Boolean);
    let baseQuery = parts.join(' ');
    if (isAgencyBrief && agencyDisambiguation) {
      if ((baseQuery + ' ' + agencyDisambiguation).length <= 240) {
        baseQuery = `${baseQuery} ${agencyDisambiguation}`;
      }
    }
    // Clean up any stray Big Tech negatives (these belong strictly in deterministic qualification)
    baseQuery = baseQuery.replace(/-(?:microsoft|google|meta|apple|amazon|openai|deepmind)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    gridQueries.push(baseQuery);
  }

  const personQueries = unique(gridQueries, 4).map((query, index) => ({
    query: query.slice(0, 240).trim(),
    family: 'persona_title' as const,
    intent: 'find_decision_makers' as const,
    expectedSignal: 'Public profile evidence for distributed hard requirements',
    priority: index + 1,
    lane: 'person' as const,
    providerPreference: index === 0 ? 'tavily' as const : 'corroborate' as const,
    searchDepth: 'basic' as const,
    coveredRequirementIds: computeCoveredRequirementIds(query, requirements, false)
  }));
  const signalQueries = buildSignalLaneQueries(requirements, identitySpec);
  const hasHiringTrigger = /\b(hiring|jobs?|engineer|developer|recruit|growth|headcount|roles?|team|expanding)\b/i.test(brief) || requirements.some(r => r.scope === 'signal');
  const atsQueries = hasHiringTrigger ? buildAtsLaneQueries(brief, requirements, identitySpec) : [];
  return [...personQueries, ...signalQueries, ...atsQueries];
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
- When the brief describes active behavior or buying triggers (posting on LinkedIn, seeking help, needing a hand, bottlenecks, evaluating tools, hiring), ALWAYS emit at least one soft requirement with scope 'signal' and evidenceModality 'open_web_signal' capturing those triggers. Never leave a dual_stream_intent brief with zero signal requirements.
- Comma-or-conjunction separated company niches (e.g. "marketing, lead-generation, SEO, or creative agencies") MUST be unified under a single company_type requirement whose acceptableTerms list all distinct expanded forms (e.g. ["marketing agency", "lead-generation agency", "SEO agency", "creative agency"]).
- When targeting agencies, consultancies, studios, or client services: enforce a strict hard seam against software products. Exclude non-agency employers (Big Tech: Microsoft, Google, Meta, Apple, Amazon, OpenAI), individual contributor roles (Staff/Principal Engineer, Product Manager), and pure software products/SaaS/apps. Ensure company_type acceptableTerms specify client services firms.
- Multiple requested roles (e.g. "founders, CEOs, or operations directors") MUST be unified into a single person_role requirement with matchRule: "any_of" and groupId: "person_role_group".
- Headcount / employee size ranges (e.g. "with 2 to 15 employees" or "(3 to 20 employees)") MUST be extracted as a company_size requirement with evidenceModality: "inferred" and importance: "soft".
- A hard requirement must be explicitly stated in the user brief or supplied search spec. Its sourcePhrase must be an exact contiguous phrase from the brief when it comes from the brief.
- At most 4 hard requirements (e.g. person_role, company_type, person_location) and at most 7 soft requirements.
- For each requirement, specify evidenceModality: 'structured_profile' for title/role/location/industry, 'open_web_signal' for hiring/funding/technology/pain triggers, 'inferred' for company size.
- acceptableTerms are short alternatives for the same stated requirement, never broader personas.
- Strict single-role and single-geo query constraint: Each query in initialQueries must target EXACTLY ONE role (e.g. founder OR CEO OR owner) and at most ONE location/metro (e.g. Australia OR London). NEVER concatenate multiple synonym roles in a single query (e.g. FORBIDDEN: 'owner founder CEO managing director'). Distribute different roles and locations across distinct queries instead.
- Queries in initialQueries must NEVER contain negative exclusion operators (e.g. -Microsoft, -Google, -software, -SaaS). Exclusions belong strictly in the contract exclusions list, not in search queries.
- Do not use Google dorks, site:, or the word LinkedIn in initialQueries.
- coveredRequirementIds may reference only the returned requirement ids.
Return only the requested JSON.`;

export const buildRecoveryQueryPrompt = (
  contract: ProspectContract,
  diagnostics: { missingHardRequirementIds: string[]; viableCandidates: number; classSummary?: any; observedNonMatchingAttributes?: any }
) => {
  let bottleneckGuidance = '';
  if (diagnostics.classSummary?.bottleneckClass) {
    const bClass = diagnostics.classSummary.bottleneckClass;
    if (bClass === 'context_hard') {
      bottleneckGuidance = '\n- Bottleneck identified: Context Hard (Location/Industry/CompanyType). Vary geographic and firmographic acceptable terms and synonym phrasing while keeping role/persona identity strictly aligned.';
    } else if (bClass === 'identity_hard') {
      bottleneckGuidance = '\n- Bottleneck identified: Identity Hard (Role/Seniority). Vary role/title acceptable terms and equivalent leadership phrasing while keeping firmographics constant.';
    } else if (bClass === 'evidence_required') {
      bottleneckGuidance = '\n- Bottleneck identified: Evidence Required. Focus queries on open-web sources and company profile sites.';
    }
  }

  let observedContext = '';
  if (diagnostics.observedNonMatchingAttributes?.locations?.length) {
    observedContext += `\n- Observed non-matching locations in prior round: [${diagnostics.observedNonMatchingAttributes.locations.slice(0, 5).join(', ')}]. Steer queries towards target contract locations.`;
  }
  if (diagnostics.observedNonMatchingAttributes?.roles?.length) {
    observedContext += `\n- Observed candidate titles in prior round: [${diagnostics.observedNonMatchingAttributes.roles.slice(0, 5).join(', ')}]. Steer queries towards target authority titles.`;
  }

  return `Generate exactly four distinct recovery retrieval queries for this immutable prospect contract.\n\nContract: ${JSON.stringify({ requirements: contract.requirements, exclusions: contract.exclusions })}\n\nRound evidence: ${JSON.stringify(diagnostics)}${observedContext}\n\nRules:\n- Preserve every hard requirement in every query.\n- Recover missing hard requirements using contract terms, semantic synonyms, and adjacent B2B taxonomy to break through bottlenecks.\n- Do not use Google dorks, site:, or the word LinkedIn.\n- Vary acceptable terms, industry synonyms, and retrieval phrasing such as public profile or professional profile.${bottleneckGuidance}\n- Return exactly four query objects.`;
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
  const droppedUngroundedRequirements: Array<{ phrase: string; scope: string }> = [];
  for (const item of rawRequirements) {
    const scope = clean(item?.scope) as RequirementScope;
    if (!permittedScopes.has(scope)) continue;
    const sourcePhrase = clean(item?.sourcePhrase);
    const importance = item?.importance === 'soft' ? 'soft' : 'hard';
    if (importance === 'hard' && !sourceAppearsInBrief(sourcePhrase, brief)) {
      console.warn(`[prospectContract] Dropping ungrounded hard requirement "${sourcePhrase}" (${scope}) from LLM contract not in brief.`);
      droppedUngroundedRequirements.push({ phrase: sourcePhrase, scope });
      continue;
    }
    const rawTerms = unique(Array.isArray(item?.acceptableTerms) ? item.acceptableTerms : [sourcePhrase]);
    const terms = expandAcceptableTerms(scope, rawTerms);
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
    const locReq = hard.find(h => h.scope === 'person_location');
    const fbLocReq = fallbackHard.find(h => h.scope === 'person_location');
    if (locReq && fbLocReq) {
      locReq.acceptableTerms = unique([...locReq.acceptableTerms, ...fbLocReq.acceptableTerms]);
    }
  }

  // Step 4: Soft requirements (LLM primary, fallback supplement) with theme-merge overflow
  const soft: ProspectRequirement[] = [];
  for (const req of modelSoft) {
    if (soft.length < 7) {
      soft.push(req);
    } else {
      // Merge overflow into existing requirement of the same scope
      const match = soft.find(s => s.scope === req.scope);
      if (match) {
        match.acceptableTerms = unique([...match.acceptableTerms, ...req.acceptableTerms]);
      }
    }
  }

  for (const fbSoft of fallbackSoft) {
    if (soft.length >= 7) {
      const match = soft.find(s => s.scope === fbSoft.scope);
      if (match) {
        match.acceptableTerms = unique([...match.acceptableTerms, ...fbSoft.acceptableTerms]);
      }
      continue;
    }
    if (!soft.some(s => s.scope === fbSoft.scope)) {
      soft.push(fbSoft);
    }
  }

  // Deduplicate requirements so person_role and person_location are strictly unified
  const dedupedNormalized: ProspectRequirement[] = [];
  for (const req of [...hard.slice(0, 4), ...soft.slice(0, 7)]) {
    const existing = dedupedNormalized.find(
      item => item.scope === req.scope &&
        (req.scope === 'person_role' || req.scope === 'person_location' || lower(item.sourcePhrase) === lower(req.sourcePhrase))
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

  // Backstop: a brief with buying-intent language but zero signal requirements
  // would otherwise judge on identity alone and fill the target with
  // intent-less leads. Synthesize one soft open_web_signal requirement from
  // the merged intentSpec so the judge scores intent (qualified_partial +
  // discount for uncorroborated signals) and signal-lane queries generate.
  const hasSignalReq = finalRequirements.some(
    (r) => r.scope === "signal" || r.evidenceModality === "open_web_signal",
  );
  const intentTerms = unique([
    ...intentSpec.toolingKeywords,
    ...intentSpec.hiringSignals,
    ...intentSpec.painSignals,
    ...intentSpec.growthSignals,
  ])
    .filter((t) => t && t.length <= 48)
    .slice(0, 12);
  if (!hasSignalReq && intentTerms.length > 0) {
    const signalClass = classifyRequirement("signal", "soft", intentTerms[0]);
    finalRequirements.push({
      id: requirementId(
        "signal",
        finalRequirements.filter((r) => r.scope === "signal").length,
      ),
      scope: "signal",
      importance: "soft",
      requirementClass: signalClass,
      queryHardness: assignQueryHardness(signalClass),
      evidenceModality: "open_web_signal",
      description: `shows active buying-intent signals (${intentTerms.slice(0, 4).join(", ")})`,
      sourcePhrase: intentTerms[0],
      acceptableTerms: expandAcceptableTerms("signal", intentTerms),
      queryable: signalClass !== "system_invariant",
      acceptableEvidenceSources: [],
    });
  }

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
    initialQueries: initialQueries.length ? initialQueries : buildContractFallbackQueries(brief, finalRequirements),
    droppedUngroundedRequirements: droppedUngroundedRequirements.length ? droppedUngroundedRequirements : undefined
  };
}

export const validateCompiledProspectContract = normalizeProspectContract;

const queryHasPositiveExclusion = (query: string, exclusionTerms: string[]): boolean => {
  const queryWords = lower(query).split(/\s+/).filter(Boolean);
  const positiveWords = queryWords
    .filter(w => !w.startsWith('-'))
    .map(w => w.replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/gi, ''))
    .filter(Boolean);
  const positiveText = ` ${positiveWords.join(' ')} `;
  return exclusionTerms.some(term => {
    if (!term) return false;
    const cleanTerm = lower(term).replace(/^[-"]+|["+]+$/g, '').trim();
    return positiveText.includes(` ${cleanTerm} `) || positiveWords.some(w => w === cleanTerm);
  });
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function deconcatenateContractQuery(query: string, contract: ProspectContract): string {
  let cleaned = query;

  // 1. Algorithmic de-concatenation of roles:
  // If query contains multiple role titles, retain only the primary role.
  const contractRoles = contract.requirements
    .filter(r => r.scope === 'person_role')
    .flatMap(r => r.acceptableTerms || [])
    .concat(['owner', 'founder', 'ceo', 'managing director', 'co-founder', 'president', 'partner', 'director'])
    .map(r => r.trim().toLowerCase())
    .filter(r => r.length > 1);
  const uniqueRoles = Array.from(new Set(contractRoles));

  const matchedRoles: { role: string; index: number }[] = [];
  for (const role of uniqueRoles) {
    const escaped = escapeRegex(role);
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    const match = regex.exec(cleaned);
    if (match) {
      matchedRoles.push({ role, index: match.index });
    }
  }

  if (matchedRoles.length > 1) {
    matchedRoles.sort((a, b) => a.index - b.index);
    const primaryRole = matchedRoles[0].role;
    for (let i = 1; i < matchedRoles.length; i++) {
      const redundantRole = matchedRoles[i].role;
      if (primaryRole.includes(redundantRole)) continue;
      const escaped = escapeRegex(redundantRole);
      const stripRegex = new RegExp(`(?:\\s*(?:or|and|[\\/,])\\s*)?\\b${escaped}\\b(?:\\s*(?:or|and|[\\/,]))?`, 'gi');
      cleaned = cleaned.replace(stripRegex, ' ');
    }
  }

  // 2. Algorithmic de-concatenation of countries/geos:
  // If multiple countries are concatenated, retain the primary country.
  const contractLocations = contract.requirements
    .filter(r => r.scope === 'person_location')
    .flatMap(r => r.acceptableTerms || [])
    .concat([
      'australia', 'united states', 'usa', 'united kingdom', 'uk',
      'canada', 'germany', 'france', 'netherlands', 'singapore',
      'new zealand', 'ireland', 'spain', 'italy', 'switzerland', 'sweden'
    ])
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 1);
  const uniqueLocations = Array.from(new Set(contractLocations));

  const matchedLocations: { loc: string; index: number }[] = [];
  for (const loc of uniqueLocations) {
    const escaped = escapeRegex(loc);
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    const match = regex.exec(cleaned);
    if (match) {
      matchedLocations.push({ loc, index: match.index });
    }
  }

  if (matchedLocations.length > 1) {
    matchedLocations.sort((a, b) => a.index - b.index);
    const primaryLoc = matchedLocations[0].loc;
    for (let i = 1; i < matchedLocations.length; i++) {
      const redundantLoc = matchedLocations[i].loc;
      if (primaryLoc.includes(redundantLoc)) continue;
      const escaped = escapeRegex(redundantLoc);
      const stripRegex = new RegExp(`(?:\\s*(?:or|and|[\\/,])\\s*)?\\b${escaped}\\b(?:\\s*(?:or|and|[\\/,]))?`, 'gi');
      cleaned = cleaned.replace(stripRegex, ' ');
    }
  }

  // Clean up any remaining orphaned conjunctions or punctuation left over from de-concatenation
  cleaned = cleaned
    .replace(/(?:^|\s)(?:or|and|\/|,)+(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

/** Reject or repair model queries so the retrieval surface cannot drift. */
export function enforceContractQueries(input: unknown, contract: ProspectContract): SearchQueryPlanItem[] {
  const rawItems = Array.isArray(input) ? input : [];
  const exclusions = contract.exclusions.map(lower).filter(Boolean);
  const seen = new Set<string>();
  const hardRequirements = contract.requirements.filter(item => item.importance === 'hard' && item.queryable && item.scope !== 'signal' && item.evidenceModality !== 'open_web_signal');
  const isAgency = isAgencyContract(contract);
  const intentTerms = new Set([
    ...(contract.intentSpec?.toolingKeywords || []).map(lower),
    ...(contract.intentSpec?.hiringSignals || []).map(lower),
    ...(contract.intentSpec?.painSignals || []).map(lower),
    ...(contract.intentSpec?.growthSignals || []).map(lower)
  ]);
  const normalized: SearchQueryPlanItem[] = [];
  for (const raw of rawItems.slice(0, 6)) {
    const candidate = typeof raw === 'string' ? { query: raw } : raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    const isSignalLane = candidate.lane === 'signal' || candidate.family === 'pain_signal' || candidate.family === 'growth_signal' || candidate.family === 'tooling_signal';
    let query = clean(candidate.query);
    // Strip Big Tech negative exclusion operators from search queries (belongs strictly in deterministic judge)
    query = query.replace(/-(?:microsoft|google|meta|apple|amazon|openai|deepmind|netflix|nvidia|bytedance|salesforce|oracle|uber|airbnb|stripe|palantir|cisco|adobe|intel|ibm)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!isSignalLane) {
      query = sanitizeQueryText(query);
      query = deconcatenateContractQuery(query, contract);
    } else {
      query = query.replace(/\s+/g, ' ').trim();
    }
    if (!query || query.length > 240 || queryHasPositiveExclusion(query, exclusions)) continue;
    if (!isSignalLane) {
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
        const alreadyHasContext = contextReqs.some(cr => {
          if (includesAny(query, cr.acceptableTerms)) return true;
          if (cr.scope === 'person_location') {
            for (const term of cr.acceptableTerms) {
              const cleanTerm = term.toLowerCase().trim();
              const metros = COUNTRY_TO_METROS[cleanTerm];
              if (metros && includesAny(query, metros)) return true;
            }
          }
          return false;
        });
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

      // 3. Agency disambiguation: do not clobber queries that already have agency vertical words
      const hasAgencyVertical = /\b(agency|agencies|consult\w*|service\w*|solution\w*|studio\w*|firm\w*|integrat\w*|advisory|business|partner\w*)\b/i.test(query);
      if (isAgency && !hasAgencyVertical && !lower(query).includes('-software') && !lower(query).includes('-saas')) {
        const agencyDisambig = '-software -platform -SaaS';
        if ((query + ' ' + agencyDisambig).length <= 240) {
          query = `${query} ${agencyDisambig}`.trim();
        }
      }
      query = deconcatenateContractQuery(query, contract);
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
      coveredRequirementIds: computeCoveredRequirementIds(query, contract.requirements, isSignalLane)
    });
  }
  // Recovery models sometimes emit a single broad query. Fill that gap with
  // deterministic contract-preserving variants so a thin plan cannot turn a
  // multi-round search into one attempt at a location-only query.
  if (normalized.length < 4) {
    for (const fallback of buildContractFallbackQueries(contract.brief, contract.requirements)) {
      if (normalized.length >= 4) break;
      const cleanedFallback = { ...fallback, query: fallback.query.trim() };
      const key = lower(cleanedFallback.query);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(cleanedFallback);
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

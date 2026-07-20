export type DiscoveryMode = 'person_first' | 'account_first' | 'signal_first' | 'local_business';
export type QueryLane = 'person' | 'account' | 'signal' | 'archetype';
export type ProviderPreference = 'tavily' | 'brightdata' | 'corroborate';
export type TavilySearchDepth = 'basic' | 'fast' | 'ultra-fast' | 'advanced';

export type SearchSpec = {
  version: 1;
  mode: DiscoveryMode;
  person: {
    includeTitles: string[];
    excludeTitles: string[];
    seniorities: string[];
    locations: string[];
  };
  company: {
    industries: string[];
    keywords: string[];
    locations: string[];
    employeeRange?: { min?: number; max?: number };
  };
  signals: {
    include: string[];
    recencyDays?: number;
  };
  exclusions: {
    companies: string[];
    domains: string[];
  };
  maxPerCompany: number;
};

export type QueryFamily =
  | 'persona_title'
  | 'industry_vertical'
  | 'pain_signal'
  | 'growth_signal'
  | 'tooling_signal'
  | 'local_market'
  | 'company_type'
  | 'archetype_exploration';

export type QueryIntent =
  | 'find_decision_makers'
  | 'find_buying_signal'
  | 'expand_surface_area'
  | 'recover_from_low_yield'
  | 'reduce_duplicates';

export type SearchQueryPlanItem = {
  query: string;
  /** Contract ids this query is deliberately preserving. */
  coveredRequirementIds?: string[];
  family?: QueryFamily;
  intent?: QueryIntent;
  expectedSignal?: string;
  priority?: number;
  lane?: QueryLane;
  providerPreference?: ProviderPreference;
  searchDepth?: TavilySearchDepth;
  topic?: 'general' | 'news';
  timeRange?: 'week' | 'month' | 'year';
  country?: string;
};

export type RetrievalTask = {
  id: string;
  query: string;
  coveredRequirementIds?: string[];
  lane: QueryLane;
  providerPreference: ProviderPreference;
  family?: SearchQueryPlanItem['family'];
  intent?: SearchQueryPlanItem['intent'];
  expectedSignal?: string;
  priority: number;
  tavily: {
    includeDomains?: string[];
    excludeDomains?: string[];
    searchDepth: TavilySearchDepth;
    topic: 'general' | 'news';
    timeRange?: 'week' | 'month' | 'year';
    country?: string;
    maxResults: number;
    minimumScore: number;
  };
};

const boundedNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

const asArray = (value: unknown, max = 20) => Array.isArray(value)
  ? Array.from(new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))).slice(0, max)
  : [];

const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const normalizeSearchSpec = (input: unknown, query: string): SearchSpec => {
  const source = input && typeof input === 'object' ? input as Record<string, any> : {};
  const requestedMode = clean(source.mode) as DiscoveryMode;
  const mode: DiscoveryMode = ['person_first', 'account_first', 'signal_first', 'local_business'].includes(requestedMode)
    ? requestedMode
    : 'person_first';
  const employeeRange = source.company?.employeeRange && typeof source.company.employeeRange === 'object'
    ? {
      min: boundedNumber(source.company.employeeRange.min, 0, 0, 1_000_000),
      max: boundedNumber(source.company.employeeRange.max, 0, 0, 1_000_000)
    }
    : undefined;

  return {
    version: 1,
    mode,
    person: {
      includeTitles: asArray(source.person?.includeTitles),
      excludeTitles: asArray(source.person?.excludeTitles),
      seniorities: asArray(source.person?.seniorities),
      locations: asArray(source.person?.locations)
    },
    company: {
      industries: asArray(source.company?.industries),
      keywords: asArray(source.company?.keywords).length ? asArray(source.company?.keywords) : [clean(query)].filter(Boolean),
      locations: asArray(source.company?.locations),
      employeeRange: employeeRange && (employeeRange.min || employeeRange.max) ? employeeRange : undefined
    },
    signals: {
      include: asArray(source.signals?.include),
      recencyDays: source.signals?.recencyDays ? boundedNumber(source.signals.recencyDays, 30, 1, 365) : undefined
    },
    exclusions: {
      companies: asArray(source.exclusions?.companies, 100),
      domains: asArray(source.exclusions?.domains, 100)
    },
    maxPerCompany: boundedNumber(source.maxPerCompany, 2, 1, 5)
  };
};

export const buildFallbackSearchSpec = (query: string, mode: DiscoveryMode = 'person_first'): SearchSpec => {
  const normalized = clean(query);
  const lower = normalized.toLowerCase();
  const hasLocalHint = /\b(local|near me|city|austin|dallas|houston|miami|chicago|new york|london|toronto|canada|usa|united states)\b/.test(lower);
  const hasSignalHint = /\b(hiring|funding|raised|growing|growth|automation|crm|new patients|booking|expanding)\b/.test(lower);
  return normalizeSearchSpec({
    mode: mode === 'person_first' && hasLocalHint ? 'local_business' : mode === 'person_first' && hasSignalHint ? 'signal_first' : mode,
    company: { keywords: [normalized] },
    signals: { include: hasSignalHint ? [normalized] : [], recencyDays: hasSignalHint ? 90 : undefined },
    maxPerCompany: 2
  }, normalized);
};

const familyFor = (item: SearchQueryPlanItem, spec: SearchSpec) => item.family || (
  spec.mode === 'account_first' ? 'company_type' : spec.mode === 'signal_first' ? 'growth_signal' : 'persona_title'
);

const laneFor = (item: SearchQueryPlanItem, spec: SearchSpec): QueryLane => {
  if (item.lane) return item.lane;
  const family = familyFor(item, spec);
  if (family === 'archetype_exploration') return 'archetype';
  if (family === 'pain_signal' || family === 'growth_signal' || family === 'tooling_signal') return 'signal';
  if (family === 'company_type' || family === 'industry_vertical' || family === 'local_market') return 'account';
  return spec.mode === 'account_first' ? 'account' : 'person';
};

export const buildRetrievalTasks = (items: SearchQueryPlanItem[], spec: SearchSpec): RetrievalTask[] => {
  const maxResults = boundedNumber(process.env.TAVILY_MAX_RESULTS, 10, 1, 20);
  const configuredCountry = clean(process.env.TAVILY_COUNTRY);
  const seen = new Set<string>();
  return items
    .slice()
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map((item, index) => {
      const rawLane = laneFor(item, spec);
      const lane: QueryLane = rawLane === 'archetype' ? 'person' : rawLane;
      const family = familyFor(item, spec);
      const isSignal = lane === 'signal';
      const isPerson = lane === 'person';
      const requestedDepth = item.searchDepth || (isSignal && (item.priority || index + 1) <= 2 ? 'advanced' : 'basic');
      const providerPreference = item.providerPreference || (lane === 'account' || isSignal ? 'corroborate' : 'tavily');
      // Tavily's country parameter is a strict lowercase enum. Do not let an
      // LLM substitute a metro area or differently-cased country name here;
      // the documented, operator-controlled value from .env is the only
      // country boost that reaches the API.
      const country = configuredCountry ? configuredCountry.toLowerCase() : undefined;
      // Tavily's include_domains contract accepts domains, not URL paths. Keep
      // the provider filter to the LinkedIn domain and enforce the stricter
      // /in/ profile requirement after retrieval in the route.
      const includeDomains = ['linkedin.com'];
      const task: RetrievalTask = {
        id: `q-${index + 1}-${family}`,
        query: clean(item.query),
        coveredRequirementIds: item.coveredRequirementIds,
        lane,
        providerPreference,
        family,
        intent: item.intent,
        expectedSignal: item.expectedSignal,
        priority: item.priority || index + 1,
        tavily: {
          includeDomains,
          excludeDomains: spec.exclusions.domains,
          searchDepth: requestedDepth,
          // A LinkedIn-profile-only collection pass cannot use Tavily's news
          // topic: it returns news articles rather than public /in/ profiles.
          // Preserve the signal terms in the query, but search the documented
          // general topic so country boosting and profile retrieval work.
          topic: 'general',
          timeRange: undefined,
          country,
          maxResults: isPerson ? maxResults : Math.min(maxResults, 8),
          minimumScore: isPerson ? 0.35 : 0.25
        }
      };
      return task;
    })
    .filter(task => {
      const key = `${task.lane}:${task.query.toLowerCase()}`;
      if (!task.query || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export const buildFallbackQueryPlan = (query: string, spec: SearchSpec): SearchQueryPlanItem[] => {
  const base = clean(query);
  const titles = spec.person.includeTitles.length ? spec.person.includeTitles : ['founder', 'owner'];
  const signal = spec.signals.include[0] || 'growth automation';
  const plans: SearchQueryPlanItem[] = [
    { query: `${base} ${titles.join(' ')}`, family: 'persona_title', intent: 'find_decision_makers', expectedSignal: 'Decision-maker profiles', priority: 1, lane: 'person', providerPreference: 'tavily', searchDepth: 'basic' },
    { query: `${base} company founder owner`, family: 'company_type', intent: 'expand_surface_area', expectedSignal: 'Qualified company and leadership evidence', priority: 2, lane: 'account', providerPreference: 'brightdata', searchDepth: 'basic' },
    { query: `${base} ${signal}`, family: 'growth_signal', intent: 'find_buying_signal', expectedSignal: 'Recent public business signals', priority: 3, lane: 'signal', providerPreference: 'brightdata', searchDepth: 'basic' },
    { query: `${base} operations director`, family: 'persona_title', intent: 'expand_surface_area', expectedSignal: 'Adjacent operator decision makers', priority: 4, lane: 'person', providerPreference: 'corroborate', searchDepth: 'basic' }
  ];
  return plans.filter(item => item.query.trim().length > 0);
};

export const buildSearchSpecPrompt = (query: string) => `Convert this prospecting brief into an editable scouting specification.\n\nBrief:\n${query}\n\nUse only explicit criteria. Do not invent firmographics, emails, or buying intent. A mode is one of person_first, account_first, signal_first, local_business. Keep title and company keyword lists concise. Return the requested JSON schema.`;

export const buildStrategistPrompt = (params: {
  query: string;
  spec: SearchSpec;
  round: number;
  maxRounds: number;
  remaining: number;
  previousQueries: string[];
  previousRoundSummary: Record<string, any>;
  queryPerformance?: Record<string, any>;
  discoveryMode?: string;
}) => {
  const previousNote = params.previousQueries.length ? `Avoid repeats: ${params.previousQueries.join(' | ')}` : 'No previous queries.';
  const discoveryMode = params.discoveryMode || 'hybrid';
  return `You are a dual-provider B2B prospecting strategist for Apex CRM.

User brief: ${params.query}
Structured targeting spec: ${JSON.stringify(params.spec)}
Discovery mode: ${discoveryMode}

Generate exactly four concise retrieval tasks. This is round ${params.round}/${params.maxRounds}; ${params.remaining} qualified prospects remain.
${previousNote}
Prior round summary: ${JSON.stringify(params.previousRoundSummary)}
Historical family/provider yield: ${JSON.stringify(params.queryPerformance || {})}

Rules:
- Do not write Google dorks, site:, or the word LinkedIn in query text (providers add LinkedIn constraints).
- Use at least two lanes: person, account, signal when the brief supports them.
- person lane finds public professional profiles; account lane finds companies and leadership evidence; signal lane finds public growth, tooling, hiring, or pain evidence.
- Prefer searchDepth basic. Do not use advanced unless a single signal task truly needs it.
- providerPreference guide:
  - tavily: AI-ranked precision person queries (domain-filtered LinkedIn).
  - brightdata: volume Google SERP discovery and account/signal recovery (search_engine).
  - corroborate: both providers when useful.
- In hybrid/bd_primary modes, assign at least two tasks with providerPreference brightdata or corroborate.
- Treat qualified and returned finalist counts as the primary historical signal. Accepted counts are provisional only.
- Prefer families that produce qualified/returned finalists; penalize rescue-heavy, duplicate-heavy, slow, or credit-heavy families.
- Preserve some exploration of under-tested families instead of permanently locking onto one query pattern.
- Never assume Pro-only Bright Data tools (no structured LinkedIn datasets, no browser automation).

Return query, family, intent, expectedSignal, priority, lane, providerPreference, searchDepth, topic, timeRange, and country when relevant.`;
};

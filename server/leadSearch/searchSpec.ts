export type DiscoveryMode =
  | "person_first"
  | "account_first"
  | "signal_first"
  | "local_business";
export type QueryLane = "person" | "account" | "signal" | "archetype";
export type ProviderPreference = "tavily" | "brightdata" | "corroborate";
export type TavilySearchDepth = "basic" | "fast" | "ultra-fast" | "advanced";

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
  | "persona_title"
  | "industry_vertical"
  | "pain_signal"
  | "growth_signal"
  | "tooling_signal"
  | "local_market"
  | "company_type"
  | "archetype_exploration";

export type QueryIntent =
  | "find_decision_makers"
  | "find_buying_signal"
  | "expand_surface_area"
  | "recover_from_low_yield"
  | "reduce_duplicates";

export type SearchQueryPlanItem = {
  query: string;
  /** Contract ids this query is deliberately preserving. */
  coveredRequirementIds?: string[];
  family?: QueryFamily;
  intent?: QueryIntent;
  domainCluster?: string;
  expectedSignal?: string;
  priority?: number;
  lane?: QueryLane;
  providerPreference?: ProviderPreference;
  searchDepth?: TavilySearchDepth;
  topic?: "general" | "news";
  timeRange?: "week" | "month" | "year";
  country?: string;
};

export type RetrievalTask = {
  id: string;
  query: string;
  coveredRequirementIds?: string[];
  lane: QueryLane;
  providerPreference: ProviderPreference;
  family?: SearchQueryPlanItem["family"];
  intent?: SearchQueryPlanItem["intent"];
  domainCluster?: string;
  expectedSignal?: string;
  priority: number;
  tavily: {
    includeDomains?: string[];
    excludeDomains?: string[];
    searchDepth: TavilySearchDepth;
    topic: "general" | "news";
    timeRange?: "week" | "month" | "year";
    country?: string;
    maxResults: number;
    minimumScore: number;
  };
};

const boundedNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

const asArray = (value: unknown, max = 20) =>
  Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ).slice(0, max)
    : [];

const clean = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export const normalizeSearchSpec = (
  input: unknown,
  query: string,
  forcedMode?: DiscoveryMode,
): SearchSpec => {
  const source =
    input && typeof input === "object" ? (input as Record<string, any>) : {};
  const requestedMode = clean(source.mode) as DiscoveryMode;
  const mode: DiscoveryMode =
    forcedMode ||
    ([
      "person_first",
      "account_first",
      "signal_first",
      "local_business",
    ].includes(requestedMode)
      ? requestedMode
      : "person_first");
  const employeeRange =
    source.company?.employeeRange &&
    typeof source.company.employeeRange === "object"
      ? {
          min: boundedNumber(source.company.employeeRange.min, 0, 0, 1_000_000),
          max: boundedNumber(source.company.employeeRange.max, 0, 0, 1_000_000),
        }
      : undefined;

  return {
    version: 1,
    mode,
    person: {
      includeTitles: asArray(source.person?.includeTitles),
      excludeTitles: asArray(source.person?.excludeTitles),
      seniorities: asArray(source.person?.seniorities),
      locations: asArray(source.person?.locations),
    },
    company: {
      industries: asArray(source.company?.industries),
      keywords: asArray(source.company?.keywords).length
        ? asArray(source.company?.keywords)
        : [clean(query)].filter(Boolean),
      locations: asArray(source.company?.locations),
      employeeRange:
        employeeRange && (employeeRange.min || employeeRange.max)
          ? employeeRange
          : undefined,
    },
    signals: {
      include: asArray(source.signals?.include),
      recencyDays: source.signals?.recencyDays
        ? boundedNumber(source.signals.recencyDays, 30, 1, 365)
        : undefined,
    },
    exclusions: {
      companies: asArray(source.exclusions?.companies, 100),
      domains: asArray(source.exclusions?.domains, 100),
    },
    maxPerCompany: boundedNumber(source.maxPerCompany, 2, 1, 5),
  };
};

export const METRO_HUBS_BY_COUNTRY: Record<string, string[]> = {
  usa: [
    "New York",
    "San Francisco",
    "Austin",
    "Los Angeles",
    "Chicago",
    "Boston",
    "Seattle",
    "Miami",
    "Atlanta",
    "Dallas",
    "Denver",
    "San Diego",
  ],
  uk: ["London", "Manchester", "Birmingham", "Bristol", "Edinburgh", "Leeds"],
  canada: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
  australia: ["Sydney", "Melbourne", "Brisbane", "Perth"],
};

export const buildFallbackSearchSpec = (
  query: string,
  mode: DiscoveryMode = "person_first",
): SearchSpec => {
  const normalized = clean(query);
  const lower = normalized.toLowerCase();
  const hasLocalHint =
    /\b(dentist|chiropractor|plumber|roofing|salon|restaurant|hvac|mechanic|bakery|barber|clinic|storefront)\b/.test(
      lower,
    );
  const hasSignalHint =
    /\b(hiring|funding|raised|growing|growth|automation|crm|new patients|booking|expanding)\b/.test(
      lower,
    );
  return normalizeSearchSpec(
    {
      mode:
        mode === "person_first" && hasLocalHint
          ? "local_business"
          : mode === "person_first" && hasSignalHint
            ? "signal_first"
            : mode,
      company: { keywords: [normalized] },
      signals: {
        include: hasSignalHint ? [normalized] : [],
        recencyDays: hasSignalHint ? 90 : undefined,
      },
      maxPerCompany: 2,
    },
    normalized,
  );
};

const familyFor = (item: SearchQueryPlanItem, spec: SearchSpec) =>
  item.family ||
  (spec.mode === "account_first"
    ? "company_type"
    : spec.mode === "signal_first"
      ? "growth_signal"
      : "persona_title");

const laneFor = (item: SearchQueryPlanItem, spec: SearchSpec): QueryLane => {
  if (item.lane) return item.lane;
  const family = familyFor(item, spec);
  if (family === "archetype_exploration") return "archetype";
  if (
    family === "pain_signal" ||
    family === "growth_signal" ||
    family === "tooling_signal"
  )
    return "signal";
  if (
    family === "company_type" ||
    family === "industry_vertical" ||
    family === "local_market"
  )
    return "account";
  return spec.mode === "account_first" ? "account" : "person";
};

export const buildRetrievalTasks = (
  items: SearchQueryPlanItem[],
  spec: SearchSpec,
): RetrievalTask[] => {
  const maxResults = boundedNumber(process.env.TAVILY_MAX_RESULTS, 12, 1, 20);
  const configuredCountry = clean(process.env.TAVILY_COUNTRY);
  let derivedCountry = configuredCountry ? normalizeTavilyCountry(configuredCountry) || "" : "";
  if (!derivedCountry) {
    const candidateLocs = [
      ...(spec.person?.locations || []),
      ...(spec.company?.locations || []),
      ...(spec.company?.keywords || []),
    ];
    for (const loc of candidateLocs) {
      const cleanLoc = clean(loc).toLowerCase();
      if (COUNTRY_CANONICAL_MAP[cleanLoc]) {
        const canonical = COUNTRY_CANONICAL_MAP[cleanLoc];
        derivedCountry = COUNTRY_TO_TAVILY_CODE[canonical] || normalizeTavilyCountry(canonical) || "";
        break;
      }
    }
  }
  const seen = new Set<string>();
  return items
    .slice()
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map((item, index) => {
      const rawLane = laneFor(item, spec);
      const lane: QueryLane = rawLane === "archetype" ? "person" : rawLane;
      const family = familyFor(item, spec);
      const isSignal = lane === "signal";
      const isPerson = lane === "person";
      // Enforce basic depth for person discovery to optimize recall and cost (1 credit),
      // while escalating top signal tasks to advanced for rich job/tooling context.
      const requestedDepth = isPerson
        ? "basic"
        : item.searchDepth ||
          (isSignal && (item.priority || index + 1) <= 2
            ? "advanced"
            : "basic");
      const providerPreference =
        item.providerPreference ||
        (lane === "account" || isSignal ? "corroborate" : "tavily");
      // Tavily's country parameter is a strict lowercase enum. Do not let an
      // LLM substitute a metro area or differently-cased country name here;
      // use the operator-configured value from .env or the brief/spec country.
      const country = derivedCountry || undefined;
      // Person/account lanes collect LinkedIn identity anchors. Signal lanes
      // search the open web and are retained only as company evidence.
      const includeDomains = isSignal ? undefined : ["linkedin.com"];
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
          excludeDomains: spec?.exclusions?.domains || [],
          searchDepth: requestedDepth,
          topic: isSignal ? item.topic || "general" : "general",
          timeRange: isSignal ? item.timeRange : undefined,
          country,
          maxResults: isPerson ? Math.max(maxResults, 12) : Math.min(maxResults, 8),
          minimumScore: isPerson ? 0.15 : 0.15,
        },
      };
      return task;
    })
    .filter((task) => {
      const key = `${task.lane}:${task.query.toLowerCase()}`;
      if (!task.query || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

import { COUNTRY_CANONICAL_MAP, type ProspectContract } from "./prospectContract.js";
import { looksLikeCompanyHint } from "./observations.js";
import { normalizeTavilyCountry } from "../services/llm.js";
import { resolveGeo } from "./queryUnderstanding.js";

export const COUNTRY_TO_TAVILY_CODE: Record<string, string> = {
  UK: "united kingdom",
  USA: "united states",
  Canada: "canada",
  Australia: "australia",
  "New Zealand": "new zealand",
  Germany: "germany",
  France: "france",
  Netherlands: "netherlands",
  Ireland: "ireland",
  Spain: "spain",
  Italy: "italy",
  Switzerland: "switzerland",
  Sweden: "sweden",
  Singapore: "singapore",
  Japan: "japan",
};

export const buildFallbackQueryPlan = (
  query: string,
  spec?: SearchSpec,
): SearchQueryPlanItem[] => {
  const base = clean(query);
  const effectiveSpec = spec || buildFallbackSearchSpec(query);
  const titles = effectiveSpec.person.includeTitles.length
    ? effectiveSpec.person.includeTitles
    : ["founder", "owner", "CEO", "managing partner"];
  const signal = effectiveSpec.signals.include[0] || "growth hiring";

  // Detect geography via unified resolver. Zero default-invention:
  // open_global briefs get NO countryAnchor/metros (search globally).
  const geoRes = resolveGeo(base);
  let metros: string[] = [...geoRes.metros];
  let countryAnchor: string | null = geoRes.countryAnchor;
  if (countryAnchor && metros.length === 0) {
    // Fallback to legacy hub table for explicitly detected countries
    const hubKey = countryAnchor.toLowerCase() === 'united states' || countryAnchor === 'USA' ? 'usa'
      : countryAnchor.toLowerCase() === 'united kingdom' || countryAnchor === 'UK' ? 'uk'
      : countryAnchor.toLowerCase();
    const hubs = (METRO_HUBS_BY_COUNTRY as Record<string, string[]>)[hubKey];
    if (hubs && hubs.length > 0) metros = [...hubs];
  }

  // Extract core company topic/vertical from query
  const cleanTopic = base
    .replace(/\b(from|in|based in|located in|near)\b.*$/i, "")
    .replace(/\b(owner|founder|ceo|co-founder|director|managing partner|president|proprietor)\b/gi, "")
    .replace(/[/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || base.trim() || "B2B company";

  // Zero default-invention: when geo is open_global, emit global queries with no location tokens.
  const geoSuffix = countryAnchor ? ` ${countryAnchor}` : '';
  const metro0 = countryAnchor && metros[0]
    ? (!metros[0].toLowerCase().includes(countryAnchor.toLowerCase()) ? `${metros[0]} ${countryAnchor}` : metros[0])
    : (countryAnchor ? countryAnchor : '');
  const metro1 = countryAnchor && metros[1]
    ? (!metros[1].toLowerCase().includes(countryAnchor.toLowerCase()) ? `${metros[1]} ${countryAnchor}` : metros[1])
    : (countryAnchor ? countryAnchor : '');

  const plans: SearchQueryPlanItem[] = [
    {
      query: `${cleanTopic} ${titles[0] || "founder"}${geoSuffix}`.trim(),
      family: "persona_title",
      intent: "find_decision_makers",
      expectedSignal: "Decision-maker profiles",
      priority: 1,
      lane: "person",
      providerPreference: "tavily",
      searchDepth: "basic",
    },
    {
      query: (metro0 ? `${cleanTopic} ${titles[1] || "owner"} ${metro0}` : `${cleanTopic} ${titles[1] || "owner"}`).trim(),
      family: "persona_title",
      intent: "find_decision_makers",
      expectedSignal: "Decision-maker profiles in top metro",
      priority: 2,
      lane: "person",
      providerPreference: "tavily",
      searchDepth: "basic",
    },
    {
      query: (metro1 ? `${cleanTopic} ${titles[2] || "CEO"} ${metro1}` : `${cleanTopic} ${titles[2] || "CEO"}`).trim(),
      family: "company_type",
      intent: "expand_surface_area",
      expectedSignal: "Leadership evidence in tech metro",
      priority: 3,
      lane: "account",
      providerPreference: "brightdata",
      searchDepth: "basic",
    },
    {
      query: `${cleanTopic} ${signal}${geoSuffix}`.trim(),
      family: "growth_signal",
      intent: "find_buying_signal",
      expectedSignal: "Recent public business signals",
      priority: 4,
      lane: "signal",
      providerPreference: "brightdata",
      searchDepth: "basic",
    },
  ];
  return plans.filter((item) => item.query.trim().length > 0);
};

export const buildSearchSpecPrompt = (query: string) =>
  `Convert this prospecting brief into an editable scouting specification.\n\nBrief:\n${query}\n\nUse only explicit criteria. Do not invent firmographics, emails, or buying intent. A mode is one of person_first, account_first, signal_first, local_business. Keep title and company keyword lists concise. Return the requested JSON schema.`;

export const buildStrategistPrompt = (params: {
  query: string;
  spec?: SearchSpec;
  round: number;
  maxRounds: number;
  remaining: number;
  previousQueries: string[];
  previousRoundSummary: Record<string, any>;
  queryPerformance?: Record<string, any>;
  discoveryMode?: string;
  contract?: ProspectContract;
  missingRequirementIds?: string[];
  discoveredCompanies?: string[];
  knownCompanyEntities?: string[];
  metroSaturation?: Record<string, number>;
  isRecovery?: boolean;
  recoveryAttempt?: number;
  logEvent?: (msg: string) => void;
}) => {
  // Token diet: by late rounds the full query history dominates the prompt.
  // Send only the most recent queries plus a compact family-coverage digest.
  const prevQueries = Array.isArray(params.previousQueries) ? params.previousQueries : [];
  const recentQueries = prevQueries.slice(-5);
  const familyCounts: Record<string, number> = {};
  for (const q of prevQueries) {
    const family = q.split(" ").slice(0, 3).join(" ").toLowerCase();
    familyCounts[family] = (familyCounts[family] || 0) + 1;
  }
  const topFamilies = Object.entries(familyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([family, count]) => `${family} x${count}`)
    .join("; ");
  const previousNote = prevQueries.length
    ? `Avoid repeats. Explored ${prevQueries.length} queries; recent: ${recentQueries.join(" | ")}. Top prefixes: ${topFamilies || "none"}.`
    : "No previous queries.";
  const discoveryMode = params.discoveryMode || "hybrid";

  const requirementDigest = params.contract?.requirements?.length
    ? `\nCompiled prospect requirements:
${params.contract.requirements.map((r) => `  - [${r.importance}/${r.scope}/${r.evidenceModality || "structured_profile"}] ${r.description} (terms: ${r.acceptableTerms.slice(0, 3).join(", ")})`).join("\n")}`
    : "";

  const missingNote =
    params.missingRequirementIds && params.missingRequirementIds.length > 0
      ? `\nUNMET HARD REQUIREMENTS (these had < 25% pass rate last round and MUST be covered in queries): ${params.missingRequirementIds.join(", ")}`
      : "";

  // Extract all metros from METRO_HUBS_BY_COUNTRY that appeared in previousQueries
  const allKnownMetros = Object.values(METRO_HUBS_BY_COUNTRY).flat();
  const lowerQueries = prevQueries.map((q) => q.toLowerCase());
  const exploredMetros = allKnownMetros.filter((metro) =>
    lowerQueries.some((q) => q.includes(metro.toLowerCase())),
  );

  // Detect CRM-saturated metros
  const metroSaturation = params.metroSaturation || {};
  const saturatedMetros = allKnownMetros.filter((metro) => {
    const count = metroSaturation[metro.toLowerCase()] || 0;
    return count >= 15;
  });

  // Determine target countries from brief or contract
  const briefLower = (params.contract?.brief || params.query || "").toLowerCase();
  const isNorthAmerica = /\bnorth\s+america\b/i.test(briefLower);
  const isSouthOrLatinAmerica = /\b(?:south|latin)\s+america\b/i.test(briefLower);
  const relevantCountries = Object.keys(METRO_HUBS_BY_COUNTRY).filter((c) => {
    if (briefLower.includes(c)) return true;
    if (isNorthAmerica && (c === "usa" || c === "canada")) return true;
    if (c === "usa" && !isNorthAmerica && !isSouthOrLatinAmerica && /\b(?:united states|us|usa|u\.s\.a?|america)\b/i.test(briefLower)) return true;
    if (c === "uk" && /\b(?:united kingdom|uk|britain|england|scotland)\b/i.test(briefLower)) return true;
    return false;
  });
  const countryPool = relevantCountries.length > 0 ? relevantCountries : Object.keys(METRO_HUBS_BY_COUNTRY);
  const eligibleMetros = countryPool.flatMap((c) => {
    const hubList = METRO_HUBS_BY_COUNTRY[c] || [];
    const countryLabel = c === "uk" ? "UK" : c === "canada" ? "Canada" : c === "australia" ? "Australia" : "";
    return hubList.map((m) => countryLabel && !m.toLowerCase().includes(countryLabel.toLowerCase()) ? `${m} ${countryLabel}` : m);
  });
  const unvisitedMetros = eligibleMetros.filter((m) => {
    const mLower = m.toLowerCase();
    const isExplored = exploredMetros.some((em) => mLower.includes(em.toLowerCase()));
    const isSaturated = saturatedMetros.some((sm) => mLower.includes(sm.toLowerCase()));
    return !isExplored && !isSaturated;
  });

  const saturatedNote = saturatedMetros.length > 0
    ? `\nCRM-SATURATED METROS (CRM already contains many leads for these cities; DO NOT query these): [${saturatedMetros.join(", ")}]`
    : "";
  const exploredNote = exploredMetros.length > 0
    ? `\nALREADY EXPLORED METROS IN THIS SESSION (DO NOT query these again): [${exploredMetros.join(", ")}]`
    : "";
  const unvisitedNote = unvisitedMetros.length > 0
    ? `\nRECOMMENDED UNVISITED METROS TO TARGET NEXT (optional geographic variety, max 2 queries should use metros): [${unvisitedMetros.slice(0, 6).join(", ")}]`
    : "";

  const metroDirectives = `${saturatedNote}${exploredNote}${unvisitedNote}`.trim()
    ? `${saturatedNote}${exploredNote}${unvisitedNote}`
    : "";

  const recoveryDirective = params.isRecovery
    ? `\nRECOVERY DIRECTIVE (Attempt ${params.recoveryAttempt || 1}/2):
Prior rounds had low yield or missed specific criteria.
- Pivot to fresh, unvisited metropolitan hubs and tech clusters (e.g. ${unvisitedMetros.slice(0, 6).join(", ") || "Austin, Denver, Manchester UK, Melbourne, Vancouver"}).
- Rotate leadership title synonyms (e.g. "managing director", "principal", "managing partner", "executive director", "co-founder").
- Explore adjacent client-service vertical phrasing (e.g. "AI consulting", "AI solutions", "machine learning agency").
- Maintain single-concept clarity: NEVER concatenate multiple roles or locations into a single bloated query.
- When targeting non-US locations, ALWAYS include the country name in queries (e.g. "Birmingham UK", "London UK") to prevent US location ambiguity.
- NEVER append generic terms like "profile", "public profile", or "professional profile".`
    : "";

  const validDiscoveredCompanies = (params.discoveredCompanies || []).filter((c) =>
    looksLikeCompanyHint(c),
  );

  const flywheelNote =
    validDiscoveredCompanies.length > 0
      ? `\nDISCOVERED COMPANIES WITH ACTIVE SIGNALS (generate person queries targeting decision makers at these companies): ${validDiscoveredCompanies.slice(0, 5).join(", ")}`
      : "";

  const knownCompaniesNote =
    params.knownCompanyEntities && params.knownCompanyEntities.length > 0
      ? `\nEXISTING CRM & RECENTLY EXPLORED COMPANIES (pivot to fresh companies and adjacent tech hubs, do NOT target these; optionally use negative operators e.g. -"TopAgency"): ${params.knownCompanyEntities.slice(0, 10).join(", ")}`
      : "";

  if (
    params.logEvent &&
    params.missingRequirementIds &&
    params.missingRequirementIds.length > 0
  ) {
    params.logEvent(
      `[Strategist] Injected unmet hard requirements into prompt: [${params.missingRequirementIds.join(", ")}]`,
    );
  }
  if (
    params.logEvent &&
    validDiscoveredCompanies.length > 0
  ) {
    params.logEvent(
      `[Strategist] Injected reverse flywheel target companies into prompt: [${validDiscoveredCompanies.slice(0, 5).join(", ")}]`,
    );
  }
  if (
    params.logEvent &&
    params.knownCompanyEntities &&
    params.knownCompanyEntities.length > 0
  ) {
    params.logEvent(
      `[Strategist] Injected ${params.knownCompanyEntities.length} known CRM/explored companies into prompt`,
    );
  }
  if (params.logEvent && exploredMetros.length > 0) {
    params.logEvent(
      `[Strategist] Injected ${exploredMetros.length} already explored metros to exclude: [${exploredMetros.join(", ")}]`,
    );
  }

  const roundSummaryRaw = { ...(params.previousRoundSummary || {}) };
  const summaryBullets: string[] = [];
  if (Array.isArray(roundSummaryRaw.missingHardRequirementIds) && roundSummaryRaw.missingHardRequirementIds.length > 0) {
    const missingDesc = roundSummaryRaw.missingHardRequirementIds
      .map((id: string) => {
        const req = (params.contract?.requirements || []).find((r: any) => r.id === id);
        return req ? `${req.description || id} (${(req.acceptableTerms || []).slice(0, 3).join('/')})` : id;
      })
      .slice(0, 4)
      .join('; ');
    summaryBullets.push(`Missing requirements: ${missingDesc}`);
  }
  if (roundSummaryRaw.observedNonMatchingAttributes?.locations?.length) {
    summaryBullets.push(`Observed non-matching locations: ${roundSummaryRaw.observedNonMatchingAttributes.locations.slice(0, 5).join(', ')}`);
  }
  if (roundSummaryRaw.observedNonMatchingAttributes?.roles?.length) {
    summaryBullets.push(`Observed candidate titles: ${roundSummaryRaw.observedNonMatchingAttributes.roles.slice(0, 5).join(', ')}`);
  }
  if (typeof roundSummaryRaw.viableCandidates === 'number') {
    summaryBullets.push(`Viable candidates: ${roundSummaryRaw.viableCandidates}`);
  }
  if (roundSummaryRaw.classSummary?.bottleneckClass) {
    summaryBullets.push(`Bottleneck: ${roundSummaryRaw.classSummary.bottleneckClass}`);
  }
  if (roundSummaryRaw.rejectionReasons && typeof roundSummaryRaw.rejectionReasons === 'object') {
    const topRejections = Object.entries(roundSummaryRaw.rejectionReasons)
      .sort((a: any, b: any) => Number(b[1]) - Number(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    if (topRejections) summaryBullets.push(`Top rejections: ${topRejections}`);
  }
  const rejectedCompanies = roundSummaryRaw.rejectedCompanies || roundSummaryRaw.observedNonMatchingAttributes?.rejectedCompanies;
  if (Array.isArray(rejectedCompanies) && rejectedCompanies.length > 0) {
    summaryBullets.push(`Previously rejected companies to exclude: ${rejectedCompanies.slice(0, 6).join(', ')}`);
  }
  const roundSummaryStr = summaryBullets.length > 0 ? summaryBullets.join(' | ') : 'No previous round diagnostics';
  // Compact yield digest: top scope keys by accepted-per-run instead of raw JSON.
  const performanceEntries = Object.entries(params.queryPerformance || {})
    .map(([scopeKey, data]: [string, any]) => ({
      scopeKey,
      accepted: Number(data?.accepted || 0),
      runs: Number(data?.runs || 0),
      unique: Number(data?.unique || 0),
    }))
    .filter((entry) => entry.runs > 0)
    .sort((a, b) => b.accepted / b.runs - a.accepted / a.runs)
    .slice(0, 4);
  const performanceStr = performanceEntries.length
    ? performanceEntries
        .map(
          (entry) =>
            `${entry.scopeKey} accepted=${entry.accepted}/${entry.runs} runs, ${entry.unique} unique`,
        )
        .join("; ")
    : "no history yet";
  const requirementFails: string[] = [];
  if (params.queryPerformance) {
    for (const [scopeKey, data] of Object.entries(
      params.queryPerformance as any,
    )) {
      const digest =
        (data as any)?.requirementFailDigest ||
        (data as any)?.requirement_fail_digest;
      if (digest) {
        try {
          const parsed =
            typeof digest === "string" ? JSON.parse(digest) : digest;
          if (parsed && typeof parsed === "object") {
            const topFails = Object.entries(parsed)
              .sort((a: any, b: any) => Number(b[1]) - Number(a[1]))
              .slice(0, 2)
              .map(([req, count]) => `${req} (${count} fails)`)
              .join(", ");
            if (topFails) requirementFails.push(`${scopeKey}: ${topFails}`);
          }
        } catch {}
      }
    }
  }
  const failNote = requirementFails.length
    ? `\nFREQUENT JUDGE REQUIREMENT FAILS (avoid query patterns that trigger these):\n${requirementFails.slice(0, 4).map((f) => `  - ${f}`).join("\n")}`
    : "";

  const specSummaryParts: string[] = [];
  if (params.spec?.person?.includeTitles?.length) specSummaryParts.push(`titles: [${params.spec.person.includeTitles.slice(0, 6).join(", ")}]`);
  const locations = params.spec?.person?.locations?.length ? params.spec.person.locations : params.spec?.company?.locations;
  if (locations?.length) specSummaryParts.push(`locations: [${locations.slice(0, 6).join(", ")}]`);
  if (params.spec?.company?.industries?.length) specSummaryParts.push(`industries: [${params.spec.company.industries.slice(0, 4).join(", ")}]`);
  if (params.spec?.exclusions?.companies?.length) specSummaryParts.push(`excludeCompanies: [${params.spec.exclusions.companies.slice(0, 8).join(", ")}]`);
  const specStr = specSummaryParts.length ? specSummaryParts.join("; ") : "general targeting";

  return `You are a dual-provider B2B prospecting strategist for Apex CRM.

User brief: ${params.query}
Targeting parameters: ${specStr}
Discovery mode: ${discoveryMode}
${requirementDigest}
${missingNote}
${recoveryDirective}
${flywheelNote}
${knownCompaniesNote}
${metroDirectives}
${failNote}

Generate exactly four concise retrieval tasks. This is round ${params.round}/${params.maxRounds}; ${params.remaining} qualified prospects remain.
${previousNote}
Prior round summary: ${roundSummaryStr}
Historical family/provider yield: ${performanceStr}

Rules:
- Query syntax: 3 to 6 words. NEVER use boolean words (AND, OR, NOT), site:, or "LinkedIn". Quotes ONLY for multi-word phrases (e.g. "AI agency"). Negative keywords allowed (-saas, -recruiter).
- Geographies & Titles: Rotate executive variants (founder, CEO, owner, managing partner) and use metro hubs sparingly (max 2 queries should include city names). Never let city names push out core technical or intent terms.
- Lanes & Intent Retention Rule:
  * When the brief or contract specifies explicit intent, tooling, or pain signals (e.g. toolingKeywords like n8n/APIs or painSignals like delivery bottlenecks): at least 2 of the 4 queries MUST combine identity/role terms with an intent or tooling qualifier (e.g. "agency owner n8n", "agency CEO API integrations").
  * NEVER generate 100% bare identity-only queries across all 4 tasks (e.g. do NOT output 4 generic queries like "agency owner Austin").
  * Use lane "person" for identity+intent queries, "account" for company exploration, or "signal" (for open_web_signal requirements e.g. hiring/tooling, use lane: "signal" and search open web). Use >=2 lanes when brief allows.
- Providers: "tavily" (precision person), "brightdata" (volume Google SERP), "corroborate" (both). In hybrid mode, assign >=2 brightdata or corroborate tasks.
- Depth: Default to "basic". Never assume Pro-only datasets or browser automation.
- History: Favor families that produced qualified/returned finalists; avoid duplicate-heavy or slow query patterns.

Return query, family, intent, expectedSignal, priority, lane, providerPreference, searchDepth, topic, timeRange, and country when relevant.`;
};

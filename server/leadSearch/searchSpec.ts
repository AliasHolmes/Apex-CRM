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
      // the documented, operator-controlled value from .env is the only
      // country boost that reaches the API.
      const country = configuredCountry
        ? configuredCountry.toLowerCase()
        : undefined;
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
          excludeDomains: spec.exclusions.domains,
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

import type { ProspectContract } from "./prospectContract.js";

export const buildFallbackQueryPlan = (
  query: string,
  spec?: SearchSpec,
): SearchQueryPlanItem[] => {
  const base = clean(query);
  const lower = base.toLowerCase();
  const effectiveSpec = spec || buildFallbackSearchSpec(query);
  const titles = effectiveSpec.person.includeTitles.length
    ? effectiveSpec.person.includeTitles
    : ["founder", "owner", "CEO", "managing partner"];
  const signal = effectiveSpec.signals.include[0] || "growth hiring";

  // Detect geography and retrieve relevant metro hubs
  let metros: string[] = ["New York", "San Francisco", "Austin", "Los Angeles"];
  let countryAnchor = "USA";
  if (lower.includes("uk") || lower.includes("united kingdom") || lower.includes("london")) {
    metros = METRO_HUBS_BY_COUNTRY.uk;
    countryAnchor = "UK";
  } else if (lower.includes("canada") || lower.includes("toronto")) {
    metros = METRO_HUBS_BY_COUNTRY.canada;
    countryAnchor = "Canada";
  } else if (lower.includes("australia") || lower.includes("sydney")) {
    metros = METRO_HUBS_BY_COUNTRY.australia;
    countryAnchor = "Australia";
  } else if (METRO_HUBS_BY_COUNTRY.usa) {
    metros = METRO_HUBS_BY_COUNTRY.usa;
    countryAnchor = "USA";
  }

  // Extract core company topic/vertical from query
  const cleanTopic = base
    .replace(/\b(from|in|based in|located in|near)\b.*$/i, "")
    .replace(/\b(owner|founder|ceo|co-founder|director|managing partner|president|proprietor)\b/gi, "")
    .replace(/[/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "AI agency";

  const plans: SearchQueryPlanItem[] = [
    {
      query: `${cleanTopic} ${titles[0] || "founder"} ${countryAnchor}`.trim(),
      family: "persona_title",
      intent: "find_decision_makers",
      expectedSignal: "Decision-maker profiles",
      priority: 1,
      lane: "person",
      providerPreference: "tavily",
      searchDepth: "basic",
    },
    {
      query: `${cleanTopic} ${titles[1] || "owner"} ${metros[0] || "New York"}`.trim(),
      family: "persona_title",
      intent: "find_decision_makers",
      expectedSignal: "Decision-maker profiles in top metro",
      priority: 2,
      lane: "person",
      providerPreference: "tavily",
      searchDepth: "basic",
    },
    {
      query: `${cleanTopic} ${titles[2] || "CEO"} ${metros[1] || "San Francisco"}`.trim(),
      family: "company_type",
      intent: "expand_surface_area",
      expectedSignal: "Leadership evidence in tech metro",
      priority: 3,
      lane: "account",
      providerPreference: "brightdata",
      searchDepth: "basic",
    },
    {
      query: `${cleanTopic} ${signal} ${countryAnchor}`.trim(),
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
  logEvent?: (msg: string) => void;
}) => {
  // Token diet: by late rounds the full query history dominates the prompt.
  // Send only the most recent queries plus a compact family-coverage digest.
  const recentQueries = params.previousQueries.slice(-5);
  const familyCounts: Record<string, number> = {};
  for (const q of params.previousQueries) {
    const family = q.split(" ").slice(0, 3).join(" ").toLowerCase();
    familyCounts[family] = (familyCounts[family] || 0) + 1;
  }
  const previousNote = params.previousQueries.length
    ? `Avoid repeats. Already explored ${params.previousQueries.length} queries; most recent: ${recentQueries.join(" | ")}. Covered query prefixes: ${Object.entries(
        familyCounts,
      )
        .map(([family, count]) => `${family} x${count}`)
        .join("; ")}.`
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

  const flywheelNote =
    params.discoveredCompanies && params.discoveredCompanies.length > 0
      ? `\nDISCOVERED COMPANIES WITH ACTIVE SIGNALS (generate person queries targeting decision makers at these companies): ${params.discoveredCompanies.slice(0, 5).join(", ")}`
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
    params.discoveredCompanies &&
    params.discoveredCompanies.length > 0
  ) {
    params.logEvent(
      `[Strategist] Injected reverse flywheel target companies into prompt: [${params.discoveredCompanies.slice(0, 5).join(", ")}]`,
    );
  }

  const roundSummaryRaw = { ...(params.previousRoundSummary || {}) };
  const summaryBullets: string[] = [];
  if (Array.isArray(roundSummaryRaw.missingHardRequirementIds) && roundSummaryRaw.missingHardRequirementIds.length > 0) {
    summaryBullets.push(`Missing requirements: ${roundSummaryRaw.missingHardRequirementIds.slice(0, 5).join(', ')}`);
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
    .slice(0, 8);
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

  const specStr = params.spec ? JSON.stringify(params.spec) : "{}";

  return `You are a dual-provider B2B prospecting strategist for Apex CRM.

User brief: ${params.query}
Structured targeting spec: ${specStr}
Discovery mode: ${discoveryMode}
${requirementDigest}
${missingNote}
${flywheelNote}
${failNote}

Generate exactly four concise retrieval tasks. This is round ${params.round}/${params.maxRounds}; ${params.remaining} qualified prospects remain.
${previousNote}
Prior round summary: ${roundSummaryStr}
Historical family/provider yield: ${performanceStr}

Rules:
- NEVER use boolean operators (AND, OR, NOT, site:, parentheses, or quotes). Use ONLY clean, natural language keyword phrases (3 to 6 words).
- Do not write Google dorks, site:, or the word LinkedIn in query text (providers add LinkedIn constraints).
- Query length must be concise (3 to 6 words).
- When a country or region is targeted (e.g. USA, UK, Canada, Australia), distribute queries across distinct major metropolitan tech/agency hubs (e.g. New York, San Francisco, Austin, Los Angeles, Chicago, Boston, Seattle, London, Toronto, Sydney) and rotate executive title variants (founder, CEO, owner, managing partner) across the 4 queries.
- Use at least two lanes: person, account, signal when the brief supports them.
- person lane finds public professional profiles. Keep person queries focused on Roles + Company Types/Names + Locations. Do NOT append niche hiring or tooling trigger keywords to person queries.
- account lane finds companies and leadership evidence.
- signal lane finds public growth, tooling, hiring, or pain evidence on the open web (not LinkedIn).
- For open_web_signal requirements (e.g. hiring, tech stack, funding), use lane: "signal" and search open web.
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

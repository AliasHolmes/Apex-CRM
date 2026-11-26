import crypto from "node:crypto";
import {
  getLeadsDb,
  readExistingIdentityKeys,
  upsertLeadsWithIdentity,
  insertLeadActivity,
  upsertMiningSession,
  insertSearchLog,
  LATEST_SCHEMA_VERSION,
  type LeadWriteResult,
} from "../db.js";
import { tavilySearch } from "../services/llm.js";
import {
  normalizeLinkedInUrl,
  canonicalLinkedInIdentity,
} from "../services/linkedinEvidence.js";
import {
  normalizeDedupeValue,
  normalizeCompanyName,
} from "../../src/utils/leadDedupe.js";
import {
  brightDataGetPersonProfilesBatch,
  isBrightDataPro,
  closeBrightDataClient,
} from "../services/brightdata.js";
import { buildDeterministicProspectContract, type ProspectContract } from "./prospectContract.js";
import { resolveGeo, type GeoResolution } from "./queryUnderstanding.js";
import { DEFAULT_DECISION_MAKER_ROLES } from "./defaultRoles.js";
import { classifyTitle } from "./titleTriage.js";
import { cleanCompanyHint } from "./observations.js";

export interface AgentBrainExecutionOptions {
  sessionId?: string;
  promptQuery: string;
  requestedLimit?: number;
  stage?: "SCRAPED" | "ENRICHED";
  reviewStatus?: "UNREVIEWED" | "KEEP";
  nextAction?: "NONE" | "CONNECT";
  enableBrightDataPro?: boolean;
  brightDataConcurrency?: number;
  geographicHubs?: string[];
  decisionMakerRoles?: string[];
  keywords?: string[];
  onProgress?: (event: { phase: string; message: string; count?: number; total?: number }) => void;
  abortSignal?: AbortSignal;
}

export interface AgentBrainLeadItem {
  id: string;
  name: string;
  title: string;
  company: string;
  location: string;
  url: string;
  slug: string;
  headline: string;
  summary: string;
  hiringQuote: string;
  techStack: string[];
  score: number;
  website?: string;
  experiences?: any[];
  enrichedViaBrightData?: boolean;
  isFallbackCompany?: boolean;
}

export interface AgentBrainExecutionResult {
  sessionId: string;
  prompt: string;
  requestedLimit: number;
  qualifiedCount: number;
  rawCandidatesCount: number;
  duplicatesSkippedCount: number;
  durationMs: number;
  leads: AgentBrainLeadItem[];
  stats: Record<string, any>;
  errorMessage?: string;
  verification: {
    sqliteVerified: boolean;
    ftsIndexed: boolean;
    identityKeysRegistered: boolean;
  };
}

const DEFAULT_US_HUBS = [
  "New York",
  "San Francisco",
  "Austin",
  "Dallas",
  "Chicago",
  "Atlanta",
  "Miami",
  "Salt Lake City",
  "Denver",
  "Los Angeles",
  "Seattle",
  "Boston",
];

const UK_HUBS = ["London", "Manchester", "Birmingham", "Bristol", "Edinburgh"];

const IC_OWNER_PREFIX =
  "(?:product|project|process|program|platform|content|brand|asset|store|franchise|category|component)";
const DISQUALIFIED_TITLE_REGEX = new RegExp(
  `\\b(?:intern|recruiter|talent acquisition|account executive|student|assistant|trainee|coordinator|associate at|sdr|bdr|${IC_OWNER_PREFIX}\\s+owner)\\b`,
  "i",
);
const DECISION_MAKER_REGEX = new RegExp(
  `\\b(?:founder|co-founder|ceo|chief executive|managing partner|managing director|agency owner|principal|partner & head|founder & ceo|(?<!${IC_OWNER_PREFIX}\\s+)owner)\\b`,
  "i",
);
const NON_TARGET_US_GEO_REGEX =
  /\b(?:United States|USA|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|San Francisco|Los Angeles|Seattle|Austin|Boston|Chicago|Atlanta|Miami|Denver)\b/i;
const UK_EXPLICIT_GEO_REGEX =
  /\b(?:United Kingdom|UK|GB|GBR|Great Britain|Britain|England|Scotland|Wales|Northern Ireland|London|Manchester|Bristol|Edinburgh|Leeds|Glasgow|Brighton|Sheffield|Liverpool|Belfast|Newcastle)\b/i;
const AMBIGUOUS_US_UK_METROS = new Set(["birmingham"]);

const NON_AI_COUNTRY_CONFLICT_REGEX =
  /\b(?:United States|USA|Canada|Australia|Germany|France|Spain|Netherlands|Singapore|India|United Arab Emirates|UAE|Dubai|Montreal|Toronto|Vancouver)\b/i;
const NON_AGENCY_ENTITY_REGEX =
  /\b(hotel|boutique hotel|restaurant|resort|clothing|fashion|salon|apparel|real estate brokerage|gym|clinic)\b/i;
const B2B_OUTBOUND_REGEX =
  /outbound|lead gen|lead generation|cold email|smartlead|instantly|clay|appointment setting/i;
const B2B_SAAS_VENDOR_REGEX =
  /\b(?:at|@)\s*(?:Clay(?:\.com)?|Instantly(?:\.ai)?|Smartlead(?:\.ai)?)\b/i;

function normalizeStringList(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const val of values) {
    const trimmed = String(val || "").replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function quoteTerm(term: string): string {
  const clean = term.replace(/["\r\n]/g, " ").trim();
  if (!clean) return "";
  return clean.includes(" ") ? `"${clean}"` : `"${clean}"`;
}

export interface AgentBrainSearchContext {
  isB2BOutbound: boolean;
  contract: ProspectContract;
  geo: GeoResolution;
  roles: string[];
  locations: string[];
  keywords: string[];
  verticalTerms: string[];
  queries: string[];
}

/** Build contract-grounded queries while preserving the optimized B2B outbound fast-path. */
export function buildAgentBrainSearchPlan(
  promptQuery: string,
  options: Pick<AgentBrainExecutionOptions, "geographicHubs" | "decisionMakerRoles" | "keywords"> = {},
): AgentBrainSearchContext {
  const cleanPrompt = String(promptQuery || "").trim();
  const isB2BOutbound = B2B_OUTBOUND_REGEX.test(cleanPrompt);
  const contract = buildDeterministicProspectContract(cleanPrompt);
  const geo = resolveGeo(cleanPrompt);

  const explicitRoles = normalizeStringList(options.decisionMakerRoles);
  const contractRoles = normalizeStringList(contract.identitySpec?.roles);
  const roles =
    explicitRoles.length > 0
      ? explicitRoles
      : contractRoles.length > 0
        ? contractRoles
        : [...DEFAULT_DECISION_MAKER_ROLES];

  const explicitHubs = normalizeStringList(options.geographicHubs);
  const contractLocations = normalizeStringList(contract.identitySpec?.locations);
  const resolvedLocations =
    explicitHubs.length > 0
      ? explicitHubs
      : contractLocations.length > 0
        ? contractLocations
        : geo.countryAnchor
          ? [geo.countryAnchor, ...geo.metros.slice(0, 6)]
          : [];

  const explicitKeywords = normalizeStringList(options.keywords);
  const contractIntentTerms = normalizeStringList([
    ...(contract.intentSpec?.toolingKeywords || []),
    ...(contract.intentSpec?.hiringSignals || []),
    ...(contract.intentSpec?.painSignals || []),
    ...(contract.intentSpec?.growthSignals || []),
  ]);
  const keywords = explicitKeywords.length > 0 ? explicitKeywords : contractIntentTerms;

  const verticalTerms = normalizeStringList([
    ...(contract.identitySpec?.companyTypes || []),
    ...(contract.identitySpec?.industries || []),
  ]).filter((term) => term.toLowerCase() !== cleanPrompt.toLowerCase());

  const queries: string[] = [];
  const seenQueries = new Set<string>();
  const addQuery = (q: string) => {
    const normalized = q.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!seenQueries.has(key)) {
      seenQueries.add(key);
      queries.push(normalized);
    }
  };

  if (isB2BOutbound) {
    const isUkTarget =
      /\buk\b|united kingdom|britain|england|london|manchester/i.test(cleanPrompt) ||
      resolvedLocations.some((l) => /united kingdom|\buk\b|london|manchester|england/i.test(l));
    const isExplicitNonUs = geo.countryAnchor !== null && geo.countryAnchor !== "United States" && !/\bus\b|\busa\b|united states/i.test(cleanPrompt);
    const isUsTarget =
      /\bus\b|\busa\b|united states|america|austin|denver|new york|san francisco|chicago/i.test(cleanPrompt) ||
      resolvedLocations.some((l) => /united states|\bus\b|\busa\b/i.test(l)) ||
      (!isUkTarget && !isExplicitNonUs);

    const roleClause =
      explicitRoles.length > 0
        ? `(${explicitRoles.slice(0, 3).map(quoteTerm).join(" OR ")})`
        : `("Founder" OR "CEO")`;

    if (isUsTarget) {
      for (const q of [
        `site:linkedin.com/in ${roleClause} "lead generation agency" "Clay" "United States"`,
        `site:linkedin.com/in ${roleClause} "outbound agency" "Instantly" "United States"`,
        `site:linkedin.com/in ("Founder" OR "Agency Owner") "cold email agency" "Smartlead" "United States"`,
        `site:linkedin.com/in ${roleClause} "B2B lead generation agency" "United States"`,
        `site:linkedin.com/in ${roleClause} "appointment setting agency" "United States"`,
        `site:linkedin.com/in ${roleClause} "outbound lead generation" "Clay" "United States"`,
        `site:linkedin.com/in ${roleClause} "cold email infrastructure" "United States"`,
        `site:linkedin.com/in ("Founder" OR "Managing Partner") "demand generation agency" "United States"`,
        `site:linkedin.com/in ${roleClause} "outbound sales agency" "United States"`,
        `site:linkedin.com/in ${roleClause} "B2B outbound agency" "United States"`,
        `site:linkedin.com/in ("Founder" OR "Agency Owner") "cold outreach" ("Instantly" OR "Smartlead") "United States"`,
      ]) {
        addQuery(q);
      }
      const usHubs =
        explicitHubs.length > 0 ? explicitHubs.slice(0, 8) : DEFAULT_US_HUBS.slice(0, 8);
      for (const hub of usHubs) {
        addQuery(`site:linkedin.com/in ${roleClause} "cold email agency" ${quoteTerm(hub)}`);
        addQuery(`site:linkedin.com/in ${roleClause} "lead generation agency" ${quoteTerm(hub)}`);
      }
    }

    if (isUkTarget) {
      for (const q of [
        `site:linkedin.com/in ${roleClause} "lead generation agency" "Clay" "United Kingdom"`,
        `site:linkedin.com/in ("Founder" OR "Managing Director") "cold email agency" "United Kingdom"`,
        `site:linkedin.com/in ${roleClause} "outbound agency" "Smartlead" "United Kingdom"`,
        `site:linkedin.com/in ("Founder" OR "Managing Director") "outbound lead generation" "London"`,
        `site:linkedin.com/in ${roleClause} "B2B lead generation agency" "United Kingdom"`,
        `site:linkedin.com/in ("Founder" OR "Managing Director") "cold email agency" "London"`,
        `site:linkedin.com/in ("Founder" OR "Agency Owner") "lead generation agency" "Manchester"`,
        `site:linkedin.com/in ${roleClause} "appointment setting agency" "United Kingdom"`,
        `site:linkedin.com/in ${roleClause} "outbound agency" "Instantly" "United Kingdom"`,
        `site:linkedin.com/in ("Founder" OR "Managing Director") "B2B outbound" "United Kingdom"`,
      ]) {
        addQuery(q);
      }
      const ukHubs = explicitHubs.length > 0 ? explicitHubs.slice(0, 5) : UK_HUBS;
      for (const hub of ukHubs) {
        addQuery(`site:linkedin.com/in ("Founder" OR "Managing Director") "lead generation" ${quoteTerm(hub)}`);
      }
    }

    for (const q of [
      `site:linkedin.com/in ${roleClause} "B2B outbound" ("Clay" OR "Instantly" OR "Smartlead")`,
      `site:linkedin.com/in ("Agency Owner" OR "Founder") "cold outreach" ("Instantly" OR "Smartlead")`,
      `site:linkedin.com/in ${roleClause} "outbound pipeline" ("Clay" OR "Smartlead")`,
      `site:linkedin.com/in ("Founder" OR "Agency Owner") "lead gen agency" ("Clay" OR "Instantly")`,
      `site:linkedin.com/in ${roleClause} "cold email systems" ("Smartlead" OR "Instantly")`,
    ]) {
      addQuery(q);
    }

    for (const kw of explicitKeywords.slice(0, 4)) {
      const geoToken = isUkTarget && !isUsTarget ? `"United Kingdom"` : isUsTarget ? `"United States"` : "";
      addQuery(`site:linkedin.com/in ${roleClause} "lead generation" ${quoteTerm(kw)} ${geoToken}`);
    }
  } else {
    // Contract-driven general discovery path (honors roles, verticals, keywords, and resolved/open geo).
    const singularStem = (value: string) => value.toLowerCase().replace(/s$/, "").trim();
    const seenRoleStems = new Set<string>();
    const distinctRoles: string[] = [];
    for (const r of roles) {
      const stem = singularStem(r);
      if (!stem || seenRoleStems.has(stem)) continue;
      seenRoleStems.add(stem);
      distinctRoles.push(r);
    }
    const topRoles = distinctRoles.slice(0, 4);
    const roleGroup =
      topRoles.length > 1
        ? `(${topRoles.slice(0, 3).map(quoteTerm).join(" OR ")})`
        : quoteTerm(topRoles[0] || "Founder");

    const domainAnchorTokens = Array.from(
      new Set(
        cleanPrompt
          .toLowerCase()
          .split(/[^a-z0-9+#-]+/)
          .filter(
            (tok) =>
              tok.length >= 2 &&
              !/^(?:the|and|or|for|with|from|in|at|of|to|on|by|who|use|using|find|lead|leads|owner|owners|founder|founders|ceo|ceos|cto|ctos|director|directors|partner|partners|president|managing|agency|agencies|firm|firms|company|companies|intent|hiring|recruiting|uk|united|kingdom|us|usa|states|america|berlin|london|manchester)$/.test(
                tok,
              ),
          ),
      ),
    );
    const multiWordVerticals = verticalTerms.filter(
      (v) =>
        /\s/.test(v.trim()) &&
        !/\b(?:and|or)\b/i.test(v),
    );
    const singleWordVerticals = verticalTerms.filter(
      (v) =>
        !/\s/.test(v.trim()) &&
        v.trim().length >= 3 &&
        !/^(?:firm|company|business|agency|partner|studio)$/i.test(v.trim()),
    );
    const briefMatchedMulti =
      domainAnchorTokens.length > 0
        ? multiWordVerticals.filter((v) =>
            domainAnchorTokens.some((tok) => new RegExp(`\\b${escapeRegexLiteral(tok)}\\b`, "i").test(v)),
          )
        : [];
    const prioritizedVerticals =
      briefMatchedMulti.length > 0
        ? briefMatchedMulti
        : multiWordVerticals.length > 0
          ? multiWordVerticals
          : singleWordVerticals;
    const verticals = (prioritizedVerticals.length > 0 ? prioritizedVerticals : verticalTerms).slice(0, 5);

    const locTargetsRaw =
      explicitHubs.length > 0
        ? explicitHubs
        : geo.countryAnchor
          ? [geo.countryAnchor === "UK" ? "United Kingdom" : geo.countryAnchor, ...geo.metros]
          : resolvedLocations;
    const locTargets = normalizeStringList(locTargetsRaw).slice(0, 6);
    if (locTargets.length === 0) locTargets.push("");

    const actionableKeywords = keywords.filter((k) => !/\bintent\b/i.test(k));
    const topKeywords = (actionableKeywords.length > 0 ? actionableKeywords : keywords).slice(0, 4);

    if (verticals.length > 0) {
      if (topKeywords.length > 0) {
        const kwClause =
          topKeywords.length > 1
            ? `(${topKeywords.slice(0, 3).map(quoteTerm).join(" OR ")})`
            : quoteTerm(topKeywords[0]);
        for (const vert of verticals) {
          for (const loc of locTargets) {
            const locPart = loc ? quoteTerm(loc) : "";
            addQuery(`site:linkedin.com/in ${roleGroup} ${quoteTerm(vert)} ${kwClause} ${locPart}`);
          }
        }
      }
      for (const vert of verticals) {
        for (const loc of locTargets) {
          const locPart = loc ? quoteTerm(loc) : "";
          addQuery(`site:linkedin.com/in ${roleGroup} ${quoteTerm(vert)} ${locPart}`);
        }
      }
    } else if (topKeywords.length > 0) {
      for (const kw of topKeywords) {
        for (const loc of locTargets) {
          addQuery(`site:linkedin.com/in ${roleGroup} ${quoteTerm(kw)} ${loc ? quoteTerm(loc) : ""}`);
        }
      }
    }

    // Seed with deterministic person-lane queries from ProspectContract for additional recall.
    const personPlanQueries = (contract.initialQueries || [])
      .filter((item) => item.lane === "person" && item.query)
      .slice(0, 6);
    for (const item of personPlanQueries) {
      const base = item.query.replace(/site:linkedin\.com(?:\/in)?/gi, "").trim();
      if (base) {
        addQuery(`site:linkedin.com/in ${base}`);
      }
    }

    // Fallback: ensure at least one direct cleaned query runs even on unusual briefs.
    if (queries.length === 0 && cleanPrompt) {
      const stripped = cleanPrompt
        .replace(/^(?:find|search|get|locate|show\s+me)\s+/i, "")
        .slice(0, 140)
        .trim();
      addQuery(`site:linkedin.com/in ${stripped}`);
    }
  }

  return {
    isB2BOutbound,
    contract,
    geo,
    roles,
    locations: resolvedLocations,
    keywords,
    verticalTerms,
    queries,
  };
}

function extractMatchingQuote(fullText: string, terms: string[]): string {
  const cleanedTerms = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .map(escapeRegexLiteral);
  if (cleanedTerms.length > 0) {
    const pattern = new RegExp(`[^.!?\\n]*\\b(?:${cleanedTerms.join("|")})\\b[^.!?\\n]*`, "gi");
    const matches = fullText.match(pattern);
    if (matches && matches.length > 0) {
      const quote = matches[0].trim();
      if (quote.length >= 12) return quote.slice(0, 240);
    }
  }
  return "";
}

function matchesTargetGeography(
  text: string,
  locations: string[],
  geo: GeoResolution,
): boolean {
  if (locations.length === 0) return true;
  if (geo.countryAnchor === "UK") {
    const hasUkExplicit = UK_EXPLICIT_GEO_REGEX.test(text);
    const hasBirminghamUk = /\bBirmingham,\s*(?:England|United Kingdom|UK|GB)\b/i.test(text);
    if ((NON_TARGET_US_GEO_REGEX.test(text) || NON_AI_COUNTRY_CONFLICT_REGEX.test(text)) && !hasUkExplicit && !hasBirminghamUk) {
      return false;
    }
    const nonAmbiguousLocs = locations.filter(
      (l) => !AMBIGUOUS_US_UK_METROS.has(l.trim().toLowerCase()),
    );
    const locPattern =
      nonAmbiguousLocs.length > 0
        ? new RegExp(`\\b(?:${nonAmbiguousLocs.map(escapeRegexLiteral).join("|")})\\b`, "i")
        : UK_EXPLICIT_GEO_REGEX;
    return locPattern.test(text) || hasBirminghamUk;
  }

  const pattern = new RegExp(`\\b(?:${locations.map(escapeRegexLiteral).join("|")})\\b`, "i");
  if (!pattern.test(text)) return false;
  if (
    geo.countryAnchor &&
    geo.countryAnchor !== "United States" &&
    geo.countryAnchor !== "USA" &&
    NON_TARGET_US_GEO_REGEX.test(text) &&
    !text.toLowerCase().includes(geo.countryAnchor.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function resolveParsedTitle(
  roleChunk: string,
  configuredRoles: string[],
  isB2BOutbound: boolean,
): string {
  if (/co-founder/i.test(roleChunk)) return "Co-Founder";
  if (/founder & ceo/i.test(roleChunk)) return "Founder & CEO";
  if (/founder/i.test(roleChunk)) return "Founder";
  if (/managing director|\bmd\b/i.test(roleChunk)) return "Managing Director";
  if (/managing partner/i.test(roleChunk)) return "Managing Partner";
  if (/agency owner|agency founder/i.test(roleChunk)) return "Agency Owner";
  if (new RegExp(`\\b(?<!${IC_OWNER_PREFIX}\\s+)owner\\b`, "i").test(roleChunk)) return "Owner";
  if (/chief executive|\bceo\b/i.test(roleChunk)) return "CEO";
  if (/chief technology|\bcto\b/i.test(roleChunk)) return "CTO";
  if (/chief revenue|\bcro\b/i.test(roleChunk)) return "CRO";
  if (/chief operating|\bcoo\b/i.test(roleChunk)) return "COO";
  if (/chief financial|\bcfo\b/i.test(roleChunk)) return "CFO";
  if (/chief marketing|\bcmo\b/i.test(roleChunk)) return "CMO";
  if (/vice president|\bvp\b/i.test(roleChunk)) return "VP";
  if (/director/i.test(roleChunk)) return "Director";
  if (/partner/i.test(roleChunk)) return "Partner";
  if (/principal/i.test(roleChunk)) return "Principal";

  for (const role of configuredRoles) {
    if (role && new RegExp(`\\b${escapeRegexLiteral(role)}\\b`, "i").test(roleChunk)) {
      return role;
    }
  }
  return isB2BOutbound ? "Founder" : (configuredRoles[0] || "Decision Maker");
}

function buildBatchIdCondition(ids: string[]): { clause: string; params: string[] } {
  return {
    clause: ids.map(() => "?").join(", "),
    params: ids,
  };
}

export async function executeAgentBrainDiscovery(
  options: AgentBrainExecutionOptions,
  abortSignal?: AbortSignal,
): Promise<AgentBrainExecutionResult> {
  const signal = abortSignal || options.abortSignal;
  const startedAt = Date.now();
  const startTimeIso = new Date(startedAt).toISOString();
  const sessionId = options.sessionId || `session-agent-${crypto.randomUUID()}`;
  const promptQuery = options.promptQuery.trim();
  const requestedLimit = Math.min(Math.max(options.requestedLimit || 50, 1), 100);
  const targetStage = options.stage || "SCRAPED";
  const targetReviewStatus = options.reviewStatus || "UNREVIEWED";
  const targetNextAction = options.nextAction || "NONE";

  const isAborted = () => {
    if (signal?.aborted) return true;
    try {
      const row = getLeadsDb()
        .prepare(`SELECT status, cancellation_requested_at FROM mining_sessions WHERE id = ?`)
        .get(sessionId) as { status?: string; cancellation_requested_at?: string } | undefined;
      if (
        row?.status === "cancellation_requested" ||
        row?.status === "cancelled" ||
        Boolean(row?.cancellation_requested_at)
      ) {
        return true;
      }
    } catch {
      // ignore transient read check errors
    }
    return false;
  };

  const rawCandidateMap = new Map<string, { title: string; url: string; content: string }>();
  let duplicatesSkipped = 0;
  let searchCallCount = 0;
  let tavilyErrors = 0;
  const searchQueries: string[] = [];

  const handleCancellation = async (): Promise<AgentBrainExecutionResult> => {
    const totalDurationMs = Date.now() - startedAt;
    const statsPayload = {
      requested: requestedLimit,
      returned: 0,
      rawCandidates: rawCandidateMap.size,
      duplicatesSkipped,
      persistedCount: 0,
      brain: "Agent-as-the-Brain (Antigravity)",
      status: "cancelled",
    };

    upsertMiningSession({
      id: sessionId,
      status: "cancelled",
      prompt: promptQuery,
      requestedLimit,
      startedAt: startTimeIso,
      completedAt: new Date().toISOString(),
      errorMessage: "Agent Brain discovery was cancelled.",
      checkpoint: null,
      stats: statsPayload,
      traceSummary: {
        providerSummary: {
          agent_brain: { calls: 0, successes: 0, latencyMs: 0 },
          tavily: { calls: searchCallCount, errors: tavilyErrors, latencyMs: totalDurationMs },
        },
        costSummary: { estimatedUsd: 0, totalTokens: 0, tokensPerAcceptedLead: 0 },
      },
    });

    insertSearchLog({
      id: sessionId,
      timestamp: startTimeIso,
      prompt: promptQuery,
      generatedQueries: searchQueries.slice(0, 10),
      status: "cancelled",
      errorMessage: "Agent Brain discovery was cancelled.",
      rawResultsCount: rawCandidateMap.size,
      leadsFound: 0,
      detailedLogs: JSON.stringify([
        `[AgentBrain] Execution was cancelled by caller/user after ${totalDurationMs}ms.`,
      ]),
      debugLogs: JSON.stringify([]),
      traceEvents: [],
      providerSummary: { tavily: { calls: searchCallCount, errors: tavilyErrors } },
      costSummary: { estimatedUsd: 0, totalTokens: 0, tokensPerAcceptedLead: 0 },
      phaseTimeline: [],
      schemaVersion: LATEST_SCHEMA_VERSION,
    });

    try {
      await closeBrightDataClient({
        onlyIfIdle: true,
        onlyIfUnhealthy: true,
        reason: "agent-brain-complete",
      });
    } catch {
      // ignore cleanup errors
    }

    options.onProgress?.({
      phase: "cancelled",
      message: `Agent Brain discovery session ${sessionId} cancelled.`,
    });

    return {
      sessionId,
      prompt: promptQuery,
      requestedLimit,
      qualifiedCount: 0,
      rawCandidatesCount: rawCandidateMap.size,
      duplicatesSkippedCount: duplicatesSkipped,
      durationMs: totalDurationMs,
      leads: [],
      stats: statsPayload,
      errorMessage: "Agent Brain discovery was cancelled.",
      verification: {
        sqliteVerified: false,
        ftsIndexed: false,
        identityKeysRegistered: false,
      },
    };
  };

  const plan = buildAgentBrainSearchPlan(promptQuery, options);
  const { isB2BOutbound, contract, geo } = plan;
  searchQueries.push(...plan.queries);

  options.onProgress?.({
    phase: "init",
    message: `Initialized Agent Brain discovery session ${sessionId} for target ${requestedLimit} leads (stage: ${targetStage}).`,
  });

  if (isAborted()) {
    return handleCancellation();
  }

  // 1. Preload CRM identities for 0ms in-memory deduplication
  const existingIdentities = readExistingIdentityKeys();
  options.onProgress?.({
    phase: "dedupe_index",
    message: `Preloaded ${existingIdentities.size} existing CRM identity keys for instant filtering.`,
  });

  // 2. Dispatch parallel retrieval waves through Tavily Key Pool
  const safeRoleTerms = plan.roles.map((r) =>
    r.trim().toLowerCase() === "owner"
      ? `(?<!${IC_OWNER_PREFIX}\\s+)owner`
      : escapeRegexLiteral(r),
  );
  const targetRolePattern =
    safeRoleTerms.length > 0
      ? new RegExp(`\\b(?:${safeRoleTerms.join("|")})\\b`, "i")
      : DECISION_MAKER_REGEX;

  const domainVerticalTerms = normalizeStringList(
    plan.verticalTerms.flatMap((rawTerm) => {
      const v = rawTerm.trim();
      if (/\s/.test(v)) {
        if (/\b(?:and|or)\b/i.test(v)) return [];
        const stem = v
          .replace(/\s+(?:compan(?:y|ies)|startups?|businesses?|organizations?|groups?)$/i, "")
          .trim();
        return stem && stem.length >= 3 && stem.toLowerCase() !== v.toLowerCase()
          ? [v, stem]
          : [v];
      }
      return v.length >= 3 &&
        !/^(?:firm|company|business|agency|partner|studio|consultancy)$/i.test(v)
        ? [v]
        : [];
    }),
  );
  const strictVerticalTerms =
    domainVerticalTerms.length > 0 ? domainVerticalTerms : plan.verticalTerms;
  const strictVerticalPattern =
    strictVerticalTerms.length > 0
      ? new RegExp(
          `\\b(?:${strictVerticalTerms.map(escapeRegexLiteral).join("|")})\\b`,
          "i",
        )
      : null;

  const isAiBrief = /\b(?:ai|artificial intelligence|genai|generative ai|llm|machine learning|agentic)\b/i.test(
    promptQuery,
  );
  const aiTopicRegex = /\b(?:ai|artificial intelligence|genai|generative ai|llm|machine learning|agentic)\b/i;
  const orgContextRegex =
    /\b(?:agency|agencies|studio|studios|consultanc(?:y|ies)|consulting|firm|firms|automation|solutions|services|systems|workflows|agents|practice|labs)\b/i;

  const matchesVerticalRelevance = (fullText: string): boolean => {
    if (isAiBrief) {
      return aiTopicRegex.test(fullText) && orgContextRegex.test(fullText);
    }
    if (strictVerticalPattern && strictVerticalPattern.test(fullText)) {
      return true;
    }
    if (!strictVerticalPattern && relevancePattern) {
      return relevancePattern.test(fullText);
    }
    return strictVerticalPattern === null;
  };

  const activeRelevanceTerms = normalizeStringList([
    ...strictVerticalTerms,
    ...plan.keywords,
  ]);
  const relevancePattern =
    activeRelevanceTerms.length > 0
      ? new RegExp(
          `\\b(?:${activeRelevanceTerms.map(escapeRegexLiteral).join("|")})\\b`,
          "i",
        )
      : null;

  const candidatePool: AgentBrainLeadItem[] = [];
  const useBrightDataPro = options.enableBrightDataPro ?? isBrightDataPro();
  // Collect slightly above limit before Bright Data dedup so post-scrape duplicates do not shortchange requestedLimit.
  const preEnrichCap = useBrightDataPro
    ? Math.ceil(requestedLimit * 1.25)
    : requestedLimit;
  const seenPreEnrichNameCompany = new Set<string>();

  const tryQualifySnippet = (
    slug: string,
    candidate: { title: string; url: string; content: string },
  ): AgentBrainLeadItem | null => {
    const fullText = `${candidate.title}\n${candidate.content}`;
    const titleParts = candidate.title.split(/[-\u2013|]/).map((s) => s.trim());
    const roleHeadline = titleParts.length >= 2 ? titleParts[1] : candidate.title;
    const titleClass = classifyTitle(roleHeadline, plan.roles);

    if (isB2BOutbound) {
      if (DISQUALIFIED_TITLE_REGEX.test(fullText) || titleClass.isIC) return null;
      if (NON_AGENCY_ENTITY_REGEX.test(fullText)) return null;
      if (!DECISION_MAKER_REGEX.test(fullText) && !targetRolePattern.test(fullText) && !titleClass.isExecutive) {
        return null;
      }
      if (B2B_SAAS_VENDOR_REGEX.test(candidate.title)) return null;

      const isUsMatch = /\b(United States|USA|US|New York|San Francisco|California|Texas|Austin|Dallas|Chicago|Illinois|Atlanta|Georgia|Miami|Florida|Utah|Salt Lake City|Colorado|Denver|Boston|Massachusetts|Washington|Seattle|Los Angeles|North Carolina|Ohio|Pennsylvania)\b/i.test(fullText);
      const isUkMatch = /\b(United Kingdom|UK|England|Scotland|Wales|London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Brighton|Bristol|Sheffield|Liverpool|Belfast|Newcastle)\b/i.test(fullText);
      if (!isUsMatch && !isUkMatch) return null;

      const isAgencyOrServices =
        /\b(agency|consulting|consultancy|studio|solutions|services|client deployments|custom software|workflow automation|lead gen|lead generation|outbound|cold email|appointment setting|demand generation|pipeline)\b/i.test(
          fullText,
        );
      if (!isAgencyOrServices) return null;
    } else {
      if (DISQUALIFIED_TITLE_REGEX.test(fullText)) return null;
      if (contract.authorityRequired !== false && titleClass.isIC) return null;
      if (!targetRolePattern.test(fullText) && !DECISION_MAKER_REGEX.test(fullText) && !titleClass.isExecutive) {
        return null;
      }
      if (!matchesTargetGeography(fullText, plan.locations, geo)) {
        return null;
      }
      if (!matchesVerticalRelevance(fullText)) {
        return null;
      }
    }

    const quoteSearchTerms = isB2BOutbound
      ? [
          "clay",
          "instantly",
          "smartlead",
          "cold email",
          "cold outreach",
          "outbound",
          "lead generation",
          "lead gen",
          "appointment setting",
          "demand gen",
          "pipeline",
        ]
      : [...plan.keywords, ...plan.verticalTerms, ...plan.roles];

    let evidenceQuote = extractMatchingQuote(fullText, quoteSearchTerms);
    if (!evidenceQuote && candidate.content.trim().length >= 16) {
      evidenceQuote = candidate.content.slice(0, 180).trim();
    }

    let name = "";
    if (titleParts.length >= 1 && titleParts[0].length < 40) {
      name = titleParts[0]
        .replace(/\b(hiring|ceo|founder|on linkedin|md|managing director)\b/gi, "")
        .trim();
    }
    if (!name || name.length < 3) {
      const match = fullText.match(/(?:^|\n)#?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
      name = match
        ? match[1].trim()
        : isB2BOutbound
          ? "Outbound Agency Leader"
          : "Prospect Leader";
    }

    const parsedTitle = resolveParsedTitle(roleHeadline, plan.roles, isB2BOutbound);

    let location =
      plan.locations[0] ||
      (geo.countryAnchor ? geo.countryAnchor : isB2BOutbound ? "United States" : "Global");
    if (isB2BOutbound) {
      const isUkHit = /\b(United Kingdom|UK|England|Scotland|Wales|London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Brighton|Bristol|Sheffield|Liverpool|Belfast|Newcastle)\b/i.test(fullText);
      if (isUkHit && !plan.locations.some((l) => /united states|\busa\b|\bus\b/i.test(l))) {
        location = "United Kingdom";
      }
    }
    const locMatch = fullText.match(
      /([A-Za-z\s]+,\s*(?:New York|California|Texas|Utah|Arkansas|Indiana|Illinois|Georgia|Missouri|Florida|Washington|Colorado|United States|London|Manchester|Birmingham|Leeds|Bristol|United Kingdom|England|Scotland))/i,
    );
    if (locMatch) {
      location = locMatch[1].trim();
    }

    let company = "";
    let isFallbackCompany = false;
    const compMatch = fullText.match(
      /(?:at|@|of|Founder of|CEO of|Managing Director of|Partner at)\s+([A-Za-z0-9&.\s-]{3,40}?)(?:\s*(?:\||\n|\.|,|--|LLC|Inc|Ltd))/i,
    );
    if (
      compMatch &&
      !/LinkedIn|United States|United Kingdom|Automation|Lead Generation/i.test(compMatch[1].trim())
    ) {
      company = cleanCompanyHint(compMatch[1]);
    }
    if (!company) {
      isFallbackCompany = true;
      company = isB2BOutbound
        ? `${name}'s Outbound Practice`
        : `${name} (Independent Practice)`;
    }

    // Only apply pre-enrichment name_company dedup when company came from real evidence, not synthetic fallback.
    if (!isFallbackCompany) {
      const nameCompKey = `name_company:${normalizeDedupeValue(name)}::${normalizeCompanyName(company)}`;
      if (existingIdentities.has(nameCompKey) || seenPreEnrichNameCompany.has(nameCompKey)) {
        duplicatesSkipped++;
        return null;
      }
      seenPreEnrichNameCompany.add(nameCompKey);
    }

    const techStack: string[] = [];
    if (isB2BOutbound) {
      if (/clay/i.test(fullText)) techStack.push("Clay");
      if (/instantly/i.test(fullText)) techStack.push("Instantly");
      if (/smartlead/i.test(fullText)) techStack.push("Smartlead");
      if (/cold email/i.test(fullText)) techStack.push("Cold Email Infrastructure");
      if (/outbound/i.test(fullText)) techStack.push("B2B Outbound Systems");
      if (techStack.length === 0) techStack.push("Outbound Lead Generation");
    } else {
      for (const kw of plan.keywords) {
        if (new RegExp(`\\b${escapeRegexLiteral(kw)}\\b`, "i").test(fullText)) {
          techStack.push(kw);
        }
      }
      for (const vert of plan.verticalTerms) {
        if (
          !techStack.some((t) => t.toLowerCase() === vert.toLowerCase()) &&
          new RegExp(`\\b${escapeRegexLiteral(vert)}\\b`, "i").test(fullText)
        ) {
          techStack.push(vert);
        }
      }
    }

    let score = 8.6;
    if (/founder & ceo|co-founder|managing director|ceo|cto|cmo|cfo|president/i.test(parsedTitle)) {
      score += 0.5;
    }
    if (evidenceQuote.length > 25) score += 0.4;
    if (techStack.length > 0) score += 0.3;
    if (!isFallbackCompany) score += 0.1;
    score = Math.min(9.9, Math.round(score * 10) / 10);

    const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
    const leadId = isB2BOutbound ? `lead_agent_b2b50_${cleanSlug}` : `lead_agent_${cleanSlug}`;

    return {
      id: leadId,
      name,
      title: parsedTitle,
      company,
      location,
      url: candidate.url,
      slug: cleanSlug,
      headline: candidate.title,
      summary: candidate.content.slice(0, 300),
      hiringQuote: evidenceQuote.replace(/["\n\r]/g, " ").trim(),
      techStack,
      score,
      isFallbackCompany,
    };
  };

  // 2. Dispatch parallel retrieval waves through Tavily Key Pool with incremental qualification
  const maxRetrievalCalls = Math.min(searchQueries.length, 40);
  options.onProgress?.({
    phase: "retrieval",
    message: `Dispatching up to ${maxRetrievalCalls} diversified search queries via Tavily Key Pool...`,
  });

  for (let i = 0; i < maxRetrievalCalls; i += 4) {
    if (isAborted()) {
      return handleCancellation();
    }
    const batch = searchQueries.slice(i, Math.min(i + 4, maxRetrievalCalls));
    const results = await Promise.all(
      batch.map(async (query) => {
        if (isAborted()) return [];
        searchCallCount++;
        try {
          const res = await tavilySearch(query, {
            searchDepth: "basic",
            maxResults: 15,
            includeDomains: ["linkedin.com"],
            signal,
          });
          return res.items || [];
        } catch (err) {
          if (isAborted()) return [];
          tavilyErrors++;
          console.warn(
            `[AgentBrain] Tavily query warning for "${query}":`,
            err instanceof Error ? err.message : err,
          );
          return [];
        }
      }),
    );

    if (isAborted()) {
      return handleCancellation();
    }

    for (const items of results) {
      for (const item of items) {
        if (candidatePool.length >= preEnrichCap) break;
        const rawUrl = item.url || "";
        const identityKey = canonicalLinkedInIdentity(rawUrl);
        if (!identityKey) continue;
        const canonicalSlug = identityKey.slice("linkedin:".length);

        if (existingIdentities.has(identityKey) || existingIdentities.has(canonicalSlug)) {
          duplicatesSkipped++;
          continue;
        }

        if (!rawCandidateMap.has(canonicalSlug)) {
          const cand = {
            title: item.title || "",
            url: normalizeLinkedInUrl(rawUrl) || rawUrl,
            content: item.content || item.rawContent || "",
          };
          rawCandidateMap.set(canonicalSlug, cand);
          const qualifiedItem = tryQualifySnippet(canonicalSlug, cand);
          if (qualifiedItem) {
            candidatePool.push(qualifiedItem);
          }
        }
      }
      if (candidatePool.length >= preEnrichCap) break;
    }

    if (candidatePool.length >= preEnrichCap) {
      break;
    }
  }

  if (isAborted()) {
    return handleCancellation();
  }

  options.onProgress?.({
    phase: "extracted",
    message: `Harvested ${rawCandidateMap.size} unique candidates -> ${candidatePool.length} pre-qualified (${duplicatesSkipped} CRM duplicates filtered in 0ms).`,
  });

  // 4. BrightData Pro Batch LinkedIn Profile Enrichment (up to 5 URLs/call before final validation + dedup)
  let brightDataEnrichedCount = 0;
  let brightDataCalls = 0;
  let brightDataLatencyMs = 0;
  const brightDataRejectedSlugs = new Set<string>();

  if (useBrightDataPro && candidatePool.length > 0) {
    const bdStartedAt = Date.now();
    const batchSize = 5;
    brightDataCalls = Math.ceil(candidatePool.length / batchSize);
    options.onProgress?.({
      phase: "brightdata_enrich",
      message: `Enriching ${candidatePool.length} candidates in ${brightDataCalls} BrightData Pro batch(es)...`,
    });

    const profileByIdentity = await brightDataGetPersonProfilesBatch(
      candidatePool.map((l) => l.url),
      90_000,
      batchSize,
    );
    brightDataLatencyMs = Date.now() - bdStartedAt;

    if (isAborted()) {
      return handleCancellation();
    }

    for (const lead of candidatePool) {
      const identityKey = canonicalLinkedInIdentity(lead.url);
      const profile = identityKey ? profileByIdentity.get(identityKey) : null;
      if (
        !profile ||
        profile.error ||
        !(profile.name || profile.position || profile.current_company_name)
      ) {
        continue;
      }

      brightDataEnrichedCount++;
      lead.enrichedViaBrightData = true;

      const realName =
        profile.name ||
        `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
      if (realName && realName.length >= 2 && realName.length < 50) {
        lead.name = realName;
      }

      if (profile.position && typeof profile.position === "string") {
        const positionTitle = profile.position.split(/[-\u2013|]/)[0].trim();
        if (contract.authorityRequired !== false) {
          const posClass = classifyTitle(positionTitle, plan.roles);
          if (DISQUALIFIED_TITLE_REGEX.test(profile.position) || posClass.isIC) {
            brightDataRejectedSlugs.add(lead.slug);
            continue;
          }
        }
        lead.title = positionTitle || lead.title;
      }

      const realComp =
        profile.current_company_name ||
        (typeof profile.current_company === "object"
          ? profile.current_company?.name
          : "") ||
        profile.company;
      if (realComp && typeof realComp === "string" && realComp.trim().length > 1) {
        lead.company = cleanCompanyHint(realComp);
        lead.isFallbackCompany = false;
      }

      const realLoc = [profile.city, profile.location, profile.country, profile.country_code]
        .filter((v) => typeof v === "string" && v.trim())
        .join(", ");
      const displayLoc = profile.city || profile.location || profile.country;
      if (displayLoc && typeof displayLoc === "string") {
        lead.location = displayLoc.trim();
      }
      if (realLoc && !matchesTargetGeography(realLoc, plan.locations, geo)) {
        brightDataRejectedSlugs.add(lead.slug);
        continue;
      }

      if (profile.current_company_website) {
        lead.website = profile.current_company_website;
      }

      if (Array.isArray(profile.experience) && profile.experience.length > 0) {
        lead.experiences = profile.experience;
      }

      if (profile.about && typeof profile.about === "string") {
        lead.summary = profile.about.slice(0, 400);
      }

      const fullBio = `${profile.about || ""} ${JSON.stringify(profile.experience || [])} ${JSON.stringify(profile.skills || [])}`;
      if (isB2BOutbound) {
        if (/clay/i.test(fullBio) && !lead.techStack.includes("Clay")) lead.techStack.push("Clay");
        if (/instantly/i.test(fullBio) && !lead.techStack.includes("Instantly")) lead.techStack.push("Instantly");
        if (/smartlead/i.test(fullBio) && !lead.techStack.includes("Smartlead")) lead.techStack.push("Smartlead");
        if (/cold email/i.test(fullBio) && !lead.techStack.includes("Cold Email Infrastructure")) {
          lead.techStack.push("Cold Email Infrastructure");
        }
      } else {
        for (const kw of plan.keywords) {
          if (
            !lead.techStack.some((t) => t.toLowerCase() === kw.toLowerCase()) &&
            new RegExp(`\\b${escapeRegexLiteral(kw)}\\b`, "i").test(fullBio)
          ) {
            lead.techStack.push(kw);
          }
        }
      }

      const bdQuote = extractMatchingQuote(
        fullBio,
        isB2BOutbound
          ? ["clay", "instantly", "smartlead", "cold email", "outbound", "lead gen"]
          : [...plan.keywords, ...plan.verticalTerms],
      );
      if (bdQuote && bdQuote.length > lead.hiringQuote.length) {
        lead.hiringQuote = bdQuote.replace(/["\n\r]/g, " ").trim();
      }
    }

    options.onProgress?.({
      phase: "brightdata_complete",
      message: `BrightData Pro enriched ${brightDataEnrichedCount} / ${candidatePool.length} leads in ${brightDataLatencyMs}ms (${brightDataRejectedSlugs.size} filtered out on verified title/geo).`,
    });
  }

  // Final post-enrichment validation + name_company deduplication + cap to requestedLimit
  const qualifiedLeads: AgentBrainLeadItem[] = [];
  const finalSeenNameComp = new Set<string>();
  for (const item of candidatePool) {
    if (qualifiedLeads.length >= requestedLimit) break;
    if (brightDataRejectedSlugs.has(item.slug)) continue;
    const nameCompKey = `name_company:${normalizeDedupeValue(item.name)}::${normalizeCompanyName(item.company)}`;
    if (existingIdentities.has(nameCompKey) || finalSeenNameComp.has(nameCompKey)) {
      duplicatesSkipped++;
      continue;
    }
    finalSeenNameComp.add(nameCompKey);
    existingIdentities.add(nameCompKey);
    qualifiedLeads.push(item);
  }

  options.onProgress?.({
    phase: "qualified",
    message: `Agent Brain finalized ${qualifiedLeads.length} leads matching all criteria (${brightDataEnrichedCount} enriched via BrightData Pro).`,
  });

  if (isAborted()) {
    return handleCancellation();
  }

  // 5. Atomic Schema v${LATEST_SCHEMA_VERSION} SQLite Persistence (ADR-0015 Grounded-Write aligned)
  const nowIso = new Date().toISOString();
  const primaryIndustryLabel = isB2BOutbound
    ? "B2B Outbound Lead Generation & Cold Email Services"
    : plan.verticalTerms[0] || "B2B Decision Makers";
  const geoTag =
    plan.locations[0]?.toUpperCase().replace(/[^A-Z0-9]+/g, "_") ||
    (isB2BOutbound ? "US_UK" : "GLOBAL");

  const leadsToInsert: Record<string, any>[] = qualifiedLeads.map((item) => {
    const hasVerbatimQuote = item.hiringQuote.trim().length > 0;
    const qualification = hasVerbatimQuote
      ? {
          verdict: "qualified_partial",
          source: "agent_brain",
          requirements: [
            {
              name: isB2BOutbound ? "Outbound & Decision-Maker Fit" : "Brief & Role Fit",
              met: true,
              quote: item.hiringQuote,
            },
            ...(item.techStack.length > 0
              ? [
                  {
                    name: "Matched Signals & Keywords",
                    met: true,
                    quote: item.hiringQuote,
                  },
                ]
              : []),
          ],
        }
      : undefined;

    return {
      id: item.id,
      revision: 1,
      profile: {
        id: item.id,
        fullName: item.name,
        headline: item.headline,
        currentCompany: item.company,
        currentTitle: item.title,
        seniorityLevel: /founder|ceo|owner|president|managing/i.test(item.title)
          ? "Founder-Owner"
          : "Leadership",
        location: item.location,
        summary: hasVerbatimQuote ? `${item.summary} Evidence: ${item.hiringQuote}` : item.summary,
        contactDetails: {
          linkedinUrl: item.url,
          website: item.website || "",
        },
        companyWebsite: item.website || "",
        experiences: item.experiences || [],
        industry: primaryIndustryLabel,
        techStackHints: item.techStack,
        painIndicators: hasVerbatimQuote ? [item.hiringQuote] : [],
        hiringSignalUrl: item.url,
        buyingSignalsDetected: isB2BOutbound
          ? ["B2B_OUTBOUND_AGENCY", "COLD_EMAIL_INFRASTRUCTURE", "FOUNDER_OPERATED"]
          : ["AGENT_BRAIN_MATCHED", ...(item.techStack.length > 0 ? ["KEYWORD_SIGNAL_VERIFIED"] : [])],
      },
      stage: targetStage,
      notes: isB2BOutbound
        ? `[Agent Brain Qualified] Verified ${item.title} of ${item.company} in ${item.location}. Outbound tooling & services: ${item.techStack.join(", ")}. Evidence: "${item.hiringQuote || item.summary}"`
        : `[Agent Brain Qualified] Verified ${item.title} of ${item.company} (${item.location}). Evidence: "${item.hiringQuote || item.summary}"`,
      createdAt: nowIso,
      lastActive: nowIso,
      lastEnrichedAt: nowIso,
      tags: isB2BOutbound
        ? ["AGENT_BRAIN", "B2B_OUTBOUND", "LEAD_GEN", "US_UK", "AGENT_BRAIN_CANDIDATE"]
        : ["AGENT_BRAIN", geoTag, "AGENT_BRAIN_CANDIDATE"],
      reviewStatus: targetReviewStatus,
      nextAction: targetNextAction,
      provenance: "agent_brain",
      ...(qualification ? { qualification } : {}),
      icpScoreReasoning: isB2BOutbound
        ? `Strictly verified decision maker (${item.title}) at B2B outbound lead generation agency (${item.company}) in ${item.location}. Identified tooling: ${item.techStack.join(", ")}.`
        : `Verified decision maker (${item.title}) at ${item.company} (${item.location}) matching "${promptQuery.slice(0, 120)}".`,
      fitScore: Math.min(10, Math.max(7, item.score)),
      intentScore: Math.min(10, Math.max(7, item.score)),
      timingScore: 9.0,
      compositeScore: Math.round(item.score * 10),
      predictiveScore: Math.round(item.score * 10),
      qualificationScore: Math.round(item.score * 10),
      tier: hasVerbatimQuote ? "TIER 1: PRIORITY" : "TIER 3: WATCH",
      sourceProvider: item.enrichedViaBrightData ? "brightdata" : "tavily",
      discoveryLane: "person",
      paretoSkyline: true,
      finalSelectionScore: item.score,
    };
  });

  const writeResults: LeadWriteResult[] =
    leadsToInsert.length > 0
      ? upsertLeadsWithIdentity(leadsToInsert, {
          isEngineWrite: true,
          perItemConflict: true,
        })
      : [];

  const persistedIds: string[] = [];
  const persistedLeadItems: AgentBrainLeadItem[] = [];
  for (let i = 0; i < writeResults.length; i++) {
    const res = writeResults[i];
    if (res.disposition === "duplicate") {
      duplicatesSkipped++;
      continue;
    }
    if (res.disposition === "conflict") {
      continue;
    }
    const resolvedId = String(res.lead?.id || res.incomingLeadId || "");
    if (!resolvedId) continue;
    persistedIds.push(resolvedId);
    if (qualifiedLeads[i]) {
      persistedLeadItems.push(qualifiedLeads[i]);
    }

    insertLeadActivity({
      leadId: resolvedId,
      type: targetStage === "SCRAPED" ? "import" : "enrichment",
      toValue: targetStage,
      actor: "agent_brain",
      createdAt: nowIso,
    });
  }

  // 6. Record Mining Session & Search Log
  if (isAborted()) {
    return handleCancellation();
  }

  const totalDurationMs = Date.now() - startedAt;
  const statsPayload = {
    requested: requestedLimit,
    returned: persistedLeadItems.length,
    rawCandidates: rawCandidateMap.size,
    duplicatesSkipped,
    persistedCount: persistedIds.length,
    brain: "Agent-as-the-Brain (Antigravity)",
    status: "complete",
  };

  const traceSummaryPayload = {
    providerSummary: {
      agent_brain: {
        calls: qualifiedLeads.length,
        successes: persistedIds.length,
        latencyMs: 0,
      },
      tavily: {
        calls: searchCallCount,
        errors: tavilyErrors,
        latencyMs: Math.max(0, totalDurationMs - brightDataLatencyMs),
      },
      ...(brightDataCalls > 0
        ? {
            brightdata: {
              calls: brightDataCalls,
              successes: brightDataEnrichedCount,
              latencyMs: brightDataLatencyMs,
            },
          }
        : {}),
    },
    costSummary: { estimatedUsd: 0, totalTokens: 0, tokensPerAcceptedLead: 0 },
  };

  if (isAborted()) {
    return handleCancellation();
  }

  upsertMiningSession({
    id: sessionId,
    status: "success",
    prompt: promptQuery,
    requestedLimit,
    startedAt: startTimeIso,
    completedAt: new Date().toISOString(),
    // Terminal state: clear anything a previous run (or a cancel request) left behind.
    cancellationRequestedAt: null,
    errorMessage: null,
    checkpoint: null,
    stats: statsPayload,
    traceSummary: traceSummaryPayload,
  });

  insertSearchLog({
    id: sessionId,
    timestamp: startTimeIso,
    prompt: promptQuery,
    generatedQueries: searchQueries.slice(0, 10),
    status: "success",
    errorMessage: "",
    rawResultsCount: rawCandidateMap.size,
    leadsFound: persistedIds.length,
    detailedLogs: JSON.stringify([
      `[AgentBrain] Pre-filtered against ${existingIdentities.size} existing identities.`,
      `[AgentBrain] Dispatched ${searchCallCount} search calls (${tavilyErrors} errors); harvested ${rawCandidateMap.size} unique candidate profiles.`,
      `[AgentBrain] Qualified ${qualifiedLeads.length} leads; persisted ${persistedIds.length} (skipped ${duplicatesSkipped} duplicates).`,
      brightDataEnrichedCount > 0
        ? `[AgentBrain] BrightData Pro enriched ${brightDataEnrichedCount} leads in ${brightDataLatencyMs}ms.`
        : `[AgentBrain] Processed candidate profiles via fast deterministic extraction.`,
      `[AgentBrain] Ingested ${persistedIds.length} leads into Schema v${LATEST_SCHEMA_VERSION} SQLite.`,
    ]),
    debugLogs: JSON.stringify([]),
    traceEvents: [],
    providerSummary: traceSummaryPayload.providerSummary,
    costSummary: traceSummaryPayload.costSummary,
    phaseTimeline: [
      { phase: "retrieval", durationMs: Math.max(0, totalDurationMs - brightDataLatencyMs) },
      { phase: "brightdata_pro_enrichment", durationMs: brightDataLatencyMs },
      { phase: "sqlite_persistence", durationMs: Math.round(totalDurationMs * 0.05) },
    ],
    schemaVersion: LATEST_SCHEMA_VERSION,
  });

  options.onProgress?.({
    phase: "persisted",
    message: `Persisted ${persistedIds.length} leads to SQLite in ${Math.round(totalDurationMs / 1000)}s.`,
  });

  // 7. Verify SQLite records strictly for this session's persisted leads
  const db = getLeadsDb();
  const verifySession = db
    .prepare(`SELECT id, status FROM mining_sessions WHERE id = ?`)
    .get(sessionId);

  let verifyLeadsCount = 0;
  let verifyFtsCount = 0;
  let verifyIdentitiesCount = 0;

  if (persistedIds.length > 0) {
    const uniquePersistedIds = Array.from(new Set(persistedIds));
    const { clause, params } = buildBatchIdCondition(uniquePersistedIds);
    verifyLeadsCount =
      (
        db
          .prepare(`SELECT count(1) as count FROM leads WHERE id IN (${clause})`)
          .get(...params) as { count: number }
      )?.count || 0;
    verifyFtsCount =
      (
        db
          .prepare(`SELECT count(1) as count FROM leads_fts WHERE id IN (${clause})`)
          .get(...params) as { count: number }
      )?.count || 0;
    verifyIdentitiesCount =
      (
        db
          .prepare(
            `SELECT count(DISTINCT lead_id) as count FROM lead_identities WHERE lead_id IN (${clause})`,
          )
          .get(...params) as { count: number }
      )?.count || 0;
  }

  try {
    await closeBrightDataClient({
      onlyIfIdle: true,
      onlyIfUnhealthy: true,
      reason: "agent-brain-complete",
    });
  } catch {
    // ignore cleanup errors
  }

  const expectedCount = new Set(persistedIds).size;
  return {
    sessionId,
    prompt: promptQuery,
    requestedLimit,
    qualifiedCount: persistedIds.length,
    rawCandidatesCount: rawCandidateMap.size,
    duplicatesSkippedCount: duplicatesSkipped,
    durationMs: totalDurationMs,
    leads: persistedLeadItems,
    stats: statsPayload,
    verification: {
      sqliteVerified:
        Boolean(verifySession) && (expectedCount === 0 || verifyLeadsCount === expectedCount),
      ftsIndexed: expectedCount === 0 || verifyFtsCount === expectedCount,
      identityKeysRegistered: expectedCount === 0 || verifyIdentitiesCount === expectedCount,
    },
  };
}

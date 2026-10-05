import { normalizeAliasTerm } from "./aliasMap.js";
import { enforceContractQueries } from "./prospectContract.js";
import type { ProspectContract } from "./prospectContract.js";
import type { SearchQueryPlanItem } from "./searchSpec.js";

export const STALL_DUPLICATE_RATE_THRESHOLD = 0.40;
export const STALL_PRODUCTIVE_ACCEPTED_THRESHOLD = 2;

export type StallLevel = 0 | 1 | 2 | 3;

export type RoundHistoryItem = {
  round?: number;
  acceptedLeads?: number;
  accepted?: number;
  rawCandidates?: number;
  uniqueCandidates?: number;
};

export function computeStallLevel(roundHistory?: RoundHistoryItem[] | null): StallLevel {
  if (!Array.isArray(roundHistory) || roundHistory.length === 0) {
    return 0;
  }

  const lastRound = roundHistory[roundHistory.length - 1];
  const lastAccepted = Number(lastRound.acceptedLeads ?? lastRound.accepted ?? 0);
  const lastRaw = Number(lastRound.rawCandidates ?? 0);
  const lastUnique = Number(lastRound.uniqueCandidates ?? 0);
  const duplicateRate = lastRaw > 0 ? Math.max(0, (lastRaw - lastUnique) / lastRaw) : 0;

  // Check for consecutive zero-yield rounds (Levels 2 & 3 take precedence)
  if (lastAccepted === 0) {
    if (roundHistory.length >= 2) {
      const secondLastRound = roundHistory[roundHistory.length - 2];
      const secondLastAccepted = Number(secondLastRound.acceptedLeads ?? secondLastRound.accepted ?? 0);
      if (secondLastAccepted === 0) {
        return 3;
      }
    }
    return 2;
  }

  // Level 1: last accepted == 1 OR duplicate rate > 0.40
  if (lastAccepted === 1 || duplicateRate > STALL_DUPLICATE_RATE_THRESHOLD) {
    return 1;
  }

  // Level 0: Last round was productive (accepted >= 2 and duplicate rate <= 0.40)
  return 0;
}

const ROLE_CLASS_OWNER_PRINCIPAL = new Set([
  "founder",
  "co-founder",
  "cofounder",
  "owner",
  "proprietor",
  "ceo",
  "chief executive",
  "chief executive officer",
  "founder & ceo",
  "founder and ceo",
  "principal",
]);

const ROLE_CLASS_PARTNER = new Set([
  "managing partner",
  "partner",
  "general partner",
  "founding partner",
]);

const ROLE_CLASS_DIRECTOR = new Set([
  "managing director",
  "director",
  "md",
  "executive director",
]);

export function getRoleClass(term: string): string {
  let lower = term.trim().toLowerCase();
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 3) {
    lower = lower.slice(0, -1);
  }
  if (ROLE_CLASS_OWNER_PRINCIPAL.has(lower)) return "owner-principal";
  if (ROLE_CLASS_PARTNER.has(lower)) return "partner";
  if (ROLE_CLASS_DIRECTOR.has(lower)) return "director";
  return normalizeAliasTerm(lower) || lower;
}

export function extractContractRoleClasses(contract?: ProspectContract): string[] {
  if (!contract?.requirements) return [];
  const roleReqs = contract.requirements.filter((r) => r.scope === "person_role");
  const classes = new Set<string>();
  for (const req of roleReqs) {
    for (const term of req.acceptableTerms) {
      const cls = getRoleClass(term);
      if (cls) classes.add(cls);
    }
  }
  return Array.from(classes);
}

export function buildStallDirectives(
  stallLevel: StallLevel,
  contract?: ProspectContract,
  options?: {
    unvisitedMetros?: string[];
    minedRefinements?: string[];
  },
): { directiveText: string; effectiveLevel: StallLevel; summary: string } {
  if (stallLevel === 0) {
    return { directiveText: "", effectiveLevel: 0, summary: "Standard Planning (No Stall)" };
  }

  const roleClasses = extractContractRoleClasses(contract);
  let effectiveLevel = stallLevel;

  // If contract only has one role class, skip Level 1 role rotation straight to Level 2
  if (effectiveLevel === 1 && roleClasses.length <= 1) {
    effectiveLevel = 2;
  }

  const unvisitedMetros = options?.unvisitedMetros || [];
  const industries = contract?.identitySpec?.industries || [];
  const companyTypes = contract?.identitySpec?.companyTypes || [];
  const refinements = options?.minedRefinements || [];
  const verticalTerms = Array.from(new Set([...industries, ...companyTypes, ...refinements])).filter(Boolean);

  if (effectiveLevel === 1) {
    const summary = `Level 1 Stall: Rotating roles across ${roleClasses.join(", ")}`;
    const directiveText = `\nSTALL ESCALATION DIRECTIVE (Level 1 - Role Class Rotation):
Saturation or low yield detected. Rotate your query roles across the distinct acceptable role categories defined in the contract: [${roleClasses.join(", ")}].
Do not reuse only the primary leadership title; diversify across partners, directors, or practice leads.`;
    return { directiveText, effectiveLevel: 1, summary };
  }

  if (effectiveLevel === 2) {
    const metroClause =
      unvisitedMetros.length > 0
        ? `\nYou may allocate up to ALL 4 queries to distinct unvisited regional metros: [${unvisitedMetros.slice(0, 8).join(", ")}].`
        : "";
    const verticalClause =
      verticalTerms.length > 0
        ? `\nCombine these with distinct industry verticals and company types from the contract: [${verticalTerms.join(", ")}].`
        : "";
    const summary = `Level 2 Stall: Geographic & vertical expansion (${unvisitedMetros.length} unvisited metros)`;
    const directiveText = `\nSTALL ESCALATION DIRECTIVE (Level 2 - Regional & Vertical Market Expansion):
Zero qualified leads were accepted in the previous round. Relax city caps:
${metroClause}${verticalClause}
Diversify queries to uncover fresh regional candidates rather than querying saturated hubs.`;
    return { directiveText, effectiveLevel: 2, summary };
  }

  // Level 3
  const summary = "Level 3 Stall: Open-web directory & company discovery";
  const primaryCompanyType = companyTypes[0] || industries[0] || "specialist";
  const directiveText = `\nSTALL ESCALATION DIRECTIVE (Level 3 - Open Web Directory & Ecosystem Discovery):
Multiple consecutive rounds produced zero yield. Individual profile search is saturated.
Generate discovery queries targeting directories, industry association member lists, and company rosters for: "${primaryCompanyType}".`;
  return { directiveText, effectiveLevel: 3, summary };
}

export function buildStallGridQueries(
  contract: ProspectContract,
  unvisitedMetros: string[],
  round: number,
): SearchQueryPlanItem[] {
  const roleReqs = contract.requirements.filter((r) => r.scope === "person_role");
  const roleTerms = Array.from(
    new Set(roleReqs.flatMap((r) => r.acceptableTerms)),
  );
  if (roleTerms.length === 0) roleTerms.push("founder", "director", "owner");

  const companyTypes = contract.identitySpec?.companyTypes || [];
  const industries = contract.identitySpec?.industries || [];
  const verticals = Array.from(new Set([...companyTypes, ...industries]));
  const primaryVertical = verticals[0] || "";

  const items: SearchQueryPlanItem[] = [];
  const numToBuild = 4;

  for (let i = 0; i < numToBuild; i++) {
    const roleIdx = (round + i) % roleTerms.length;
    const role = roleTerms[roleIdx];
    const metro = unvisitedMetros.length > 0 ? unvisitedMetros[i % unvisitedMetros.length] : "";

    const parts = [role, primaryVertical, metro].filter(Boolean);
    const query = parts.join(" ").trim();

    items.push({
      query,
      family: "local_market",
      intent: "recover_from_low_yield",
      lane: "person",
      priority: i + 1,
      expectedSignal: "Regional candidate discovery via deterministic stall grid",
    });
  }

  // Enforce contract query validity and strip Big Tech negatives
  return enforceContractQueries(items, contract);
}

export function buildDirectoryDiscoveryQueries(
  contract: ProspectContract,
  countryCanonical?: string | null,
): SearchQueryPlanItem[] {
  const companyType =
    contract.identitySpec?.companyTypes?.[0] ||
    contract.identitySpec?.industries?.[0] ||
    "companies";
  const geo = countryCanonical ? ` ${countryCanonical}` : "";

  const items: SearchQueryPlanItem[] = [
    {
      query: `list of ${companyType} companies${geo}`.trim(),
      family: "company_type",
      intent: "expand_surface_area",
      lane: "signal",
      priority: 1,
      expectedSignal: "Directory page with member company names",
    },
    {
      query: `${companyType} directory${geo}`.trim(),
      family: "company_type",
      intent: "expand_surface_area",
      lane: "signal",
      priority: 2,
      expectedSignal: "Industry directory listings",
    },
  ];

  return items;
}

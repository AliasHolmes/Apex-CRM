import {
  fuseObservations,
  extractCompanyHintDeterministic,
  isSignalObservation,
  type ScoutObservation,
} from "../observations.js";
import { normalizeCompanyName } from "../signalStore.js";
import {
  extractLinkedInUsername,
  normalizeLinkedInUrl,
} from "../../services/linkedinEvidence.js";
import { incrementRejection, type RejectionReason } from "../rejections.js";
import type { SessionContext } from "../pipelineTypes.js";
import type { ExecutableQueryPlan } from "./planStage.js";
import type { QueryRunStats } from "../strategist.js";
import type { SearchSpec } from "../searchSpec.js";

export type FuseStageInput = {
  round: number;
  roundItems: { item: any; resultIndex: number }[];
  roundPlans: ExecutableQueryPlan[];
  queryRuns: QueryRunStats[];
  searchSpec?: SearchSpec;
  stats: any;
};

export type FuseStageOutput = {
  candidateItems: any[];
  roundCandidateKeys: Set<string>;
  uniqueRoundItemsCount: number;
  stopReason?: string;
};

function inferSignalCategory(obs: any): string {
  if (obs.family === 'pain_signal' || obs.intent === 'find_pain_signal') return 'pain';
  if (obs.family === 'growth_signal' || obs.intent === 'find_growth_signal') return 'growth';
  if (obs.family === 'tooling_signal' || obs.intent === 'find_tooling_signal') return 'tooling';
  const text = `${obs.title || ''} ${obs.content || ''}`.toLowerCase();
  if (/\b(hiring|jobs?|careers?|engineer|developer|recruiting|roles?)\b/.test(text)) return 'hiring';
  if (/\b(funding|raised|series [a-e]|seed|invested|expansion)\b/.test(text)) return 'growth';
  if (/\b(stack|n8n|zapier|hubspot|salesforce|aws|gcp|python|react)\b/.test(text)) return 'tooling';
  return 'general';
}

export async function executeFuseStage(
  ctx: SessionContext,
  input: FuseStageInput,
): Promise<FuseStageOutput> {
  const { round, roundItems, roundPlans, queryRuns, searchSpec, stats } = input;
  const { config, state, logEvent } = ctx;
  const { seenCandidateKeys, existingKeys } = state;
  const acceptedLeads = state.acceptedLeads || [];
  const maxPerCompany = Math.max(1, Number(searchSpec?.maxPerCompany || 2));

  const acceptedCompanyCounts = new Map<string, number>();
  for (const lead of acceptedLeads) {
    const comp = normalizeCompanyName(
      lead.currentCompany || lead.company || "",
    );
    if (comp) {
      acceptedCompanyCounts.set(
        comp,
        (acceptedCompanyCounts.get(comp) || 0) + 1,
      );
    }
  }

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const planByQuery = new Map<string, ExecutableQueryPlan>();
  for (const plan of roundPlans) {
    planByQuery.set(plan.executableQuery, plan);
  }

  const queryRunByQuery = new Map<string, QueryRunStats>();
  for (const run of queryRuns) {
    queryRunByQuery.set(run.query, run);
  }

  const scoutObservations: ScoutObservation[] = [];
  for (const entry of roundItems) {
    const item = entry.item;
    if (!item) continue;
    const plan = roundPlans[entry.resultIndex] || (item._sourceQuery ? planByQuery.get(item._sourceQuery) : undefined);
    const queryRun = queryRuns[entry.resultIndex] || (item._sourceQuery ? queryRunByQuery.get(item._sourceQuery) : undefined);
    if (queryRun) queryRun.rawCandidates++;
    const obs: ScoutObservation = {
      title: item.title || "",
      url: item.url || "",
      content: item.content || item.raw_content || "",
      provider:
        item.sourceProvider === "brightdata_search" ||
        item.sourceProvider === "brightdata"
          ? "brightdata"
          : "tavily",
      query: item._sourceQuery || plan?.executableQuery || config.promptQuery || "",
      round,
      family: item._queryFamily || plan?.item.family,
      lane: item._lane || plan?.item.lane,
      intent: item._queryIntent || plan?.item.intent,
      expectedSignal: item._expectedSignal || plan?.item.expectedSignal,
      raw: item,
    };
    scoutObservations.push(obs);
  }

  const fusedObservations = fuseObservations(scoutObservations);
  const roundCandidateKeys = new Set<string>();
  const uniqueRoundItems: any[] = [];

  for (const observation of fusedObservations) {
    const plan = planByQuery.get(observation.query);
    const queryRun = queryRunByQuery.get(observation.query);
    const item = { ...observation.raw };
    const url = observation.url;
    const username = extractLinkedInUsername(url);
    const normalizedUrl = normalizeLinkedInUrl(url);

    const isSignal = isSignalObservation(observation) || observation.lane === 'signal';
    const isAccount = observation.lane === 'account' || (Array.isArray(observation.lanes) && observation.lanes.includes('account'));

    // STREAM 2: Signal Lane -> Store into session SignalStore and register discovered company
    if (isSignal) {
      const companyHint = extractCompanyHintDeterministic(observation) || "";
      if (companyHint && ctx.state.signalStore) {
        ctx.state.signalStore.add({
          companyName: companyHint,
          url: observation.url,
          text: `${observation.title} - ${observation.content}`.trim(),
          round,
          query: observation.query,
          lane: 'signal',
          confidence: observation.corroborated ? 0.9 : 0.75,
          provider: observation.sourceProviders.includes("brightdata") ? "brightdata" : "tavily",
          category: inferSignalCategory(observation)
        });
      }
      if (queryRun) {
        queryRun.evidenceBlocks = (queryRun.evidenceBlocks || 0) + 1;
        if (observation.corroborated) {
          queryRun.corroboratedCandidates = (queryRun.corroboratedCandidates || 0) + 1;
        }
      }
      // Signal observations provide company context; do not push to person candidateItems
      continue;
    }

    // STREAM 3: Account Lane -> Register company evidence decisively
    if (isAccount) {
      const companyHint = extractCompanyHintDeterministic(observation) || (username ? username : "");
      if (companyHint && ctx.state.signalStore) {
        ctx.state.signalStore.registerDiscoveredCompany(
          companyHint,
          `${observation.title} - ${observation.content}`.trim(),
          observation.url,
          round,
          0.8
        );
      }
      if (queryRun) {
        queryRun.evidenceBlocks = (queryRun.evidenceBlocks || 0) + 1;
        if (observation.corroborated) {
          queryRun.corroboratedCandidates = (queryRun.corroboratedCandidates || 0) + 1;
        }
      }
      // Account observations provide organization context; do not push to person candidateItems
      continue;
    }

    // STREAM 1: Person Lane -> Must have a valid LinkedIn profile URL
    if (!username || !normalizedUrl) {
      noteRejection("missing_linkedin_profile", queryRun);
      continue;
    }

    if (existingKeys.has(`linkedin:${username}`)) {
      noteRejection("duplicate_existing_lead", queryRun);
      continue;
    }
    if (normalizedUrl && existingKeys.has(`linkedin:${normalizedUrl}`)) {
      noteRejection("duplicate_existing_lead", queryRun);
      continue;
    }

    // Prefer the canonical prefixed identity key from fusion (e.g. "linkedin:jane")
    // over the bare username so round-to-round dedupe keys stay consistent with
    // the keys recorded during extraction.
    const candidateKey = observation.identityKey || username || normalizedUrl;
    if (
      !candidateKey ||
      seenCandidateKeys.has(candidateKey) ||
      roundCandidateKeys.has(candidateKey)
    )
      continue;
    roundCandidateKeys.add(candidateKey);

    item.url = url;
    item.title = observation.title;
    item.content = observation.content;
    item.sourceProvider = observation.sourceProviders.includes("brightdata")
      ? "brightdata_search"
      : "tavily";
    item._normalizedUrl = normalizedUrl;
    item._linkedinUsername = username;
    item._sourceQuery = observation.query;
    item._sourceRound = round;
    item._queryFamily = observation.family || plan?.item.family;
    item._queryIntent = observation.intent || plan?.item.intent;
    item._expectedSignal =
      observation.expectedSignal || plan?.item.expectedSignal;
    item._queryRun = queryRun;
    item._sourceProviders = observation.sourceProviders;
    item._sourceCount = observation.sourceCount;
    item._lanes = observation.lanes;
    item._corroborated = observation.corroborated;
    const rawHint = extractCompanyHintDeterministic(observation) || "";
    item._companyHint = normalizeCompanyName(rawHint);

    if (queryRun) {
      queryRun.uniqueCandidates++;
      if (observation.corroborated)
        queryRun.corroboratedCandidates =
          (queryRun.corroboratedCandidates || 0) + 1;
    }
    uniqueRoundItems.push(item);
  }

  const rawResultsCount = seenCandidateKeys.size + roundCandidateKeys.size;
  stats.rawCandidates = rawResultsCount;

  if (uniqueRoundItems.length === 0) {
    logEvent(
      `Round ${round}: no new unique candidates (stalled round, continuing collection budget).`,
    );
    return {
      candidateItems: [],
      roundCandidateKeys,
      uniqueRoundItemsCount: 0,
    };
  }

  uniqueRoundItems.sort((a, b) => {
    const scoreItem = (item: any) => {
      const companyCount = item._companyHint
        ? acceptedCompanyCounts.get(item._companyHint) || 0
        : 0;
      const overCapPenalty = companyCount >= maxPerCompany ? -500 : 0;
      return (
        `${item.title || ""} ${item.content || ""} ${item.raw_content || ""}`
          .length +
        (extractLinkedInUsername(item.url) ? 180 : 0) +
        Number(item._sourceCount || 1) * 160 +
        (item._corroborated ? 180 : 0) +
        (Array.isArray(item._lanes) && item._lanes.includes("signal") ? 40 : 0) +
        overCapPenalty
      );
    };
    return scoreItem(b) - scoreItem(a);
  });

  const candidateBudget = Math.min(
    uniqueRoundItems.length,
    Math.max(Number(config.targetLimit || 1) * 4, 4),
  );
  const candidateItems = uniqueRoundItems.slice(0, candidateBudget);
  logEvent(
    `Round ${round}: using top ${candidateItems.length}/${uniqueRoundItems.length} candidates for extraction budget.`,
  );

  return {
    candidateItems,
    roundCandidateKeys,
    uniqueRoundItemsCount: uniqueRoundItems.length,
  };
}

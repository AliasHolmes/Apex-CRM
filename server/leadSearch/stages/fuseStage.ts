import { fuseObservations, type ScoutObservation } from '../observations.js';
import { extractLinkedInUsername, normalizeLinkedInUrl } from '../../services/linkedinEvidence.js';
import { incrementRejection, type RejectionReason } from '../rejections.js';
import type { SessionContext } from '../pipelineTypes.js';
import type { ExecutableQueryPlan } from './planStage.js';
import type { QueryRunStats } from '../strategist.js';

export type FuseStageInput = {
  round: number;
  roundItems: { item: any; resultIndex: number }[];
  roundPlans: ExecutableQueryPlan[];
  queryRuns: QueryRunStats[];
  stats: any;
};

export type FuseStageOutput = {
  candidateItems: any[];
  roundCandidateKeys: Set<string>;
  uniqueRoundItemsCount: number;
  stopReason?: string;
};

export async function executeFuseStage(
  ctx: SessionContext,
  input: FuseStageInput
): Promise<FuseStageOutput> {
  const { round, roundItems, roundPlans, queryRuns, stats } = input;
  const { config, state, logEvent } = ctx;
  const { seenCandidateKeys, existingKeys } = state;

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) {
      incrementRejection(queryRun.rejectionReasons, reason);
    }
  };

  const observations: ScoutObservation[] = roundItems.map(({ item, resultIndex }) => {
    const plan = roundPlans[resultIndex];
    const queryRun = queryRuns[resultIndex];
    if (queryRun) queryRun.rawCandidates++;
    return {
      title: String(item.title || ''),
      url: String(item.url || item.link || ''),
      content: String(item.content || item.snippet || item.raw_content || ''),
      provider: item.sourceProvider === 'brightdata_search' ? 'brightdata' : 'tavily',
      query: plan?.executableQuery || config.promptQuery,
      round,
      family: plan?.item.family,
      lane: plan?.item.lane,
      intent: plan?.item.intent,
      expectedSignal: plan?.item.expectedSignal,
      raw: item
    };
  });

  const fusedObservations = fuseObservations(observations);
  const uniqueRoundItems: any[] = [];
  const roundCandidateKeys = new Set<string>();

  for (const observation of fusedObservations) {
    const planIndex = roundPlans.findIndex(plan => plan.executableQuery === observation.query);
    const queryRun = planIndex >= 0 ? queryRuns[planIndex] : undefined;
    const plan = planIndex >= 0 ? roundPlans[planIndex] : undefined;
    const item = { ...observation.raw };
    const url = observation.url;
    const username = extractLinkedInUsername(url);
    const normalizedUrl = normalizeLinkedInUrl(url);

    if (!username || !normalizedUrl) {
      noteRejection('missing_linkedin_profile', queryRun);
      continue;
    }

    if (existingKeys.has(`linkedin:${username}`)) {
      noteRejection('duplicate_existing_lead', queryRun);
      continue;
    }
    if (normalizedUrl && existingKeys.has(`linkedin:${normalizedUrl}`)) {
      noteRejection('duplicate_existing_lead', queryRun);
      continue;
    }

    const candidateKey = username || normalizedUrl || observation.identityKey;
    if (!candidateKey || seenCandidateKeys.has(candidateKey) || roundCandidateKeys.has(candidateKey)) continue;
    roundCandidateKeys.add(candidateKey);

    item.url = url;
    item.title = observation.title;
    item.content = observation.content;
    item.sourceProvider = observation.sourceProviders.includes('brightdata') ? 'brightdata_search' : 'tavily';
    item._normalizedUrl = normalizedUrl;
    item._linkedinUsername = username;
    item._sourceQuery = observation.query;
    item._sourceRound = round;
    item._queryFamily = observation.family || plan?.item.family;
    item._queryIntent = observation.intent || plan?.item.intent;
    item._expectedSignal = observation.expectedSignal || plan?.item.expectedSignal;
    item._queryRun = queryRun;
    item._sourceProviders = observation.sourceProviders;
    item._sourceCount = observation.sourceCount;
    item._lanes = observation.lanes;
    item._corroborated = observation.corroborated;

    if (queryRun) {
      queryRun.uniqueCandidates++;
      if (observation.corroborated) queryRun.corroboratedCandidates = (queryRun.corroboratedCandidates || 0) + 1;
    }
    uniqueRoundItems.push(item);
  }

  const rawResultsCount = seenCandidateKeys.size + roundCandidateKeys.size;
  stats.rawCandidates = rawResultsCount;

  if (uniqueRoundItems.length === 0) {
    logEvent(`Round ${round}: no new unique candidates.`);
    return {
      candidateItems: [],
      roundCandidateKeys,
      uniqueRoundItemsCount: 0,
      stopReason: 'exhausted'
    };
  }

  uniqueRoundItems.sort((a, b) => {
    const scoreItem = (item: any) =>
      `${item.title || ''} ${item.content || ''} ${item.raw_content || ''}`.length +
      (extractLinkedInUsername(item.url) ? 180 : 0) +
      Number(item._sourceCount || 1) * 160 +
      (item._corroborated ? 180 : 0) +
      (Array.isArray(item._lanes) && item._lanes.includes('signal') ? 40 : 0);
    return scoreItem(b) - scoreItem(a);
  });

  const candidateBudget = Math.min(uniqueRoundItems.length, Math.max(config.targetLimit * 4, 4));
  const candidateItems = uniqueRoundItems.slice(0, candidateBudget);
  logEvent(`Round ${round}: using top ${candidateItems.length}/${uniqueRoundItems.length} candidates for extraction budget.`);

  return {
    candidateItems,
    roundCandidateKeys,
    uniqueRoundItemsCount: uniqueRoundItems.length
  };
}

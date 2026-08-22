import { extractLinkedInUsername, normalizeLinkedInUrl } from '../../services/linkedinEvidence.js';
import { verifyDecisionMakerFromEvidence } from '../verification.js';
import { createLeadEvidence } from '../evidence.js';
import { buildScoutEvidence } from '../scoutScoring.js';
import { computeScoreBreakdown } from '../scoring.js';
import { incrementRejection, type RejectionReason } from '../rejections.js';
import { buildProfileDedupeKeys, hasDuplicateProfile, normalizeDedupeValue } from '../../../src/utils/leadDedupe.js';
import type { SessionContext } from '../pipelineTypes.js';
import type { EvidenceMeta } from './extractStage.js';
import type { QueryRunStats } from '../strategist.js';
import type { SearchSpec } from '../searchSpec.js';

export type PostFilterLead = {
  lead: any;
  evidenceMeta: EvidenceMeta;
  queryRun?: QueryRunStats;
};

export type VerifyStageInput = {
  round: number;
  provisionalLeads: any[];
  evidenceByUrl: Map<string, EvidenceMeta>;
  searchSpec: SearchSpec;
  excludeList?: string[];
  stats: any;
};

export type VerifyStageOutput = {
  postFilterLeads: PostFilterLead[];
};

export async function executeVerifyStage(
  ctx: SessionContext,
  input: VerifyStageInput
): Promise<VerifyStageOutput> {
  const { round, provisionalLeads, evidenceByUrl, searchSpec, excludeList = [], stats } = input;
  const { config, state, recordTrace } = ctx;
  const { existingKeys } = state;
  const { promptQuery, minScore } = config;

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const hasDuplicateKeys = (profile: any, existingKeys: Set<string>) => hasDuplicateProfile(profile || {}, existingKeys);

  const excludedValues = new Set<string>();
  for (const exclusion of excludeList) {
    const normalized = normalizeDedupeValue(exclusion);
    if (normalized) excludedValues.add(normalized);
  }

  const matchesExcludeList = (lead: any) => {
    const keys = [
      lead.fullName,
      lead.currentCompany,
      lead.contactDetails?.linkedinUrl,
      lead.contactDetails?.email,
      lead.contactDetails?.workEmail
    ];
    for (const key of keys) {
      const normalized = normalizeDedupeValue(key);
      if (normalized && excludedValues.has(normalized)) return true;
    }
    return false;
  };

  const fallbackEvidenceForLead = (lead: any): EvidenceMeta => {
    const sourceUrl = lead.contactDetails?.linkedinUrl || '';
    const evidenceBlock = [
      sourceUrl ? `LINK: ${sourceUrl}` : '',
      lead.headline ? `HEADLINE: ${lead.headline}` : '',
      lead.summary ? `SUMMARY: ${lead.summary}` : '',
      Array.isArray(lead.evidenceReasons) ? lead.evidenceReasons.join('\n') : ''
    ].filter(Boolean).join('\n');
    return {
      evidenceBlock,
      evidenceQuality: 'weak',
      sourceProvider: lead.sourceProvider === 'brightdata_search' ? 'brightdata' : (lead.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily'),
      sourceUrl,
      sourceQuery: promptQuery,
      sourceRound: round,
      sourceProviders: [lead.sourceProvider || 'tavily'],
      sourceCount: 1,
      lanes: [lead.discoveryLane || 'person'],
      corroborated: false
    };
  };

  const getEvidenceForLead = (lead: any): EvidenceMeta => {
    const linkedinUrl = lead?.contactDetails?.linkedinUrl || '';
    const fallbackUrl = lead?.sourceUrl || '';
    const candidateKeys = [
      normalizeLinkedInUrl(linkedinUrl),
      normalizeDedupeValue(linkedinUrl),
      linkedinUrl,
      normalizeLinkedInUrl(fallbackUrl),
      normalizeDedupeValue(fallbackUrl),
      fallbackUrl
    ].filter(Boolean);

    for (const key of candidateKeys) {
      const found = evidenceByUrl.get(key);
      if (found) return found;
    }
    return fallbackEvidenceForLead(lead);
  };

  const effectiveScore = (lead: any) => {
    const score = Number(lead.scoreBreakdown?.finalScore || 0);
    if (score > 0) return score;
    const fit = Number(lead.fitScore || 0);
    const composite = Number(lead.compositeScore || 0);
    return Math.max(fit, composite);
  };

  recordTrace({
    phase: 'filtering',
    operation: 'provisional_leads_ready',
    status: 'success',
    provider: 'system',
    round,
    counts: { provisionalLeads: provisionalLeads.length }
  });

  const postFilterLeads: PostFilterLead[] = [];
  for (const lead of provisionalLeads) {
    const rawUrl = lead.contactDetails?.linkedinUrl;
    if (rawUrl && !extractLinkedInUsername(rawUrl)) {
      if (lead.contactDetails) lead.contactDetails.linkedinUrl = '';
    }
    const evidenceMeta = getEvidenceForLead(lead);
    const queryRun = evidenceMeta.queryRun;

    // Identity/Role checks
    const hasIdentity = Boolean((lead?.fullName || '').trim());
    if (!hasIdentity) { noteRejection('missing_identity', queryRun); continue; }
    const hasRoleContext = Boolean((lead?.currentTitle || '').trim() || (lead?.currentCompany || '').trim() || (lead?.headline || '').trim());
    if (!hasRoleContext) { noteRejection('missing_role_context', queryRun); continue; }

    if (matchesExcludeList(lead) || hasDuplicateKeys(lead, existingKeys)) {
      noteRejection('duplicate_existing_lead', queryRun);
      continue;
    }

    const dmVerification = verifyDecisionMakerFromEvidence({
      query: promptQuery,
      fullName: lead.fullName,
      currentTitle: lead.currentTitle,
      currentCompany: lead.currentCompany,
      headline: lead.headline,
      seniorityLevel: lead.seniorityLevel,
      evidenceText: evidenceMeta.evidenceBlock
    });

    lead.decisionMakerVerification = dmVerification;

    lead.sourceProvider = evidenceMeta.sourceProvider;
    lead.evidenceReasons = Array.isArray(lead.evidenceReasons) && lead.evidenceReasons.length
      ? lead.evidenceReasons : [`Qualified from ${lead.sourceProvider} evidence for: ${promptQuery}`];
    lead.evidence = createLeadEvidence({
      sourceUrl: evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || '',
      sourceProvider: evidenceMeta.sourceProvider,
      sourceQuery: evidenceMeta.sourceQuery,
      sourceRound: evidenceMeta.sourceRound,
      evidenceQuality: evidenceMeta.evidenceQuality,
      evidenceBlock: evidenceMeta.evidenceBlock,
      whyThisLead: lead.evidenceReasons[0]
    });
    lead.discoveryLane = evidenceMeta.lanes?.[0] || 'person';
    lead.scout = buildScoutEvidence(lead, searchSpec, {
      sourceProviders: evidenceMeta.sourceProviders,
      sourceCount: evidenceMeta.sourceCount,
      lanes: evidenceMeta.lanes
    });

    lead.scoreBreakdown = computeScoreBreakdown(lead, evidenceMeta.evidenceQuality, evidenceMeta.sourceProvider, dmVerification);
    lead.scoreOverride = lead.scoreBreakdown.finalScore;

    if (dmVerification.ignoredTitle && dmVerification.confidence < 4 && effectiveScore(lead) < minScore) {
      noteRejection('not_decision_maker', queryRun);
      continue;
    }

    if (effectiveScore(lead) < minScore - 1) {
      noteRejection('score_below_minimum', queryRun);
      continue;
    }

    if (queryRun) { queryRun.extractedLeads++; }
    postFilterLeads.push({ lead, evidenceMeta, queryRun });
  }

  recordTrace({
    phase: 'filtering',
    operation: 'lead_filtering',
    status: 'success',
    provider: 'system',
    round,
    counts: { postFilterLeads: postFilterLeads.length },
    metadata: { rejectionReasons: stats.rejectionReasons }
  });

  return { postFilterLeads };
}

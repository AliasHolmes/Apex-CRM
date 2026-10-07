import {
  extractLinkedInUsername,
  normalizeLinkedInUrl,
} from "../../services/linkedinEvidence.js";
import { verifyDecisionMakerFromEvidence } from "../verification.js";
import { evaluateDecisionMakerGate } from "../titleTriage.js";
import { cleanCompanyHint, looksLikeCompanyHint } from "../observations.js";
import { createLeadEvidence } from "../evidence.js";
import { buildScoutEvidence } from "../scoutScoring.js";
import { computeScoreBreakdown } from "../scoring.js";
import { incrementRejection, type RejectionReason } from "../rejections.js";
import {
  hasDuplicateProfile,
  normalizeDedupeValue,
  unwrapRedirectUrl,
} from "../../../src/utils/leadDedupe.js";
import {
  effectiveScore as sharedEffectiveScore,
  buildFallbackEvidence,
  findEvidenceForLead,
  clampEnvInt,
  type SessionEvidenceMeta,
} from "../sessionHelpers.js";
import type { SessionContext } from "../pipelineTypes.js";
import type { EvidenceMeta } from "./extractStage.js";
import type { QueryRunStats } from "../strategist.js";
import type { SearchSpec } from "../searchSpec.js";
import { isAuthorityRelevant } from "../prospectContract.js";

// Hosts that say nothing about which company a person works for.
const NON_ANCHOR_HOSTS =
  /(^|\.)(facebook|instagram|twitter|x|youtube|tiktok|reddit|pinterest|medium|quora|wikipedia|google|bing|yahoo|duckduckgo)\.[a-z.]+$/i;

/**
 * Whether a candidate carries something to anchor its identity to: a LinkedIn profile, a
 * company website/domain, or a source page hosted on its own company site. Used to drop leads
 * that are just a name scraped from a social/search page before they cost an attribution call.
 */
export function hasIdentityAnchor(lead: any): boolean {
  if (!lead) return false;
  if (
    lead.contactDetails?.linkedinUrl ||
    /linkedin\.com\/in\/[^/?#]+/i.test(String(lead.sourceUrl || ""))
  ) {
    return true;
  }
  if (
    lead.contactDetails?.website ||
    lead.companyDomain ||
    lead.companyEntityResolution?.companyDomain ||
    lead.profile?.contactDetails?.website
  ) {
    return true;
  }
  const source = String(lead.sourceUrl || "").trim();
  if (!/^https?:\/\//i.test(source)) return false;
  try {
    const host = new URL(source).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || /(^|\.)linkedin\.com$/i.test(host)) return false;
    return !NON_ANCHOR_HOSTS.test(host);
  } catch {
    return false;
  }
}

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
  input: VerifyStageInput,
): Promise<VerifyStageOutput> {
  const {
    round,
    provisionalLeads,
    evidenceByUrl,
    searchSpec,
    excludeList = [],
    stats,
  } = input;
  const { config, state, recordTrace } = ctx;
  const { existingKeys } = state;
  const { promptQuery, minScore } = config;

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const hasDuplicateKeys = (profile: any, existingKeys: Set<string>) =>
    hasDuplicateProfile(profile || {}, existingKeys);

  const excludedValues = new Set<string>();
  for (const exclusion of excludeList) {
    const normalized = normalizeDedupeValue(exclusion);
    if (!normalized) continue;
    excludedValues.add(normalized);
    if (normalized.startsWith("linkedin:")) {
      const handle = normalized.slice("linkedin:".length);
      if (handle) excludedValues.add(handle);
    } else if (normalized.includes("linkedin.com/in/")) {
      const handle = extractLinkedInUsername(normalized);
      if (handle) {
        excludedValues.add(`linkedin:${handle}`);
        excludedValues.add(handle);
      }
    }
  }

  const matchesExcludeList = (lead: any) => {
    const rawUrl = lead.contactDetails?.linkedinUrl || lead.sourceUrl;
    const username = rawUrl ? extractLinkedInUsername(rawUrl) : "";
    const canonicalKey = username ? `linkedin:${username}` : "";
    const keys = [
      lead.fullName,
      lead.currentCompany,
      lead.contactDetails?.linkedinUrl,
      lead.contactDetails?.email,
      lead.contactDetails?.workEmail,
      canonicalKey,
      username,
    ];
    for (const key of keys) {
      if (!key) continue;
      const normalized = normalizeDedupeValue(key);
      if (normalized && excludedValues.has(normalized)) return true;
    }
    return false;
  };

  const fallbackEvidenceForLead = (lead: any): SessionEvidenceMeta =>
    buildFallbackEvidence(lead, promptQuery, round);

  const getEvidenceForLead = (lead: any): EvidenceMeta =>
    findEvidenceForLead(lead, evidenceByUrl) || fallbackEvidenceForLead(lead);

  const effectiveScore = sharedEffectiveScore;

  recordTrace({
    phase: "filtering",
    operation: "provisional_leads_ready",
    status: "success",
    provider: "system",
    round,
    counts: { provisionalLeads: provisionalLeads.length },
  });

  const authorityRelevant = isAuthorityRelevant(ctx.config.contract);
  const postFilterLeads: PostFilterLead[] = [];
  let borderlineAdmittedThisRound = 0;
  for (const lead of provisionalLeads) {
    const rawUrl = lead.contactDetails?.linkedinUrl;
    if (rawUrl) {
      const unwrapped = unwrapRedirectUrl(rawUrl);
      const normalized = normalizeLinkedInUrl(unwrapped);
      if (normalized) {
        lead.contactDetails.linkedinUrl = `https://${normalized}`;
      } else if (!extractLinkedInUsername(unwrapped)) {
        // Preserve the original value for diagnostics; downstream consumers read
        // the cleared contactDetails field.
        lead._originalLinkedinUrl = rawUrl;
        if (lead.contactDetails) lead.contactDetails.linkedinUrl = "";
      }
    }
    const evidenceMeta = getEvidenceForLead(lead);
    const queryRun = evidenceMeta.queryRun;

    // Identity/Role checks
    const hasIdentity = Boolean((lead?.fullName || "").trim());
    if (!hasIdentity) {
      noteRejection("missing_identity", queryRun);
      continue;
    }
    const hasRoleContext = Boolean(
      (lead?.currentTitle || "").trim() ||
      (lead?.currentCompany || "").trim() ||
      (lead?.headline || "").trim(),
    );
    if (!hasRoleContext) {
      noteRejection("missing_role_context", queryRun);
      continue;
    }

    // P3: drop leads with no identity anchor (no LinkedIn profile, company site, or
    // company-hosted source page) before they cost an attribution call.
    if (!hasIdentityAnchor(lead)) {
      noteRejection("missing_identity", queryRun);
      continue;
    }

    let resolvedCompany = String(
      lead?.currentCompany || lead?.company || lead?.profile?.currentCompany || lead?.organization || ""
    ).trim();

    if (!resolvedCompany) {
      if (lead?.companyEntityResolution?.companyName) {
        resolvedCompany = String(lead.companyEntityResolution.companyName).trim();
      } else {
        const headlineText = String(lead?.headline || lead?.currentTitle || "").trim();
        if (headlineText) {
          const atMatch = headlineText.match(/(?:\b(?:at|of)\b|@)\s+([A-Za-z0-9][A-Za-z0-9&.' -]{1,60}?)(?=\s*(?:\||\u2013|\u2014|•|\n|,|$))/i);
          if (atMatch && atMatch[1]) {
            const candidate = cleanCompanyHint(atMatch[1]);
            if (looksLikeCompanyHint(candidate)) {
              resolvedCompany = candidate;
            }
          }
          if (!resolvedCompany) {
            const parts = headlineText.split(/\s*(?:\||\u2013|\u2014|•)\s*/).map(p => p.trim()).filter(Boolean);
            if (parts.length > 1) {
              const last = cleanCompanyHint(parts[parts.length - 1]);
              if (looksLikeCompanyHint(last) && !/\b(founder|owner|ceo|executive|leader|director|manager)\b/i.test(last)) {
                resolvedCompany = last;
              }
            }
          }
        }

        if (!resolvedCompany && (lead?.contactDetails?.website || lead?.companyDomain)) {
          try {
            const rawUrl = lead?.contactDetails?.website || lead?.companyDomain;
            const urlStr = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
            const urlObj = new URL(urlStr);
            const domainLabel = urlObj.hostname.replace(/^www\./, "").split(".")[0];
            if (domainLabel && domainLabel.length >= 3) {
              const formatted = domainLabel
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/[-_]+/g, " ")
                .replace(/\b\w/g, (c: string) => c.toUpperCase());
              if (looksLikeCompanyHint(formatted)) {
                resolvedCompany = formatted;
              }
            }
          } catch {}
        }

        // Tier 3: LinkedIn vanity URL slug analysis
        if (!resolvedCompany) {
          const profileUrl = String(lead?.contactDetails?.linkedinUrl || lead?.sourceUrl || lead?.url || "");
          const username = extractLinkedInUsername(profileUrl);
          if (username && username.includes("-")) {
            const agencySlugMatch = username.match(/^[a-z]+-[a-z]+-((?:ai-)?(?:agency|consulting|studio|solutions|labs|partners|media|group|digital))/i);
            if (agencySlugMatch && agencySlugMatch[1]) {
              const formattedSlug = agencySlugMatch[1]
                .replace(/-/g, " ")
                .replace(/\b\w/g, (c: string) => c.toUpperCase());
              if (looksLikeCompanyHint(formattedSlug)) {
                resolvedCompany = formattedSlug;
              }
            }
          }
        }

        // Tier 4: Independent Practice designation with provenance
        // Captures verified agency owners/principals with value-prop headlines rather than hard-dropping them
        if (!resolvedCompany) {
          const headlineText = String(lead?.headline || lead?.currentTitle || "");
          const isVerifiedOwner = /\b(founder|owner|ceo|principal|managing partner|co-founder|proprietor)\b/i.test(lead?.currentTitle || headlineText);
          const hasServiceKeywords = /\b(agency|consulting|consultancy|services|solutions|studio|partners|lab|advisory|digital)\b/i.test(headlineText);
          const fullName = String(lead?.fullName || "").trim();

          if (isVerifiedOwner && hasServiceKeywords && fullName && fullName.length >= 3) {
            resolvedCompany = `${fullName} (Independent Practice)`;
            lead.companyEntityResolution = {
              verified: true,
              companyName: resolvedCompany,
              source: "independent_practice_heuristic",
              isProvisionalEntity: true,
            };
          }
        }
      }

      if (resolvedCompany) {
        lead.currentCompany = resolvedCompany;
        if (!lead.company) lead.company = resolvedCompany;
        if (lead.profile && typeof lead.profile === "object") {
          lead.profile.currentCompany = resolvedCompany;
          if (!lead.profile.company) lead.profile.company = resolvedCompany;
        }
      }
    }

    const hasCompany = Boolean(
      resolvedCompany ||
      (lead?.companyEntityResolution?.verified && lead?.companyEntityResolution?.companyName)
    );
    const hasCompanyRequirement = Boolean(
      config.contract?.requirements?.some(
        (r: any) => (r.scope === "company_type" || r.scope === "company_industry") && r.importance === "hard"
      )
    );
    if (!hasCompany && hasCompanyRequirement) {
      noteRejection("missing_company_entity", queryRun);
      continue;
    }

    if (matchesExcludeList(lead) || hasDuplicateKeys(lead, existingKeys)) {
      noteRejection("duplicate_existing_lead", queryRun);
      continue;
    }

    const dmVerification = verifyDecisionMakerFromEvidence({
      query: promptQuery,
      fullName: lead.fullName,
      currentTitle: lead.currentTitle,
      currentCompany: lead.currentCompany,
      headline: lead.headline,
      seniorityLevel: lead.seniorityLevel,
      evidenceText: evidenceMeta.evidenceBlock,
    });

    lead.decisionMakerVerification = dmVerification;

    lead.sourceProvider = evidenceMeta.sourceProvider;
    lead.evidenceReasons =
      Array.isArray(lead.evidenceReasons) && lead.evidenceReasons.length
        ? lead.evidenceReasons
        : [
            `Qualified from ${lead.sourceProvider} evidence for: ${promptQuery}`,
          ];
    lead.evidence = createLeadEvidence({
      sourceUrl:
        evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || "",
      sourceProvider: evidenceMeta.sourceProvider,
      sourceQuery: evidenceMeta.sourceQuery,
      sourceRound: evidenceMeta.sourceRound,
      evidenceQuality: evidenceMeta.evidenceQuality,
      evidenceBlock: evidenceMeta.evidenceBlock,
      whyThisLead: lead.evidenceReasons[0],
    });
    lead.discoveryLane = evidenceMeta.lanes?.[0] || "person";
    if (evidenceMeta.ablatedRequirementId) {
      lead._ablatedRequirementId = evidenceMeta.ablatedRequirementId;
      lead._ablatedTerm = evidenceMeta.ablatedTerm;
    }
    if (
      Array.isArray(evidenceMeta.corroboratingQueryRuns) &&
      evidenceMeta.corroboratingQueryRuns.length > 0
    ) {
      lead._corroboratingQueryRuns = evidenceMeta.corroboratingQueryRuns;
    }
    lead.scout = buildScoutEvidence(lead, searchSpec, {
      sourceProviders: evidenceMeta.sourceProviders,
      sourceCount: evidenceMeta.sourceCount,
      lanes: evidenceMeta.lanes,
    });

    // Attach supplementary open-web company signals from SignalStore if matched
    const companySignals = ctx.state.signalStore?.getForCandidate(lead.currentCompany || lead.company || "");
    if (companySignals && companySignals.length > 0) {
      const highConfSignals = companySignals.filter(s => (s.confidence || 0.7) >= 0.75);
      const targetSignals = highConfSignals.length > 0 ? highConfSignals : companySignals;
      const signalTexts = targetSignals.map(s => `[COMPANY SIGNAL - ${s.category || 'intent'}]: ${s.text}`).slice(0, 3);
      if (Array.isArray(lead.evidence?.snippets)) {
        lead.evidence.snippets.push(...signalTexts);
      }
      if (lead.evidence?.evidenceBlock) {
        lead.evidence.evidenceBlock = `${lead.evidence.evidenceBlock}\n${signalTexts.join('\n')}`;
      }
      for (const sig of targetSignals.slice(0, 2)) {
        const criteriaLabel = `company signal: ${sig.category || 'intent'}`;
        if (!lead.scout.matchedCriteria.includes(criteriaLabel)) {
          lead.scout.matchedCriteria.push(criteriaLabel);
        }
      }
      lead.scout.corroborationScore = Math.min(10, (lead.scout.corroborationScore || 5) + 0.5);

      // Stream C: Check if any of these are active ATS hiring signals
      const atsSignal = targetSignals.find(s => s.category === 'hiring_signal' || s.category === 'hiring');
      if (atsSignal) {
        lead.buyingSignalsDetected = Array.isArray(lead.buyingSignalsDetected) ? lead.buyingSignalsDetected : [];
        const label = atsSignal.text.startsWith('Active Job Requisition:')
          ? atsSignal.text.split(' - ')[0]
          : `Active Job Requisition: ${atsSignal.companyName}`;
        if (!lead.buyingSignalsDetected.includes(label)) {
          lead.buyingSignalsDetected.unshift(label);
        }
        lead.hiringSignalUrl = atsSignal.url;
      }
    }

    lead.scoreBreakdown = computeScoreBreakdown(
      lead,
      evidenceMeta.evidenceQuality,
      evidenceMeta.sourceProvider,
      authorityRelevant ? dmVerification : undefined,
      undefined,
      ctx.config.contract?.requirements,
      evidenceMeta.evidenceBlock,
    );
    lead.scoreOverride = lead.scoreBreakdown.finalScore;
    // Mark the score as current so enrichStage's acceptance loop can skip a
    // redundant recompute for leads that were not enriched this round.
    lead._scoreCurrent = true;

    const maxBorderlinePerRound = clampEnvInt(
      "LEAD_VERIFY_BORDERLINE_PER_ROUND",
      5,
      0,
      20,
    );

    const dmGate = authorityRelevant
      ? evaluateDecisionMakerGate({
          ignoredTitle: dmVerification.ignoredTitle,
          confidence: dmVerification.confidence,
          effectiveScore: effectiveScore(lead),
          minScore,
          authorityRequired: authorityRelevant,
        })
      : { pass: true };
    if (!dmGate.pass) {
      noteRejection("not_decision_maker", queryRun);
      continue;
    }

    const leadScore = effectiveScore(lead);
    const isBorderline = leadScore >= minScore - 3 && leadScore < minScore;
    if (isBorderline && borderlineAdmittedThisRound < maxBorderlinePerRound) {
      lead._borderlineEvidence = true;
      borderlineAdmittedThisRound++;
    } else if (leadScore < minScore) {
      noteRejection("score_below_minimum", queryRun);
      continue;
    }

    if (queryRun) {
      queryRun.extractedLeads++;
    }
    postFilterLeads.push({ lead, evidenceMeta, queryRun });
  }

  recordTrace({
    phase: "filtering",
    operation: "lead_filtering",
    status: "success",
    provider: "system",
    round,
    counts: { postFilterLeads: postFilterLeads.length },
    metadata: { rejectionReasons: stats.rejectionReasons },
  });

  return { postFilterLeads };
}

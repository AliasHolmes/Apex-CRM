import { scrapeAsMarkdown } from '../services/brightdata.js';
import { extractLinkedInUsername, normalizeLinkedInUrl, parseLinkedInEvidence } from '../services/linkedinEvidence.js';
import { getEnrichmentCacheEntry, upsertEnrichmentCacheEntry, getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry } from '../db.js';
import { verifyDecisionMakerFromEvidence } from './verification.js';
import { createLeadEvidence } from './evidence.js';
import { computeScoreBreakdown, type EvidenceQuality, type LeadSourceProvider } from './scoring.js';
import { mapBrightDataRejection } from './rejections.js';

export type ProfileEnrichmentStatus = 'scraped' | 'cache_hit' | 'negative_cache_hit' | 'rejected_low_quality' | 'skipped_missing_linkedin' | 'error';

export type ProfileEnrichmentResult = {
  status: ProfileEnrichmentStatus;
  sourceProvider: LeadSourceProvider;
  evidenceQuality: EvidenceQuality;
  cacheHit: boolean;
  scraped: boolean;
  updatedFields: string[];
  error?: string;
};

export type EnrichLeadProfileOptions = {
  force?: boolean;
  ttlDays?: number;
};

export async function enrichLeadProfile(
  lead: Record<string, any>,
  options: EnrichLeadProfileOptions = {}
): Promise<{ lead: Record<string, any>; result: ProfileEnrichmentResult }> {
  const { force = false, ttlDays = 7 } = options;
  // Discovery stores a Lead wrapper while older callers can still pass a profile.
  // Keep person fields on the profile and qualification metadata on the lead.
  const profile = lead.profile && typeof lead.profile === 'object' ? lead.profile : lead;
  const rawUrl = profile.contactDetails?.linkedinUrl || lead.evidence?.sourceUrl;
  const updatedFields = new Set<string>();

  const fillProfileFields = (values: {
    personName?: string;
    companyName?: string;
    headline?: string;
    location?: string;
    industry?: string;
    publicEmail?: string;
  }) => {
    if (values.personName && (!profile.fullName || profile.fullName === 'Unknown')) {
      profile.fullName = values.personName;
      updatedFields.add('fullName');
    }
    if (values.companyName && (!profile.currentCompany || profile.currentCompany === 'Unknown')) {
      profile.currentCompany = values.companyName;
      updatedFields.add('currentCompany');
    }
    for (const field of ['headline', 'location', 'industry'] as const) {
      if (values[field] && !profile[field]) {
        profile[field] = values[field];
        updatedFields.add(field);
      }
    }
    if (values.publicEmail && !profile.contactDetails?.email) {
      profile.contactDetails = { ...(profile.contactDetails || {}), email: values.publicEmail };
      updatedFields.add('email');
    }
  };

  const getEvidenceValue = (evidenceBlock: string, label: string) => evidenceBlock
    .split(/\r?\n/)
    .find(line => line.startsWith(`${label}: `))
    ?.slice(label.length + 2)
    .trim();

  if (!rawUrl) {
    return {
      lead,
      result: {
        status: 'skipped_missing_linkedin',
        sourceProvider: 'cache',
        evidenceQuality: 'weak',
        cacheHit: false,
        scraped: false,
        updatedFields: []
      }
    };
  }

  const normalizedUrl = normalizeLinkedInUrl(rawUrl);
  const username = extractLinkedInUsername(rawUrl);

  if (!normalizedUrl || !username) {
    return {
      lead,
      result: {
        status: 'skipped_missing_linkedin',
        sourceProvider: 'cache',
        evidenceQuality: 'weak',
        cacheHit: false,
        scraped: false,
        updatedFields: []
      }
    };
  }

  const refreshLeadEvidence = (
    provider: LeadSourceProvider,
    quality: EvidenceQuality,
    evidenceBlock: string
  ) => {
    const query = lead.evidence?.sourceQuery || profile.headline || profile.currentTitle || '';
    lead.decisionMakerVerification = verifyDecisionMakerFromEvidence({
      query,
      fullName: profile.fullName || '',
      currentTitle: profile.currentTitle || '',
      currentCompany: profile.currentCompany || '',
      headline: profile.headline || '',
      seniorityLevel: profile.seniorityLevel || '',
      evidenceText: evidenceBlock
    });

    lead.evidence = createLeadEvidence({
      sourceUrl: rawUrl,
      sourceProvider: provider,
      sourceQuery: lead.evidence?.sourceQuery || query,
      sourceRound: lead.evidence?.sourceRound || 1,
      evidenceQuality: quality,
      evidenceBlock: evidenceBlock,
      whyThisLead: lead.evidence?.whyThisLead || lead.evidenceReasons?.[0] || 'Enriched by AI pipeline'
    });

    lead.scoreBreakdown = computeScoreBreakdown(lead, quality, provider, lead.decisionMakerVerification);
    lead.scoreOverride = lead.scoreBreakdown.finalScore;
    lead.lastEnrichedAt = new Date().toISOString();
    updatedFields.add('evidence');
    updatedFields.add('decisionMakerVerification');
    updatedFields.add('score');
  };

  if (!force) {
    const positiveCache = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
    if (positiveCache) {
      const quality = positiveCache.scrapeQuality === 'good' ? 'good' : 'partial';
      fillProfileFields({
        personName: positiveCache.personName,
        companyName: positiveCache.companyName,
        headline: getEvidenceValue(positiveCache.evidenceBlock, 'HEADLINE'),
        location: getEvidenceValue(positiveCache.evidenceBlock, 'LOCATION'),
        industry: getEvidenceValue(positiveCache.evidenceBlock, 'INDUSTRY'),
        publicEmail: positiveCache.publicEmail,
      });
      refreshLeadEvidence('cache', quality, positiveCache.evidenceBlock);
      return {
        lead,
        result: {
          status: 'cache_hit',
          sourceProvider: 'cache',
          evidenceQuality: quality,
          cacheHit: true,
          scraped: false,
          updatedFields: Array.from(updatedFields)
        }
      };
    }

    const negativeCache = getNegativeEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
    if (negativeCache) {
      return {
        lead,
        result: {
          status: 'negative_cache_hit',
          sourceProvider: 'cache',
          evidenceQuality: 'weak',
          cacheHit: true,
          scraped: false,
          updatedFields: []
        }
      };
    }
  }

  try {
    const markdown = await scrapeAsMarkdown(rawUrl);
    if (!markdown || markdown.trim().length === 0) {
      return {
        lead,
        result: {
          status: 'rejected_low_quality',
          sourceProvider: 'brightdata',
          evidenceQuality: 'weak',
          cacheHit: false,
          scraped: true,
          updatedFields: [],
          error: 'Empty scrape response'
        }
      };
    }

    const title = profile.currentTitle || profile.headline || 'Untitled';
    const snippet = lead.evidence?.evidenceBlock || '';
    const parsed = parseLinkedInEvidence(markdown, { title, url: rawUrl, snippet });

    if (parsed.quality === 'good' || parsed.quality === 'partial') {
      fillProfileFields(parsed);

      upsertEnrichmentCacheEntry({
        normalizedUrl,
        linkedinUsername: username,
        personName: parsed.personName || profile.fullName || '',
        companyName: parsed.companyName || profile.currentCompany || '',
        publicEmail: parsed.publicEmail,
        evidenceBlock: parsed.evidenceBlock,
        scrapeQuality: parsed.quality,
        sourceProvider: 'brightdata'
      }, ttlDays);

      refreshLeadEvidence('brightdata', parsed.quality, parsed.evidenceBlock);

      return {
        lead,
        result: {
          status: 'scraped',
          sourceProvider: 'brightdata',
          evidenceQuality: parsed.quality,
          cacheHit: false,
          scraped: true,
          updatedFields: Array.from(updatedFields)
        }
      };
    }

    const mappedReason = mapBrightDataRejection(parsed.rejectionReason);
    upsertNegativeEnrichmentCacheEntry({
      normalizedUrl,
      linkedinUsername: username,
      evidenceBlock: mappedReason,
      scrapeQuality: 'bad',
      sourceProvider: 'brightdata'
    }, parsed.rejectionReason === 'blocked_or_login_wall' ? 0.25 : undefined);

    return {
      lead,
      result: {
        status: 'rejected_low_quality',
        sourceProvider: 'brightdata',
        evidenceQuality: 'weak',
        cacheHit: false,
        scraped: true,
        updatedFields: [],
        error: parsed.rejectionReason || 'low quality'
      }
    };
  } catch (err: any) {
    return {
      lead,
      result: {
        status: 'error',
        sourceProvider: 'brightdata',
        evidenceQuality: 'weak',
        cacheHit: false,
        scraped: true,
        updatedFields: [],
        error: err?.message || 'Bright Data scrape failed'
      }
    };
  }
}

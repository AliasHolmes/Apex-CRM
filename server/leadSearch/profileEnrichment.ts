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

  if (!rawUrl) {
    return {
      lead,
      result: {
        status: 'skipped_missing_linkedin',
        sourceProvider: 'cache',
        evidenceQuality: 'weak',
        cacheHit: false,
        scraped: false
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
        scraped: false
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
  };

  if (!force) {
    const positiveCache = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
    if (positiveCache) {
      const quality = positiveCache.scrapeQuality === 'good' ? 'good' : 'partial';
      refreshLeadEvidence('cache', quality, positiveCache.evidenceBlock);
      return {
        lead,
        result: {
          status: 'cache_hit',
          sourceProvider: 'cache',
          evidenceQuality: quality,
          cacheHit: true,
          scraped: false
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
          scraped: false
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
          error: 'Empty scrape response'
        }
      };
    }

    const title = profile.currentTitle || profile.headline || 'Untitled';
    const snippet = lead.evidence?.evidenceBlock || '';
    const parsed = parseLinkedInEvidence(markdown, { title, url: rawUrl, snippet });

    if (parsed.quality === 'good' || parsed.quality === 'partial') {
      if (parsed.personName && (!profile.fullName || profile.fullName === 'Unknown')) profile.fullName = parsed.personName;
      if (parsed.companyName && (!profile.currentCompany || profile.currentCompany === 'Unknown')) profile.currentCompany = parsed.companyName;

      upsertEnrichmentCacheEntry({
        normalizedUrl,
        linkedinUsername: username,
        personName: parsed.personName || profile.fullName || '',
        companyName: parsed.companyName || profile.currentCompany || '',
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
          scraped: true
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
        error: err?.message || 'Bright Data scrape failed'
      }
    };
  }
}

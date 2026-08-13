import { rankLeadForFinalSelection, applyIntentEnrichmentDelta } from './scoring.js';
import { findCompanyWebsite, checkCompanyIntent, SignalCorpus, type CompanyIntentEvidence } from './companyIntent.js';
import { getIntentCacheEntry, upsertIntentCacheEntry } from '../db.js';
import { runProviderQueue, type ProviderQueueTask } from './providerQueue.js';
import type { ProspectContract } from './prospectContract.js';

export type IntentEnrichmentOptions = {
  qualifiedLeads: Map<string, any>;
  contract: ProspectContract;
  companyIntentMaxPerSearch: number;
  companyIntentConcurrency: number;
  ttlDays: number;
  brightDataSearch: (query: string) => Promise<any[]>;
  tavilySearchFallback?: (query: string) => Promise<any[]>;
  sessionAbortSignal: AbortSignal;
  logEvent: (msg: string) => void;
  recordTrace: (event: any) => void;
};

export type IntentEnrichmentStats = {
  attempted: number;
  cacheHits: number;
  noSite: number;
  noSignal: number;
  succeeded: number;
  failed: number;
  companiesDeduped: number;
};

const normalizeCompanyKey = (name?: string) => (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');

export async function runIntentEnrichment(options: IntentEnrichmentOptions): Promise<IntentEnrichmentStats> {
  const {
    qualifiedLeads,
    contract,
    companyIntentMaxPerSearch,
    companyIntentConcurrency,
    ttlDays,
    brightDataSearch,
    tavilySearchFallback,
    sessionAbortSignal,
    logEvent,
    recordTrace
  } = options;

  const stats: IntentEnrichmentStats = {
    attempted: 0,
    cacheHits: 0,
    noSite: 0,
    noSignal: 0,
    succeeded: 0,
    failed: 0,
    companiesDeduped: 0
  };

  if (!companyIntentMaxPerSearch || companyIntentMaxPerSearch <= 0 || qualifiedLeads.size === 0) {
    return stats;
  }

  // Session-scoped TF-IDF corpus -- accumulates document frequency across all companies scraped
  const signalCorpus = new SignalCorpus();

  const fingerprint = contract.intentSignals?.fingerprint || 'fallback';

  // 1. Group leads by canonical company key and calculate highest initial rank
  const companyMap = new Map<string, { companyName: string; leads: any[]; topRank: number }>();

  for (const lead of qualifiedLeads.values()) {
    const companyName = String(lead.currentCompany || lead.company || lead.profile?.currentCompany || lead.companyAccount?.name || '').trim();
    const companyKey = normalizeCompanyKey(companyName);
    if (!companyKey) continue;

    const rank = rankLeadForFinalSelection(lead);
    const existing = companyMap.get(companyKey);
    if (!existing) {
      companyMap.set(companyKey, { companyName, leads: [lead], topRank: rank });
    } else {
      existing.leads.push(lead);
      if (rank > existing.topRank) existing.topRank = rank;
    }
  }

  // Count deduplicated secondary leads
  for (const group of companyMap.values()) {
    if (group.leads.length > 1) {
      stats.companiesDeduped += group.leads.length - 1;
    }
  }

  // 2. Sort unique company groups by top candidate score descending
  const sortedCompanyGroups = Array.from(companyMap.values())
    .sort((a, b) => b.topRank - a.topRank)
    .slice(0, companyIntentMaxPerSearch);

  logEvent(`Intent enrichment: evaluating ${sortedCompanyGroups.length} unique companies for ${qualifiedLeads.size} qualified leads (cap=${companyIntentMaxPerSearch}).`);

  // 3. Build enrichment tasks with priority ordering
  const tasks: ProviderQueueTask<void>[] = [];

  for (let index = 0; index < sortedCompanyGroups.length; index++) {
    const group = sortedCompanyGroups[index];
    const priority = sortedCompanyGroups.length - index;

    tasks.push({
      id: `intent:${group.companyName}`,
      priority,
      run: async (signal) => {
        if (signal?.aborted || sessionAbortSignal.aborted) return;
        stats.attempted++;

        // A. Check intent cache first
        const lead0 = group.leads[0];
        let websiteUrl = lead0?.contactDetails?.website || lead0?.profile?.contactDetails?.website || lead0?.companyAccount?.website || lead0?.website || '';
        let cachedEntry = websiteUrl ? getIntentCacheEntry(websiteUrl, fingerprint) : null;

        if (cachedEntry) {
          stats.cacheHits++;
          try {
            const intentData: CompanyIntentEvidence = JSON.parse(cachedEntry.evidenceBlock);
            intentData.tfidfWeightedScore = intentData.tfidfWeightedScore ?? 0;
            if (Array.isArray(intentData.buyingSignals)) {
              signalCorpus.registerOccurrences(intentData.buyingSignals);
            }
            const cacheAgeDays = (cachedEntry as any).updatedAt ? Math.max(0, (Date.now() - new Date((cachedEntry as any).updatedAt).getTime()) / 86400000) : 0;
            let sampleScore = 0;
            for (const lead of group.leads) {
              lead.companyIntentEvidence = intentData;
              const newScore = applyIntentEnrichmentDelta(lead, cacheAgeDays);
              lead.finalSelectionScore = newScore;
              if (lead.qualification) lead.qualification.finalScore = newScore;
              sampleScore = newScore;
            }
            if (intentData.evidenceQuality === 'good' || intentData.evidenceQuality === 'partial') {
              stats.succeeded++;
            } else {
              stats.noSignal++;
            }
            logEvent(`[Phase 4 Cache Hit] ${group.companyName}: quality=${intentData.evidenceQuality}, tfidfScore=${intentData.tfidfWeightedScore.toFixed(3)}, age=${cacheAgeDays.toFixed(1)}d -> updated score=${sampleScore.toFixed(2)}`);
          } catch {
            // cache parse error, fallback to live search
          }
          return;
        }

        // B. Search website domain if missing
        if (!websiteUrl || websiteUrl.includes('linkedin.com')) {
          const location = group.leads[0]?.location;
          websiteUrl = await findCompanyWebsite({
            companyName: group.companyName,
            location,
            brightDataSearch,
            tavilySearchFallback
          }) || '';
          if (websiteUrl) {
            logEvent(`[Phase 4 Domain Discovery] Resolved website for ${group.companyName} -> ${websiteUrl}`);
          }
        }

        if (!websiteUrl) {
          stats.noSite++;
          logEvent(`[Phase 4 No Website] Could not find official website for ${group.companyName}.`);
          return;
        }

        // Check cache by website URL again in case findCompanyWebsite revealed it
        cachedEntry = getIntentCacheEntry(websiteUrl, fingerprint);
        if (cachedEntry) {
          stats.cacheHits++;
          try {
            const intentData: CompanyIntentEvidence = JSON.parse(cachedEntry.evidenceBlock);
            intentData.tfidfWeightedScore = intentData.tfidfWeightedScore ?? 0;
            if (Array.isArray(intentData.buyingSignals)) {
              signalCorpus.registerOccurrences(intentData.buyingSignals);
            }
            const cacheAgeDays = (cachedEntry as any).updatedAt ? Math.max(0, (Date.now() - new Date((cachedEntry as any).updatedAt).getTime()) / 86400000) : 0;
            let sampleScore = 0;
            for (const lead of group.leads) {
              lead.companyIntentEvidence = intentData;
              const newScore = applyIntentEnrichmentDelta(lead, cacheAgeDays);
              lead.finalSelectionScore = newScore;
              if (lead.qualification) lead.qualification.finalScore = newScore;
              sampleScore = newScore;
            }
            if (intentData.evidenceQuality === 'good' || intentData.evidenceQuality === 'partial') {
              stats.succeeded++;
            } else {
              stats.noSignal++;
            }
            logEvent(`[Phase 4 Cache Hit] ${group.companyName}: quality=${intentData.evidenceQuality}, tfidfScore=${intentData.tfidfWeightedScore.toFixed(3)}, age=${cacheAgeDays.toFixed(1)}d -> updated score=${sampleScore.toFixed(2)}`);
            return;
          } catch {
            // parse error
          }
        }

        // C. Live intent scrape
        try {
          const intentData = await checkCompanyIntent(websiteUrl, {
            companyName: group.companyName,
            intentSignals: contract.intentSignals,
            corpus: signalCorpus
          });

          if (!intentData) {
            stats.failed++;
            logEvent(`[Phase 4 Failed] Intent scrape returned empty for ${group.companyName} (${websiteUrl}).`);
            return;
          }

          if (intentData.evidenceQuality === 'good' || intentData.evidenceQuality === 'partial') {
            stats.succeeded++;
          } else {
            stats.noSignal++;
          }

          let sampleScore = 0;
          for (const lead of group.leads) {
            lead.companyIntentEvidence = intentData;
            const newScore = applyIntentEnrichmentDelta(lead);
            lead.finalSelectionScore = newScore;
            if (lead.qualification) lead.qualification.finalScore = newScore;
            sampleScore = newScore;
          }

          upsertIntentCacheEntry({
            normalizedUrl: websiteUrl,
            companyName: group.companyName,
            evidenceBlock: JSON.stringify(intentData),
            scrapeQuality: intentData.evidenceQuality,
            sourceProvider: 'brightdata',
            intentFingerprint: fingerprint
          }, ttlDays);

          logEvent(`[Phase 4 Enriched] ${group.companyName} (${websiteUrl}): quality=${intentData.evidenceQuality}, signals=${intentData.buyingSignals?.length || 0}, tfidfScore=${intentData.tfidfWeightedScore.toFixed(3)} -> updated score=${sampleScore.toFixed(2)}`);
        } catch (err: any) {
          stats.failed++;
          logEvent(`[Phase 4 WARN] Intent check failed for ${group.companyName}: ${err.message || String(err)}`);
        }
      }
    });
  }

  // 4. Run provider queue synchronously (awaited)
  await runProviderQueue(tasks, {
    concurrency: companyIntentConcurrency,
    signal: sessionAbortSignal
  });

  recordTrace({
    phase: 'candidate_processing',
    operation: 'intent_enrichment_phase',
    status: 'success',
    provider: 'brightdata',
    counts: { ...stats }
  });

  return stats;
}

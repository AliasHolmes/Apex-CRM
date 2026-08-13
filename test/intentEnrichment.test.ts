import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.APEX_DB_PATH = path.join(os.tmpdir(), `intent-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);

const db = await import('../server/db.ts');
const { runIntentEnrichment } = await import('../server/leadSearch/intentEnrichment.js');
const { applyIntentEnrichmentDelta } = await import('../server/leadSearch/scoring.js');
import type { ProspectContract } from '../server/leadSearch/prospectContract.js';

const mockContract: ProspectContract = {
  version: 1,
  policyVersion: 'evidence-contract-v3',
  brief: 'AI agency owner with hiring and white label offloading intent',
  authorityRequired: true,
  requirements: [
    {
      id: 'person_role-1',
      scope: 'person_role',
      importance: 'hard',
      description: 'owner',
      sourcePhrase: 'owner',
      acceptableTerms: ['owner', 'founder', 'CEO'],
      queryable: true
    }
  ],
  exclusions: [],
  initialQueries: [],
  intentSignals: {
    version: 1,
    universal: ['hiring', 'expanding', 'automation'],
    dynamic: ['white label', 'fulfillment partner'],
    fingerprint: 'test-fingerprint-123'
  }
};

test('applyIntentEnrichmentDelta adds expected score deltas', () => {
  const goodLead = {
    finalSelectionScore: 7.0,
    companyIntentEvidence: { evidenceQuality: 'good' }
  };
  assert.strictEqual(applyIntentEnrichmentDelta(goodLead), 7.8);

  const partialLead = {
    finalSelectionScore: 7.0,
    companyIntentEvidence: { evidenceQuality: 'partial' }
  };
  assert.strictEqual(applyIntentEnrichmentDelta(partialLead), 7.4);

  const weakLead = {
    finalSelectionScore: 7.0,
    companyIntentEvidence: { evidenceQuality: 'weak' }
  };
  assert.strictEqual(applyIntentEnrichmentDelta(weakLead), 7.0);
});

test('runIntentEnrichment uses cached intent entries with matching fingerprint and applies score delta', async () => {
  // Pre-seed cache entry for TechFlow AI
  db.upsertIntentCacheEntry({
    normalizedUrl: 'https://techflow.ai',
    companyName: 'TechFlow AI',
    evidenceBlock: JSON.stringify({
      websiteUrl: 'https://techflow.ai',
      evidenceQuality: 'good',
      snippets: ['Found relevant intent signals: white label, fulfillment partner'],
      buyingSignals: ['white label', 'fulfillment partner'],
      dynamicSignals: ['white label', 'fulfillment partner'],
      universalSignals: [],
      painSignals: []
    }),
    scrapeQuality: 'good',
    sourceProvider: 'brightdata',
    intentFingerprint: 'test-fingerprint-123'
  }, 7);

  const qualifiedLeads = new Map<string, any>();

  const lead1 = {
    fullName: 'Alice Smith',
    currentCompany: 'TechFlow AI',
    currentTitle: 'Founder',
    finalSelectionScore: 7.5,
    contactDetails: { website: 'https://techflow.ai' }
  };

  const lead2 = {
    fullName: 'Bob Jones',
    currentCompany: 'TechFlow AI', // same company deduplicated
    currentTitle: 'Co-Founder',
    finalSelectionScore: 7.0,
    contactDetails: { website: 'https://techflow.ai' }
  };

  qualifiedLeads.set('cand-1', lead1);
  qualifiedLeads.set('cand-2', lead2);

  const stats = await runIntentEnrichment({
    qualifiedLeads,
    contract: mockContract,
    companyIntentMaxPerSearch: 10,
    companyIntentConcurrency: 2,
    ttlDays: 7,
    brightDataSearch: async () => [],
    sessionAbortSignal: new AbortController().signal,
    logEvent: () => {},
    recordTrace: () => {}
  });

  assert.strictEqual(stats.companiesDeduped, 1);
  assert.strictEqual(stats.cacheHits, 1);
  assert.strictEqual(stats.succeeded, 1);
  assert.strictEqual(lead1.finalSelectionScore, 8.3); // 7.5 + 0.80 delta
  assert.strictEqual(lead2.finalSelectionScore, 7.8); // 7.0 + 0.80 delta
  assert.strictEqual((lead1 as any).companyIntentEvidence?.evidenceQuality, 'good');
});

test('runIntentEnrichment respects companyIntentMaxPerSearch cap ordering', async () => {
  const qualifiedLeads = new Map<string, any>();

  for (let i = 1; i <= 5; i++) {
    const url = `https://company${i}.com`;
    db.upsertIntentCacheEntry({
      normalizedUrl: url,
      companyName: `Company ${i}`,
      evidenceBlock: JSON.stringify({ websiteUrl: url, evidenceQuality: 'partial', dynamicSignals: ['white label'] }),
      scrapeQuality: 'partial',
      sourceProvider: 'brightdata',
      intentFingerprint: 'test-fingerprint-123'
    }, 7);

    qualifiedLeads.set(`cand-${i}`, {
      fullName: `Lead ${i}`,
      currentCompany: `Company ${i}`,
      currentTitle: 'CEO',
      finalSelectionScore: 5.0 + i, // scores 6.0, 7.0, 8.0, 9.0, 10.0
      contactDetails: { website: url }
    });
  }

  const stats = await runIntentEnrichment({
    qualifiedLeads,
    contract: mockContract,
    companyIntentMaxPerSearch: 2, // cap at 2 companies
    companyIntentConcurrency: 2,
    ttlDays: 7,
    brightDataSearch: async () => [],
    sessionAbortSignal: new AbortController().signal,
    logEvent: () => {},
    recordTrace: () => {}
  });

  assert.strictEqual(stats.cacheHits, 2); // only top 2 (Company 5 and Company 4) were processed
  assert.strictEqual(qualifiedLeads.get('cand-5')?.finalSelectionScore, 10.0); // 10.0 + 0.40 capped at 10.0
  assert.strictEqual(qualifiedLeads.get('cand-4')?.finalSelectionScore, 9.4);  // 9.0 + 0.40 = 9.4
  assert.strictEqual(qualifiedLeads.get('cand-1')?.finalSelectionScore, 6.0);  // untouched
});

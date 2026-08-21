import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectDecompositionMode,
  buildDeterministicProspectContract,
  enforceContractQueries,
  type ProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION
} from '../server/leadSearch/prospectContract.js';

import {
  parseSnippetFreshnessDays,
  computeFreshnessMultiplier,
  buildFallbackIntentSignals,
  compileIntentSignals
} from '../server/leadSearch/intentSignals.js';

import { buildRetrievalTasks, buildFallbackSearchSpec } from '../server/leadSearch/searchSpec.js';
import { SignalStore } from '../server/leadSearch/signalStore.js';
import { applyPostIntentDelta } from '../server/leadSearch/scoring.js';

test('detectDecompositionMode classifies simple vs compound prompts correctly', () => {
  // Simple / persona-only prompts
  assert.equal(detectDecompositionMode('Immigration lawyers in London'), 'single_stream_identity');
  assert.equal(detectDecompositionMode('Dental clinic owners in Toronto'), 'single_stream_identity');
  assert.equal(detectDecompositionMode('SaaS founders in Austin'), 'single_stream_identity');

  // Compound / intent-rich prompts
  assert.equal(detectDecompositionMode('Founders of B2B SaaS in US who are hiring n8n automation specialists'), 'dual_stream_intent');
  assert.equal(detectDecompositionMode('Agency owners looking for white-label fulfillment partners'), 'dual_stream_intent');
  assert.equal(detectDecompositionMode('CTOs using Zapier or Make.com seeking integration engineers'), 'dual_stream_intent');
  assert.equal(detectDecompositionMode('CEOs of logistics firms scaling past 50 employees dealing with manual workflow bottlenecks'), 'dual_stream_intent');
});

test('buildDeterministicProspectContract populates decompositionMode and specs', () => {
  const spec = buildFallbackSearchSpec('Founders in US hiring n8n specialists');
  const contract = buildDeterministicProspectContract('Founders in US hiring n8n specialists', spec);

  assert.equal(contract.decompositionMode, 'dual_stream_intent');
  assert.ok(contract.identitySpec);
  assert.ok(contract.intentSpec);
  assert.ok(contract.identitySpec.roles.length > 0);
});

test('enforceContractQueries prevents intent keywords from polluting person profile queries', () => {
  const contract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Founders of B2B SaaS in US hiring n8n specialists',
    decompositionMode: 'dual_stream_intent',
    identitySpec: {
      roles: ['founder', 'CEO'],
      locations: ['US', 'United States'],
      companyTypes: ['B2B SaaS'],
      industries: ['Tech']
    },
    intentSpec: {
      toolingKeywords: ['n8n'],
      hiringSignals: ['hiring n8n specialists', 'automation specialist'],
      painSignals: [],
      growthSignals: []
    },
    authorityRequired: true,
    requirements: [
      { id: 'r1', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'founder', sourcePhrase: 'founder', acceptableTerms: ['founder', 'CEO'], queryable: true },
      { id: 'r2', scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile', description: 'B2B SaaS', sourcePhrase: 'B2B SaaS', acceptableTerms: ['B2B SaaS'], queryable: true },
      { id: 'r3', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'hiring n8n specialists', sourcePhrase: 'hiring n8n specialists', acceptableTerms: ['hiring n8n specialists'], queryable: true }
    ],
    exclusions: [],
    initialQueries: []
  };

  const candidateQueries = [
    { query: 'founder B2B SaaS', lane: 'person' as const, family: 'persona_title' as const },
    { query: 'hiring n8n specialists', lane: 'signal' as const, family: 'pain_signal' as const }
  ];

  const enforced = enforceContractQueries(candidateQueries, contract);
  const personQuery = enforced.find(q => q.lane === 'person');
  const signalQuery = enforced.find(q => q.lane === 'signal');

  assert.ok(personQuery);
  // Ensure person query contains persona terms but NOT the intent signal term
  assert.ok(personQuery.query.includes('founder'));
  assert.ok(personQuery.query.includes('B2B SaaS'));
  assert.ok(!personQuery.query.includes('hiring n8n specialists'));

  assert.ok(signalQuery);
  assert.ok(signalQuery.query.includes('hiring n8n specialists'));
});

test('buildRetrievalTasks enforces basic depth for person lane and advanced for signal lane', () => {
  const spec = buildFallbackSearchSpec('SaaS founders in US');
  const tasks = buildRetrievalTasks([
    { query: 'founder SaaS US', lane: 'person', priority: 1, searchDepth: 'advanced' },
    { query: 'hiring n8n developer', lane: 'signal', priority: 1 }
  ], spec);

  const personTask = tasks.find(t => t.lane === 'person');
  const signalTask = tasks.find(t => t.lane === 'signal');

  assert.ok(personTask);
  // Person task must be forced to 'basic' depth for 1-credit cost efficiency and maximum recall
  assert.equal(personTask.tavily.searchDepth, 'basic');

  assert.ok(signalTask);
  // Signal task with priority 1 escalates to 'advanced' depth
  assert.equal(signalTask.tavily.searchDepth, 'advanced');
});

test('SignalStore.getUniqueCompanyNames provides reverse flywheel targets', () => {
  const store = new SignalStore();
  store.add({ companyName: 'Acme Corp', text: 'Hiring n8n automation engineer', url: 'https://acme.com/jobs', query: 'hiring n8n', lane: 'signal', round: 1, provider: 'tavily' });
  store.add({ companyName: 'Beta Systems LLC', text: 'Using Zapier and Make for workflows', url: 'https://beta.com/careers', query: 'Zapier workflows', lane: 'signal', round: 1, provider: 'tavily' });
  store.add({ companyName: 'Acme Corp', text: 'Another job posting', url: 'https://acme.com/careers', query: 'hiring n8n', lane: 'signal', round: 2, provider: 'tavily' });

  const unique = store.getUniqueCompanyNames();
  assert.equal(unique.length, 2);
  assert.ok(unique.includes('Acme Corp'));
  assert.ok(unique.includes('Beta Systems LLC'));
});

test('parseSnippetFreshnessDays and computeFreshnessMultiplier calculate recency decay', () => {
  // Fresh signals (hours/days)
  assert.equal(parseSnippetFreshnessDays(['Posted 4 hours ago by Founder']), 0);
  assert.equal(parseSnippetFreshnessDays(['3 days ago - We are looking for automation engineer']), 3);
  assert.ok(computeFreshnessMultiplier(3) >= 0.90);

  // Moderate signals (weeks)
  assert.equal(parseSnippetFreshnessDays(['2 weeks ago - expanding operations']), 14);
  assert.ok(computeFreshnessMultiplier(14) >= 0.70 && computeFreshnessMultiplier(14) <= 0.80);

  // Older signals (months)
  assert.equal(parseSnippetFreshnessDays(['4 months ago - announcement']), 120);
  assert.ok(computeFreshnessMultiplier(120) >= 0.20 && computeFreshnessMultiplier(120) <= 0.30);
});

test('applyPostIntentDelta scales boost with temporal freshness', () => {
  const freshLead: any = {
    finalSelectionScore: 7.0,
    scoreBreakdown: { fitScore: 7.0, finalScore: 7.0 },
    postIntentEvidence: {
      intentCategory: 'hiring',
      quality: 'strong',
      confidenceScore: 0.90,
      postSnippets: ['2 days ago - We are hiring an automation specialist!']
    }
  };

  const oldLead: any = {
    finalSelectionScore: 7.0,
    scoreBreakdown: { fitScore: 7.0, finalScore: 7.0 },
    postIntentEvidence: {
      intentCategory: 'hiring',
      quality: 'strong',
      confidenceScore: 0.90,
      postSnippets: ['6 months ago - Old post from last year']
    }
  };

  const freshScore = applyPostIntentDelta(freshLead);
  const oldScore = applyPostIntentDelta(oldLead);

  assert.ok(freshScore > oldScore);
  assert.ok(freshLead.scoreBreakdown.postIntentScore > oldLead.scoreBreakdown.postIntentScore);
});

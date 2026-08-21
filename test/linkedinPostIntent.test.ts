import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.APEX_DB_PATH = path.join(os.tmpdir(), `post-intent-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);

const {
  buildLinkedInPostSearchQuery,
  extractPostSnippets,
  computePostIntentQuality,
  runLinkedInPostIntentEnrichment
} = await import('../server/leadSearch/linkedinPostIntent.js');

import { applyPostIntentDelta, type ScoreBreakdown } from '../server/leadSearch/scoring.js';
import { PROSPECT_CONTRACT_POLICY_VERSION, type ProspectContract } from '../server/leadSearch/prospectContract.js';

test('buildLinkedInPostSearchQuery generates query from LinkedIn handle', () => {
  const lead = {
    fullName: 'Lewis McGuinness',
    contactDetails: {
      linkedinUrl: 'https://www.linkedin.com/in/lewismcguinness/'
    }
  };
  assert.strictEqual(buildLinkedInPostSearchQuery(lead), 'site:linkedin.com/posts "lewismcguinness"');
});

test('buildLinkedInPostSearchQuery falls back to name + company if no handle', () => {
  const lead = {
    fullName: 'Dominic S',
    currentCompany: 'Apex Tech'
  };
  assert.strictEqual(buildLinkedInPostSearchQuery(lead), '"Dominic S" "Apex Tech" site:linkedin.com/posts');
});

test('buildLinkedInPostSearchQuery falls back to name only if company is missing', () => {
  const lead = {
    fullName: 'Dominic S'
  };
  assert.strictEqual(buildLinkedInPostSearchQuery(lead), '"Dominic S" site:linkedin.com/posts');
});

test('buildLinkedInPostSearchQuery returns empty string if no identifiers', () => {
  assert.strictEqual(buildLinkedInPostSearchQuery({}), '');
});

test('extractPostSnippets filters and formats LinkedIn post results into snippets and context', () => {
  const rawResults: any[] = [
    {
      title: "Lewis McGuinness' Post | LinkedIn",
      url: 'https://www.linkedin.com/posts/lewismcguinness_automation-n8n-activity-12345',
      content: 'We are hiring an n8n workflow specialist to scale our operations.',
      sourceProvider: 'brightdata_search'
    },
    {
      title: 'Lewis McGuinness Profile | LinkedIn',
      url: 'https://www.linkedin.com/in/lewismcguinness',
      content: 'Founder & Director at Pendulum Recruitment',
      sourceProvider: 'brightdata_search'
    }
  ];

  const { snippets, postContext, firstUrl } = extractPostSnippets(rawResults);
  assert.strictEqual(snippets.length, 1);
  assert.ok(snippets[0].includes("Lewis McGuinness' Post - We are hiring an n8n workflow specialist"));
  assert.ok(postContext.includes('[Post snippet]:'));
  assert.strictEqual(firstUrl, 'https://www.linkedin.com/posts/lewismcguinness_automation-n8n-activity-12345');
});

test('extractPostSnippets gracefully handles empty results', () => {
  const { snippets, postContext, firstUrl } = extractPostSnippets([]);
  assert.deepStrictEqual(snippets, []);
  assert.strictEqual(postContext, '');
  assert.strictEqual(firstUrl, undefined);
});

test('computePostIntentQuality classifies strong, moderate, weak, and none correctly', () => {
  assert.strictEqual(computePostIntentQuality('hiring', 0.8), 'strong');
  assert.strictEqual(computePostIntentQuality('evaluating_tools', 0.55), 'strong');
  assert.strictEqual(computePostIntentQuality('pain_signal', 0.6), 'moderate');
  assert.strictEqual(computePostIntentQuality('growth_signal', 0.5), 'moderate');
  assert.strictEqual(computePostIntentQuality('hiring', 0.35), 'moderate');
  assert.strictEqual(computePostIntentQuality('general', 0.7), 'weak');
  assert.strictEqual(computePostIntentQuality('none', 0.9), 'none');
  assert.strictEqual(computePostIntentQuality('hiring', 0.1), 'none');
});

test('applyPostIntentDelta adds expected score deltas and updates scoreBreakdown', () => {
  const scoreBreakdown: ScoreBreakdown = {
    fitScore: 7,
    intentScore: 5,
    timingScore: 5,
    evidenceQualityScore: 7,
    sourceConfidenceScore: 8,
    finalScore: 6.0
  };

  const lead = {
    finalSelectionScore: 6.0,
    scoreBreakdown,
    postIntentEvidence: {
      quality: 'strong' as const,
      intentCategory: 'hiring' as const,
      confidenceScore: 0.8,
      postSnippets: ['Hiring n8n developer'],
      intentKeywords: ['hiring', 'n8n'],
      llmReason: 'Actively hiring automation developer.'
    }
  };

  const newScore = applyPostIntentDelta(lead);
  // delta = 0.50 + 0.80 * 0.30 = 0.74 -> 6.0 + 0.74 = 6.74
  assert.strictEqual(newScore, 6.74);
  assert.strictEqual(lead.scoreBreakdown.finalScore, 6.74);
  assert.strictEqual(lead.scoreBreakdown.postIntentScore, 8.0);

  const moderateLead = {
    finalSelectionScore: 5.0,
    postIntentEvidence: {
      quality: 'moderate' as const,
      intentCategory: 'pain_signal' as const,
      confidenceScore: 0.5
    }
  };
  // delta = 0.25 + 0.5 * 0.20 = 0.35 -> 5.0 + 0.35 = 5.35
  assert.strictEqual(applyPostIntentDelta(moderateLead), 5.35);

  const noneLead = {
    finalSelectionScore: 5.5,
    postIntentEvidence: {
      quality: 'none' as const,
      intentCategory: 'none' as const,
      confidenceScore: 0
    }
  };
  assert.strictEqual(applyPostIntentDelta(noneLead), 5.5);
});

test('runLinkedInPostIntentEnrichment skips when no leads provided', async () => {
  const mockContract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Founders hiring automation specialists',
    authorityRequired: true,
    requirements: [],
    exclusions: [],
    initialQueries: []
  };

  const stats = await runLinkedInPostIntentEnrichment({
    qualifiedLeads: new Map(),
    contract: mockContract,
    brightDataSearch: async () => [],
    logEvent: () => {},
    recordTrace: () => {}
  });

  assert.strictEqual(stats.attempted, 0);
});

test('runLinkedInPostIntentEnrichment handles no-results search gracefully', async () => {
  const mockContract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Founders hiring automation specialists',
    authorityRequired: true,
    requirements: [],
    exclusions: [],
    initialQueries: []
  };

  const lead: any = {
    fullName: 'Test Candidate',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/test-candidate' },
    finalSelectionScore: 5.0
  };
  const map = new Map([['lead-1', lead]]);

  const stats = await runLinkedInPostIntentEnrichment({
    qualifiedLeads: map,
    contract: mockContract,
    brightDataSearch: async () => [],
    logEvent: () => {},
    recordTrace: () => {}
  });

  assert.strictEqual(stats.attempted, 1);
  assert.strictEqual(stats.llmSkipped, 1);
  assert.ok(lead.postIntentEvidence);
  assert.strictEqual(lead.postIntentEvidence.quality, 'none');
});

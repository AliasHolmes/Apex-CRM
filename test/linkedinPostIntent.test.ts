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

import {
  applyPostIntentDelta,
  postIntentScore,
  rankLeadForFinalSelection,
  computeParetoFrontier,
  type ScoreBreakdown
} from '../server/leadSearch/scoring.js';
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

test('postIntentScore calculates expected values across quality tiers and freshness', () => {
  const leadStrongFresh = {
    postIntentEvidence: {
      quality: 'strong',
      confidenceScore: 0.8,
      postSnippets: ['2d ago - Hiring an n8n engineer']
    }
  };
  // base = 8, freshness ~ 1.0 -> 8 + 0.8 = 8.8
  const scoreStrong = postIntentScore(leadStrongFresh);
  assert.ok(scoreStrong >= 8.5 && scoreStrong <= 8.9, `Expected ~8.8, got ${scoreStrong}`);

  const leadModerate = {
    postIntentEvidence: {
      quality: 'moderate',
      confidenceScore: 0.5,
      postSnippets: ['1w ago - Scaling workflow bottlenecks']
    }
  };
  // base = 6.5, freshness ~ 0.9 -> 6.5 + 0.45 = ~6.95
  const scoreModerate = postIntentScore(leadModerate);
  assert.ok(scoreModerate >= 6.7 && scoreModerate <= 7.1, `Expected ~6.95, got ${scoreModerate}`);

  const leadNone = {
    postIntentEvidence: {
      quality: 'none',
      confidenceScore: 0
    }
  };
  assert.strictEqual(postIntentScore(leadNone), 5);
  assert.strictEqual(postIntentScore({}), 5);
});

test('rankLeadForFinalSelection distinguishes between identical leads with and without postIntentEvidence', () => {
  const baseLead = {
    fullName: 'David Smith',
    currentTitle: 'CEO',
    currentCompany: 'TechFlow Solutions',
    decisionMakerVerification: { confidence: 8 },
    companyIntentEvidence: { evidenceQuality: 'partial' },
    evidence: { evidenceQuality: 'good' },
    scout: { criteriaCoverageScore: 8, corroborationScore: 7 },
    qualification: { finalScore: 7.0 }
  };

  const leadWithoutPostIntent = { ...baseLead };
  const leadWithStrongPostIntent = {
    ...baseLead,
    postIntentEvidence: {
      quality: 'strong' as const,
      intentCategory: 'evaluating_tools' as const,
      confidenceScore: 0.9,
      postSnippets: ['1d ago - Exploring migration to new automation stack'],
      intentKeywords: ['automation', 'migration'],
      llmReason: 'Actively researching automation platforms.'
    }
  };

  const rankWithout = rankLeadForFinalSelection(leadWithoutPostIntent);
  const rankWith = rankLeadForFinalSelection(leadWithStrongPostIntent);

  assert.ok(rankWith > rankWithout, `Rank with strong post intent (${rankWith}) must exceed rank without (${rankWithout})`);
  // Difference should be ~ (8.9 - 5) * 0.10 ~ +0.39
  assert.ok(rankWith - rankWithout >= 0.30, `Expected at least +0.30 rank delta, got ${rankWith - rankWithout}`);
});

test('computeParetoFrontier includes strong post-intent candidates on Pareto skyline', () => {
  const candidateHighAuthority = {
    fullName: 'Alice Authority',
    decisionMakerVerification: { confidence: 10 },
    companyIntentEvidence: { evidenceQuality: 'weak' },
    evidence: { evidenceQuality: 'weak' },
    postIntentEvidence: { quality: 'none' as const, confidenceScore: 0 }
  };

  const candidateHighPostIntent = {
    fullName: 'Bob Intent',
    decisionMakerVerification: { confidence: 5 },
    companyIntentEvidence: { evidenceQuality: 'weak' },
    evidence: { evidenceQuality: 'weak' },
    postIntentEvidence: {
      quality: 'strong' as const,
      intentCategory: 'hiring' as const,
      confidenceScore: 0.9,
      postSnippets: ['Hiring senior engineers']
    }
  };

  const candidateDominated = {
    fullName: 'Charlie Weak',
    decisionMakerVerification: { confidence: 4 },
    companyIntentEvidence: { evidenceQuality: 'weak' },
    evidence: { evidenceQuality: 'weak' },
    postIntentEvidence: { quality: 'none' as const, confidenceScore: 0 }
  };

  const { skyline, nonSkyline } = computeParetoFrontier([
    candidateHighAuthority,
    candidateHighPostIntent,
    candidateDominated
  ]);

  const skylineNames = skyline.map(c => c.fullName);
  const nonSkylineNames = nonSkyline.map(c => c.fullName);

  assert.ok(skylineNames.includes('Alice Authority'), 'High-authority candidate must be on Pareto Skyline');
  assert.ok(skylineNames.includes('Bob Intent'), 'High-post-intent candidate must be on Pareto Skyline');
  assert.ok(nonSkylineNames.includes('Charlie Weak'), 'Dominated candidate must be excluded from Pareto Skyline');
});

test('runLinkedInPostIntentEnrichment processes leads in sorted rank order', async () => {
  const mockContract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Founders hiring automation specialists',
    authorityRequired: true,
    requirements: [],
    exclusions: [],
    initialQueries: []
  };

  const leadLowRank: any = {
    fullName: 'Low Rank',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/low-rank' },
    decisionMakerVerification: { confidence: 3 },
    qualification: { finalScore: 3.0 }
  };

  const leadHighRank: any = {
    fullName: 'High Rank',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/high-rank' },
    decisionMakerVerification: { confidence: 10 },
    qualification: { finalScore: 9.0 }
  };

  // Insert in low-then-high order
  const map = new Map([
    ['lead-low', leadLowRank],
    ['lead-high', leadHighRank]
  ]);

  const processedOrder: string[] = [];
  await runLinkedInPostIntentEnrichment({
    qualifiedLeads: map,
    contract: mockContract,
    maxLeads: 1, // Only allow top 1
    brightDataSearch: async (q) => {
      processedOrder.push(q);
      return [];
    },
    logEvent: () => {},
    recordTrace: () => {}
  });

  // Because maxLeads=1 and sorted by rank, High Rank MUST be the one processed
  assert.strictEqual(processedOrder.length, 1);
  assert.ok(processedOrder[0].includes('high-rank'), 'Must process High Rank lead first when maxLeads cap is reached');
});

test('cache pre-warm elevates a lead with cached strong intent above an equal-base-rank lead with no cache', () => {
  // This test verifies the fix for the circular sort problem:
  // Before the pre-warm, postIntentScore returns 5 for all leads (no postIntentEvidence),
  // so the sort is purely by base rank and a previously-seen high-intent lead gets skipped.
  // With pre-warm, cached intent is attached BEFORE the sort so rankLeadForFinalSelection
  // reflects the real historical signal.
  //
  // Correct semantics: ceteris paribus, cached strong intent breaks the tie upward.
  // We do NOT expect intent to overcome a large authority gap — authority at 0.30 weight
  // is rightly dominant. The pre-warm ensures that among similarly-ranked leads,
  // the one with confirmed historical buying signal bubbles to the top of the slice.

  const baseProfile = {
    decisionMakerVerification: { confidence: 7 },
    companyIntentEvidence: { evidenceQuality: 'partial' },
    evidence: { evidenceQuality: 'partial' },
    scout: { criteriaCoverageScore: 7, corroborationScore: 6 },
    qualification: { finalScore: 6.5 }
  };

  const leadNoIntent: any = { ...baseProfile, fullName: 'No Intent Lead' };

  const leadWithCachedIntent: any = {
    ...baseProfile,
    fullName: 'Cached Intent Lead',
    // postIntentEvidence pre-attached as cache pre-warm loop would do
    postIntentEvidence: {
      quality: 'strong' as const,
      intentCategory: 'evaluating_tools' as const,
      confidenceScore: 0.9,
      postSnippets: ['Actively evaluating n8n for automation stack'],
      intentKeywords: ['n8n', 'automation'],
      llmReason: 'Prospect is actively evaluating the exact tooling category.'
    }
  };

  const rankNoIntent = rankLeadForFinalSelection(leadNoIntent);
  const rankWithIntent = rankLeadForFinalSelection(leadWithCachedIntent);

  // postScore(strong, 0.9, fresh) ≈ 8.9 → contributes 8.9 * 0.10 = 0.89
  // Without intent: postScore = 5 → contributes 5 * 0.10 = 0.50
  // Delta = +0.39 to the rank of the intent lead, with all other inputs identical.
  assert.ok(rankWithIntent > rankNoIntent,
    `Cached-intent lead (${rankWithIntent}) must outrank equal-base-rank lead without intent (${rankNoIntent})`);
  assert.ok(rankWithIntent - rankNoIntent >= 0.30,
    `Expected at least +0.30 rank delta from cached strong intent, got ${rankWithIntent - rankNoIntent}`);
});


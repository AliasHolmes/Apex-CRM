import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDeterministicProspectContract,
  enforceContractQueries,
  normalizeProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION,
  type ProspectContract
} from '../server/leadSearch/prospectContract.ts';
import {
  finalistCandidateFromLead,
  partitionCandidatesByStrictEvidence,
  validateFinalistJudgments
} from '../server/leadSearch/finalistJudge.ts';
import { buildScoutEvidence } from '../server/leadSearch/scoutScoring.ts';
import { buildCollectionCapacity, collectionRefinementForRound } from '../server/leadSearch/collectionCapacity.ts';

const spec: any = {
  version: 1,
  mode: 'person_first',
  person: { includeTitles: ['owner'], excludeTitles: [], seniorities: [], locations: ['New York'] },
  company: { industries: [], keywords: ['AI agency'], locations: [] },
  signals: { include: [] },
  exclusions: { companies: [], domains: [] },
  maxPerCompany: 2
};

describe('evidence-grounded prospect quality', () => {
  it('keeps only explicit hard criteria and adds them to every query', () => {
    const brief = 'AI agency owner in New York';
    const fallback = buildDeterministicProspectContract(brief, spec);
    const contract = normalizeProspectContract({
      authorityRequired: true,
      exclusions: [],
      requirements: [{
        id: 'invented-director', scope: 'person_role', importance: 'hard',
        description: 'Director', sourcePhrase: 'director', acceptableTerms: ['director'], queryable: true
      }],
      initialQueries: [{ query: 'AI agency' }]
    }, brief, fallback);

    assert.equal(contract.requirements.some(item => item.sourcePhrase === 'director'), false);
    assert.ok(contract.requirements.some(item => item.sourcePhrase === 'owner'));
    assert.ok(contract.requirements.some(item => item.sourcePhrase === 'New York'));
    const queries = enforceContractQueries([{ query: 'AI agency' }], contract);
    assert.equal(queries.length, 4);
    assert.match(queries[0].query, /owner/i);
    assert.match(queries[0].query, /new york/i);
  });

  it('keeps plural ownership, profession, firm type, and location in recovery searches', () => {
    const brief = 'Immigration lawyer firm owners in New York';
    const fallback = buildDeterministicProspectContract(brief, spec);
    const contract = normalizeProspectContract({
      authorityRequired: true,
      exclusions: [],
      requirements: [{
        id: 'location-only', scope: 'person_location', importance: 'hard',
        description: 'New York', sourcePhrase: 'New York', acceptableTerms: ['New York'], queryable: true
      }],
      initialQueries: [{ query: 'New York' }]
    }, brief, fallback);

    assert.ok(contract.requirements.some(item => /owners?/i.test(item.sourcePhrase)));
    assert.ok(contract.requirements.some(item => /immigration lawyer/i.test(item.sourcePhrase)));
    assert.ok(contract.requirements.some(item => /firm/i.test(item.sourcePhrase)));
    const queries = enforceContractQueries([{ query: 'New York' }], contract);
    assert.equal(queries.length, 4);
    for (const item of queries) {
      assert.match(item.query, /(owners?|founder|ceo)/i);
      assert.match(item.query, /immigration lawyer/i);
      assert.match(item.query, /new york/i);
    }
  });

  it('scales collection capacity and distinct retrieval forms for a request of 50', () => {
    const capacity = buildCollectionCapacity({
      targetLimit: 50,
      poolMultiplier: 4,
      poolMax: 240,
      baseRounds: 6
    });

    assert.equal(capacity.candidateBatchSize, 12);
    assert.equal(capacity.rerankPoolTarget, 200);
    assert.equal(capacity.requestedJudgePool, 200);
    assert.equal(capacity.requiredRounds, 17);
    assert.equal(capacity.maxRounds, 19);
    assert.equal(capacity.poolCapped, false);
    const refinements = new Set(Array.from({ length: capacity.maxRounds - 2 }, (_, index) => collectionRefinementForRound(index + 3)));
    assert.equal(refinements.size, capacity.maxRounds - 2);
  });

  it('continues a 200-prospect request on a clear best-effort evidence budget', () => {
    const capacity = buildCollectionCapacity({
      targetLimit: 200,
      poolMultiplier: 4,
      poolMax: 240,
      baseRounds: 6
    });

    assert.equal(capacity.rerankPoolTarget, 240);
    assert.equal(capacity.requiredRounds, 20);
    assert.equal(capacity.maxRounds, 22);
    assert.equal(capacity.poolCapped, true);
  });

  it('does not qualify a candidate when a hard requirement lacks a valid evidence quote', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'AI agency owner in New York',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'company', scope: 'company_type', importance: 'hard', description: 'AI agency', sourcePhrase: 'AI agency', acceptableTerms: ['AI agency'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', description: 'New York', sourcePhrase: 'New York', acceptableTerms: ['New York'], queryable: true }
      ]
    };
    const evidence = 'Ada is Owner of Pixel AI agency in New York.';
    const candidate = finalistCandidateFromLead('ada', { fullName: 'Ada', currentTitle: 'Owner', currentCompany: 'Pixel', location: 'New York' }, evidence);
    const good = validateFinalistJudgments({ judgments: [{
      candidateId: 'ada', semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, verdict: 'qualified', reason: 'Direct profile match.',
      requirements: [
        { requirementId: 'role', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Owner' },
        { requirementId: 'company', status: 'pass', evidenceId: 'e1', evidenceQuote: 'AI agency' },
        { requirementId: 'location', status: 'pass', evidenceId: 'e1', evidenceQuote: 'New York' }
      ]
    }] }, contract, [candidate]);
    assert.equal(good.qualifications.size, 1);

    const bad = validateFinalistJudgments({ judgments: [{
      candidateId: 'ada', semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, verdict: 'qualified', reason: 'Claimed match.',
      requirements: [
        { requirementId: 'role', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Owner' },
        { requirementId: 'company', status: 'pass', evidenceId: 'e1', evidenceQuote: 'AI agency' },
        { requirementId: 'location', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Brooklyn' }
      ]
    }] }, contract, [candidate]);
    assert.equal(bad.qualifications.size, 0);
  });

  it('uses current extraction fields when displaying matched scouting criteria', () => {
    const evidence = buildScoutEvidence({
      currentTitle: 'Owner', currentCompany: 'Pixel AI Agency', location: 'New York', evidence: { rawText: 'Owner of an AI agency in New York.' }
    }, spec);
    assert.ok(evidence.matchedCriteria.includes('target title'));
    assert.ok(evidence.matchedCriteria.includes('target location'));
    assert.ok(evidence.matchedCriteria.includes('company keyword'));
  });

  it('keeps finalist evidence bounded while preserving proof for varied hard requirements', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'VP Engineering at a fintech company in London with Series B funding',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', description: 'VP Engineering', sourcePhrase: 'VP Engineering', acceptableTerms: ['VP Engineering', 'Vice President Engineering'], queryable: true },
        { id: 'industry', scope: 'company_industry', importance: 'hard', description: 'fintech', sourcePhrase: 'fintech', acceptableTerms: ['fintech', 'financial technology'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', description: 'London', sourcePhrase: 'London', acceptableTerms: ['London'], queryable: true },
        { id: 'funding', scope: 'signal', importance: 'hard', description: 'Series B funding', sourcePhrase: 'Series B funding', acceptableTerms: ['Series B', 'Series B funding'], queryable: true }
      ]
    };
    const rawEvidence = [
      ...Array.from({ length: 40 }, (_, index) => `Unrelated conference detail ${index} about generic technology.`),
      'Mina Patel is VP Engineering at ClearLedger, a fintech company in London.',
      'ClearLedger announced a $22m Series B funding round to expand its compliance platform.'
    ].join(' ');
    const candidate = finalistCandidateFromLead('mina', {
      fullName: 'Mina Patel', currentTitle: 'VP Engineering', currentCompany: 'ClearLedger', industry: 'Fintech', location: 'London',
      evidence: { rawText: rawEvidence }
    }, rawEvidence, contract);
    const finalistText = candidate.evidence.map(item => item.text).join('\n');

    assert.ok(candidate.evidence.reduce((sum, item) => sum + item.text.length, 0) <= 1_100);
    assert.match(finalistText, /VP Engineering/i);
    assert.match(finalistText, /fintech/i);
    assert.match(finalistText, /London/i);
    assert.match(finalistText, /Series B/i);
    // Funding is a contextual signal, so it remains with the semantic judge.
    assert.equal(partitionCandidatesByStrictEvidence([candidate], contract).needsJudge.length, 1);
  });

  it('only fast-paths exact structured matches and never turns a director into an owner', () => {
    const ownerContract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'healthcare company owner in Toronto',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'industry', scope: 'company_industry', importance: 'hard', description: 'healthcare', sourcePhrase: 'healthcare', acceptableTerms: ['healthcare'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', description: 'Toronto', sourcePhrase: 'Toronto', acceptableTerms: ['Toronto'], queryable: true }
      ]
    };
    const misleading = finalistCandidateFromLead('director', {
      fullName: 'Chris Lee', currentTitle: 'Marketing Director', currentCompany: 'Harbor Health', industry: 'Healthcare', location: 'Toronto',
      evidence: { rawText: 'Chris advises several business owners in Toronto.' }
    }, undefined, ownerContract);
    const strictOwnerResult = partitionCandidatesByStrictEvidence([misleading], ownerContract);
    assert.equal(strictOwnerResult.autoQualified.length, 0);
    assert.equal(strictOwnerResult.needsJudge.length, 1);

    const cisoContract: ProspectContract = {
      ...ownerContract,
      brief: 'CISO at a healthcare company in Toronto',
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', description: 'CISO', sourcePhrase: 'CISO', acceptableTerms: ['CISO', 'Chief Information Security Officer'], queryable: true },
        ...ownerContract.requirements.slice(1)
      ]
    };
    const direct = finalistCandidateFromLead('ciso', {
      fullName: 'Avery Shaw', currentTitle: 'Chief Information Security Officer', currentCompany: 'Harbor Health', industry: 'Healthcare', location: 'Toronto',
      scoreBreakdown: { finalScore: 8.4 }, decisionMakerVerification: { confidence: 9 }
    }, undefined, cisoContract);
    const strictCisoResult = partitionCandidatesByStrictEvidence([direct], cisoContract);
    assert.equal(strictCisoResult.autoQualified.length, 1);
    assert.equal(strictCisoResult.autoQualified[0].qualification.qualificationSource, 'deterministic');
    assert.equal(strictCisoResult.needsJudge.length, 0);
  });
});

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
import { buildScoutEvidence, selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.ts';
import { buildCollectionCapacity, collectionRefinementForRound, shouldKeepCollectingAfterStall } from '../server/leadSearch/collectionCapacity.ts';
import { buildStrategistPrompt } from '../server/leadSearch/searchSpec.ts';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.ts';
import { selectEvidenceForFinalist } from '../server/leadSearch/evidenceSelection.ts';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.ts';
import { computeMMRDiversitySelection, computeScoreBreakdown } from '../server/leadSearch/scoring.ts';
import { createLeadEvidence } from '../server/leadSearch/evidence.ts';

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

    assert.equal(capacity.candidateBatchSize, 30);
    assert.equal(capacity.rerankPoolTarget, 200);
    assert.equal(capacity.requestedJudgePool, 200);
    assert.equal(capacity.requiredRounds, 7);
    assert.equal(capacity.maxRounds, 8);
    assert.equal(capacity.poolCapped, false);
    const refinements = new Set(Array.from({ length: capacity.maxRounds - 2 }, (_, index) => collectionRefinementForRound(index + 3)));
    assert.equal(refinements.size, capacity.maxRounds - 2);
  });

  it('uses dynamic pool sizing and batch throughput for a 30-prospect search', () => {
    const capacity = buildCollectionCapacity({
      targetLimit: 30,
      contractHardReqCount: 2
    });

    assert.equal(capacity.candidateBatchSize, 18);
    assert.equal(capacity.rerankPoolTarget, 53); // 30 * 1.75 = 53
    assert.equal(capacity.requiredRounds, 3);
    assert.equal(capacity.maxRounds, 4); // bounded to 4-6 rounds
  });

  it('uses the full bounded recovery budget when a 20-prospect search stalls below target', () => {
    const capacity = buildCollectionCapacity({
      targetLimit: 20,
      poolMultiplier: 4,
      poolMax: 240,
      baseRounds: 6,
      contractHardReqCount: 2
    });

    assert.equal(capacity.rerankPoolTarget, 80);
    assert.equal(capacity.requiredRounds, 7);
    assert.equal(capacity.maxRounds, 6);
    assert.equal(shouldKeepCollectingAfterStall({
      completedRound: 5,
      maxRounds: capacity.maxRounds,
      acceptedLeads: 5,
      rerankPoolTarget: capacity.rerankPoolTarget
    }), true);
    assert.equal(shouldKeepCollectingAfterStall({
      completedRound: 6,
      maxRounds: capacity.maxRounds,
      acceptedLeads: 5,
      rerankPoolTarget: capacity.rerankPoolTarget
    }), false);
  });

  it('continues a 200-prospect request on a clear best-effort evidence budget', () => {
    const capacity = buildCollectionCapacity({
      targetLimit: 200,
      poolMultiplier: 4,
      poolMax: 240,
      baseRounds: 6
    });

    assert.equal(capacity.candidateBatchSize, 36);
    assert.equal(capacity.rerankPoolTarget, 240);
    assert.equal(capacity.requiredRounds, 7);
    assert.equal(capacity.maxRounds, 8);
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
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'company', scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile', description: 'AI agency', sourcePhrase: 'AI agency', acceptableTerms: ['AI agency'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'New York', sourcePhrase: 'New York', acceptableTerms: ['New York'], queryable: true }
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
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'VP Engineering', sourcePhrase: 'VP Engineering', acceptableTerms: ['VP Engineering', 'Vice President Engineering'], queryable: true },
        { id: 'industry', scope: 'company_industry', importance: 'hard', evidenceModality: 'structured_profile', description: 'fintech', sourcePhrase: 'fintech', acceptableTerms: ['fintech', 'financial technology'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'London', sourcePhrase: 'London', acceptableTerms: ['London'], queryable: true },
        { id: 'funding', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'Series B funding', sourcePhrase: 'Series B funding', acceptableTerms: ['Series B', 'Series B funding'], queryable: true }
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
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'industry', scope: 'company_industry', importance: 'hard', evidenceModality: 'structured_profile', description: 'healthcare', sourcePhrase: 'healthcare', acceptableTerms: ['healthcare'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'Toronto', sourcePhrase: 'Toronto', acceptableTerms: ['Toronto'], queryable: true }
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
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'CISO', sourcePhrase: 'CISO', acceptableTerms: ['CISO', 'Chief Information Security Officer'], queryable: true },
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

  it('generates signal-lane queries for hard open_web_signal requirements and attaches them to initial queries', () => {
    const brief = 'AI agency owners in London hiring n8n engineers';
    const contract = buildDeterministicProspectContract(brief, {
      ...spec,
      signals: { include: ['hiring n8n engineers'] }
    });

    const signalReq = contract.requirements.find(r => r.scope === 'signal');
    assert.ok(signalReq, 'Signal requirement should exist');
    assert.equal(signalReq?.evidenceModality, 'open_web_signal');

    // The signal lane queries should be included in initialQueries
    const signalQueries = contract.initialQueries.filter(q => q.lane === 'signal');
    assert.ok(signalQueries.length >= 1, 'At least 1 signal-lane query should be generated');
    assert.equal(signalQueries[0].family, 'pain_signal');
    assert.equal(signalQueries[0].intent, 'find_buying_signal');
  });

  it('assigns qualified_partial when profile requirements pass but open_web_signal is unknown, applying a 15% discount', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'AI agency owner in New York hiring n8n developers',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'company', scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile', description: 'AI agency', sourcePhrase: 'AI agency', acceptableTerms: ['AI agency'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'New York', sourcePhrase: 'New York', acceptableTerms: ['New York'], queryable: true },
        { id: 'signal', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'hiring n8n developers', sourcePhrase: 'hiring n8n developers', acceptableTerms: ['hiring n8n', 'n8n developers'], queryable: true }
      ]
    };
    const evidence = 'Marcus is Founder & Owner at Neural Spark, an AI agency in New York.';
    const candidate = finalistCandidateFromLead('marcus', {
      fullName: 'Marcus Vance', currentTitle: 'Owner', currentCompany: 'Neural Spark', location: 'New York'
    }, evidence, contract);

    // LLM validates role, company, location as pass; signal is unknown because LinkedIn bio lacks job post
    const judgmentRaw = [{
      candidateId: 'marcus',
      semanticFit: 9.0,
      authorityFit: 9.0,
      evidenceConfidence: 8.0,
      verdict: 'qualified',
      reason: 'Owner of verified AI agency in New York.',
      requirements: [
        { requirementId: 'role', status: 'pass', evidenceId: 'e0' },
        { requirementId: 'company', status: 'pass', evidenceId: 'e0' },
        { requirementId: 'location', status: 'pass', evidenceId: 'e0' },
        { requirementId: 'signal', status: 'unknown' }
      ]
    }];

    const validation = validateFinalistJudgments({ judgments: judgmentRaw }, contract, [candidate]);
    assert.equal(validation.counts.qualified, 1);
    assert.equal(validation.counts.hardFail, 0);

    const outcome = validation.outcomes.get('marcus');
    assert.equal(outcome?.status, 'qualified_partial');
    assert.ok(outcome?.qualification);
    assert.equal(outcome?.qualification?.verdict, 'qualified_partial');

    // Baseline weighted: 9*0.50 + 8*0.25 + 9*0.15 + 7*0.10 = 4.5 + 2.0 + 1.35 + 0.70 = 8.55
    // With 15% discount: 8.55 * 0.85 = 7.2675 -> 7.27
    assert.ok(outcome.qualification.finalScore < 8.55);
    assert.equal(outcome.qualification.finalScore, 7.27);

    // Verify that if LLM returns 0.0 - 1.0 probability floats, it scales them to 0-10 identically
    const floatJudgmentRaw = [{
      ...judgmentRaw[0],
      semanticFit: 0.90,
      authorityFit: 0.90,
      evidenceConfidence: 0.80
    }];
    const floatValidation = validateFinalistJudgments({ judgments: floatJudgmentRaw }, contract, [candidate]);
    const floatOutcome = floatValidation.outcomes.get('marcus');
    assert.equal(floatOutcome?.qualification?.finalScore, 7.27);
  });

  it('hard-fails a candidate when a structured_profile hard requirement fails, even if signal passes', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'AI agency owner in New York hiring n8n developers',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'New York', sourcePhrase: 'New York', acceptableTerms: ['New York'], queryable: true },
        { id: 'signal', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'hiring n8n developers', sourcePhrase: 'hiring n8n developers', acceptableTerms: ['hiring n8n'], queryable: true }
      ]
    };
    const evidence = 'Junior Dev in London at a startup hiring n8n developers.';
    const candidate = finalistCandidateFromLead('junior', {
      fullName: 'Dev Junior', currentTitle: 'Junior Developer', currentCompany: 'Startup Ltd', location: 'London'
    }, evidence, contract);

    const judgmentRaw = [{
      candidateId: 'junior',
      semanticFit: 2.0,
      authorityFit: 1.0,
      evidenceConfidence: 8.0,
      verdict: 'not_qualified',
      reason: 'Junior developer in London, not an owner in New York.',
      requirements: [
        { requirementId: 'role', status: 'fail' },
        { requirementId: 'location', status: 'fail' },
        { requirementId: 'signal', status: 'pass' }
      ]
    }];

    const validation = validateFinalistJudgments({ judgments: judgmentRaw }, contract, [candidate]);
    assert.equal(validation.counts.hardFail, 1);
    assert.equal(validation.counts.qualified, 0);
    const outcome = validation.outcomes.get('junior');
    assert.equal(outcome?.status, 'hard_fail');
  });

  it('buildStrategistPrompt includes compiled requirements digest and unmet hard requirements', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'dental clinic owner in Austin',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner', 'founder'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'Austin', sourcePhrase: 'Austin', acceptableTerms: ['Austin', 'TX'], queryable: true },
        { id: 'signal', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'hiring dental hygienist', sourcePhrase: 'hiring dental hygienist', acceptableTerms: ['hiring hygienist'], queryable: true }
      ]
    };

    const logs: string[] = [];
    const prompt = buildStrategistPrompt({
      query: 'dental clinic owner in Austin',
      round: 2,
      maxRounds: 6,
      remaining: 5,
      previousQueries: ['dental clinic owner Austin'],
      previousRoundSummary: { viableCandidates: 1 },
      contract,
      missingRequirementIds: ['signal'],
      logEvent: (msg) => logs.push(msg)
    });

    assert.ok(prompt.includes('Compiled prospect requirements'));
    assert.ok(prompt.includes('[hard/person_role/structured_profile] owner'));
    assert.ok(prompt.includes('[hard/signal/open_web_signal] hiring dental hygienist'));
    assert.ok(prompt.includes('UNMET HARD REQUIREMENTS'));
    assert.ok(prompt.includes('signal'));
    assert.ok(prompt.includes('lane: "signal" and search open web'));
    assert.ok(logs.some(l => l.includes('[Strategist] Injected unmet hard requirements into prompt: [signal]')));
  });

  it('buildRoundDiagnostics is session-aware and uses contract terms without false recovery for non-US/UK niches', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'factory manager in Toronto Canada',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'factory manager', sourcePhrase: 'factory manager', acceptableTerms: ['factory manager', 'plant manager'], queryable: true },
        { id: 'location', scope: 'person_location', importance: 'hard', evidenceModality: 'structured_profile', description: 'Toronto Canada', sourcePhrase: 'Toronto Canada', acceptableTerms: ['Toronto', 'Ontario', 'Canada'], queryable: true }
      ]
    };

    const leads = [
      { fullName: 'Pierre Tremblay', currentTitle: 'Plant Manager', currentCompany: 'Apex Manufacturing', location: 'Toronto, Ontario, Canada' },
      { fullName: 'Sarah Chen', currentTitle: 'Factory Manager', currentCompany: 'Precision Metals', location: 'Toronto, Canada' }
    ];

    // Case 1: When alreadyQualified is 8 for target 10, banked(8) + viable(2) = 10 >= 5 -> shouldRecover is false
    const diagSatisfied = buildRoundDiagnostics({
      round: 2,
      rawCandidates: 10,
      extractedCandidates: 2,
      leads,
      contract,
      targetLimit: 10,
      alreadyQualified: 8
    });

    assert.equal(diagSatisfied.viableCandidates, 2);
    assert.equal(diagSatisfied.missingHardRequirementIds.length, 0);
    assert.equal(diagSatisfied.shouldRecover, false);

    // Case 2: When alreadyQualified is 0 and only 1 viable candidate for target 10 -> shouldRecover is true
    const diagShort = buildRoundDiagnostics({
      round: 1,
      rawCandidates: 10,
      extractedCandidates: 1,
      leads: [leads[0]],
      contract,
      targetLimit: 10,
      alreadyQualified: 0
    });

    assert.equal(diagShort.shouldRecover, true);
  });

  it('selectEvidenceForFinalist pins open-web signal evidence to e2 slot and tracks coverage', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'AI agency owner in New York hiring n8n developers',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner', 'founder'], queryable: true },
        { id: 'company', scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile', description: 'AI agency', sourcePhrase: 'AI agency', acceptableTerms: ['AI agency', 'AI consultancy'], queryable: true },
        { id: 'signal', scope: 'signal', importance: 'hard', evidenceModality: 'open_web_signal', description: 'hiring n8n', sourcePhrase: 'hiring n8n', acceptableTerms: ['hiring n8n', 'n8n developer'], queryable: true }
      ]
    };

    const lead = {
      fullName: 'Alex Vance',
      currentTitle: 'Founder & CEO',
      currentCompany: 'FlowState AI',
      location: 'New York, NY',
      evidence: {
        rawText: 'Founder of FlowState AI, a leading AI consultancy in New York.',
        snippets: [
          '[OPEN-WEB SIGNAL: https://jobs.lever.co/flowstate/n8n] FlowState AI is hiring an n8n developer for workflow automation systems.'
        ]
      }
    };

    const selected = selectEvidenceForFinalist(lead, contract);
    assert.ok(selected.evidence.some(e => e.id === 'e2'));
    const e2 = selected.evidence.find(e => e.id === 'e2');
    assert.ok(e2?.text.includes('[OPEN-WEB SIGNAL:'));
    assert.ok(e2?.text.includes('hiring an n8n developer'));
    assert.ok(selected.coveredHardRequirementIds.includes('signal'));
  });

  it('verifyDecisionMakerFromEvidence handles qualified consultant titles and ignores stop words', () => {
    const principalConsultant = verifyDecisionMakerFromEvidence({
      query: 'looking for AI agency consultant in New York',
      currentTitle: 'Principal Security Consultant',
      currentCompany: 'CyberAI LLC'
    });

    assert.equal(principalConsultant.ignoredTitle, false);
    assert.ok(principalConsultant.confidence >= 5);

    const intern = verifyDecisionMakerFromEvidence({
      query: 'AI agency in New York',
      currentTitle: 'Summer Intern',
      currentCompany: 'CyberAI LLC'
    });

    assert.equal(intern.ignoredTitle, true);
    assert.equal(intern.confidence, 2);
  });

  it('selectDiversifiedLeads guarantees top Pareto skyline non-dominated leads make the output', () => {
    const candidates = [
      { id: 'c1', fullName: 'Lead One', currentCompany: 'Alpha Corp', fitScore: 9, intentScore: 9, evidenceQualityScore: 9, finalSelectionScore: 8.5 },
      { id: 'c2', fullName: 'Lead Two', currentCompany: 'Beta Corp', fitScore: 8, intentScore: 8, evidenceQualityScore: 8, finalSelectionScore: 8.0 },
      { id: 'c3', fullName: 'Lead Three', currentCompany: 'Gamma Corp', fitScore: 7, intentScore: 7, evidenceQualityScore: 7, finalSelectionScore: 7.5 }
    ];

    const selected = selectDiversifiedLeads(candidates, 2, 1);
    assert.equal(selected.length, 2);
    // Non-dominated c1 must be included in output
    assert.ok(selected.some(c => c.id === 'c1'));
  });

  it('computeMMRDiversitySelection penalizes company variations using companiesMatch', () => {
    const candidates = [
      { id: 'c1', currentCompany: 'Google LLC', location: 'Mountain View', fitScore: 9, finalSelectionScore: 9.0 },
      { id: 'c2', currentCompany: 'Google Inc', location: 'Mountain View', fitScore: 8.8, finalSelectionScore: 8.8 },
      { id: 'c3', currentCompany: 'Microsoft Corp', location: 'Redmond', fitScore: 8.5, finalSelectionScore: 8.5 }
    ];

    // With target count 2, c1 (Google) is picked first. Because Google Inc matches Google LLC via companiesMatch,
    // MMR should penalize Google Inc and pick Microsoft Corp (c3) instead of second Google.
    const selected = computeMMRDiversitySelection(candidates, 2, 0.70);
    assert.equal(selected.length, 2);
    assert.equal(selected[0].id, 'c1');
    assert.equal(selected[1].id, 'c3');
  });

  it('selectEvidenceForFinalist extracts sentences from lead.evidence.evidenceBlock when evidenceText is omitted', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'AI agency owner in New York',
      authorityRequired: true,
      exclusions: [],
      initialQueries: [],
      requirements: [
        { id: 'role', scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile', description: 'owner', sourcePhrase: 'owner', acceptableTerms: ['owner', 'founder'], queryable: true },
        { id: 'company', scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile', description: 'AI agency', sourcePhrase: 'AI agency', acceptableTerms: ['AI agency', 'AI consultancy'], queryable: true }
      ]
    };

    const lead = {
      fullName: 'Samantha Ray',
      currentTitle: 'Founder',
      currentCompany: 'Apex Intelligence',
      location: 'New York, NY',
      evidence: {
        evidenceBlock: 'Samantha Ray is the Founder and Principal of Apex Intelligence, a premier AI agency in New York specializing in generative AI.'
      }
    };

    const selected = selectEvidenceForFinalist(lead, contract);
    assert.ok(selected.evidence.length >= 2);
    assert.ok(selected.evidence.some(e => e.text.includes('Samantha Ray is the Founder')));
    assert.ok(selected.coveredHardRequirementIds.includes('role'));
    assert.ok(selected.coveredHardRequirementIds.includes('company'));
  });

  it('finalistCandidateFromLead falls back to lead.evidence.evidenceBlock without contract', () => {
    const lead = {
      fullName: 'Marcus Brody',
      currentTitle: 'Chief AI Architect',
      currentCompany: 'Brody Labs',
      evidence: {
        evidenceBlock: 'Brody Labs AI consultancy founder Marcus Brody has 15 years in machine learning.'
      }
    };

    const candidate = finalistCandidateFromLead('c0', lead);
    assert.ok(candidate.evidence.some(e => e.text.includes('Brody Labs AI consultancy founder Marcus Brody')));
  });

  it('createLeadEvidence preserves full evidenceBlock and generates snippets', () => {
    const evidence = createLeadEvidence({
      sourceUrl: 'https://linkedin.com/in/test-lead',
      sourceProvider: 'tavily',
      sourceQuery: 'AI Founder New York',
      sourceRound: 1,
      evidenceQuality: 'good',
      evidenceBlock: 'LINK: https://linkedin.com/in/test-lead\nFounder & CEO at NextGen AI in New York.\nSpecializing in LLM workflow automation.',
      whyThisLead: 'Matches AI founder in New York'
    });

    assert.equal(evidence.evidenceBlock, 'LINK: https://linkedin.com/in/test-lead\nFounder & CEO at NextGen AI in New York.\nSpecializing in LLM workflow automation.');
    assert.ok(evidence.snippets.length >= 1);
    assert.ok(evidence.snippets.some(s => s.includes('Founder & CEO at NextGen AI')));
  });

  it('computeScoreBreakdown does not apply 7.5 cap when email is present in flat contactDetails.email or lead.email', () => {
    const leadWithFlatContact = {
      fullName: 'David Lee',
      currentCompany: 'Lee Dynamics',
      contactDetails: { email: 'david@leedynamics.com' },
      fitScore: 9,
      intentScore: 9,
      timingScore: 9,
      evidence: { evidenceQuality: 'weak' }
    };

    const leadWithDirectEmail = {
      fullName: 'David Lee',
      currentCompany: 'Lee Dynamics',
      email: 'david@leedynamics.com',
      fitScore: 9,
      intentScore: 9,
      timingScore: 9,
      evidence: { evidenceQuality: 'weak' }
    };

    const leadWithoutEmail = {
      fullName: 'David Lee',
      currentCompany: 'Lee Dynamics',
      fitScore: 9,
      intentScore: 9,
      timingScore: 9,
      evidence: { evidenceQuality: 'weak' }
    };

    const breakdown1 = computeScoreBreakdown(leadWithFlatContact, 'weak', 'tavily');
    const breakdown2 = computeScoreBreakdown(leadWithDirectEmail, 'weak', 'tavily');
    const breakdown3 = computeScoreBreakdown(leadWithoutEmail, 'weak', 'tavily');

    // Without email + weak evidence -> capped at 7.5
    assert.ok(breakdown3.finalScore <= 7.5);
    // With flat email + weak evidence -> not capped at 7.5
    assert.ok(breakdown1.finalScore > 7.5);
    assert.ok(breakdown2.finalScore > 7.5);
  });
});


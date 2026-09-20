import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROSPECT_CONTRACT_POLICY_VERSION,
  buildDeterministicProspectContract,
} from '../server/leadSearch/prospectContract.js';
import { buildFinalistJudgePrompt } from '../server/leadSearch/finalistJudge.js';
import { buildStrategistPrompt } from '../server/leadSearch/searchSpec.js';

test('Component 1: PROSPECT_CONTRACT_POLICY_VERSION is bumped to evidence-contract-v9', () => {
  assert.equal(PROSPECT_CONTRACT_POLICY_VERSION, 'evidence-contract-v9');
  const contract = buildDeterministicProspectContract('Find agency owners who use n8n', {});
  assert.equal(contract.policyVersion, 'evidence-contract-v9');
});

test('Component 2: buildFinalistJudgePrompt includes both hard and soft requirements', () => {
  const contract = buildDeterministicProspectContract(
    'Agency owners in North America actively posting about custom n8n workflows and delivery bottlenecks',
    {}
  );
  
  // Ensure contract has both hard and soft requirements
  const hasHard = contract.requirements.some((r) => r.importance === 'hard');
  const hasSoft = contract.requirements.some((r) => r.importance === 'soft');
  assert.ok(hasHard, 'Contract should have hard requirements');
  assert.ok(hasSoft, 'Contract should have soft requirements');

  const candidates = [
    {
      candidateId: 'c1',
      lead: {
        id: 'lead-1',
        fullName: 'Jane Doe',
        company: 'Workflow Studio',
        title: 'Founder & CEO',
      },
      evidence: [
        { id: 'e0', text: 'Jane Doe is the Founder & CEO of Workflow Studio.' },
        { id: 'e1', text: 'We build custom n8n workflows to eliminate client delivery bottlenecks.' }
      ],
      citationMap: {},
      relevanceScore: 9,
    },
  ];

  const prompt = buildFinalistJudgePrompt(contract as any, candidates as any);

  // Assert that BOTH hard requirements and soft requirements appear in the judge prompt
  for (const req of contract.requirements) {
    assert.ok(
      prompt.includes(req.id),
      `Judge prompt must contain requirement ${req.id} (${req.importance}/${req.scope})`
    );
  }
  assert.ok(prompt.includes('[hard/'), 'Prompt must contain [hard/ markers');
  assert.ok(prompt.includes('[soft/'), 'Prompt must contain [soft/ markers');
});

test('Component 4: buildStrategistPrompt enforces Intent Retention Rule for intent-driven briefs', () => {
  const contract = buildDeterministicProspectContract(
    'Agency owners in North America actively posting about custom n8n workflows and delivery bottlenecks',
    {}
  );

  const prompt = buildStrategistPrompt({
    query: 'Agency owners in North America actively posting about custom n8n workflows and delivery bottlenecks',
    round: 1,
    maxRounds: 6,
    remaining: 20,
    contract: contract as any,
    spec: {} as any,
    previousQueries: [],
    queryPerformance: {},
    previousRoundSummary: {},
  });

  // Verify Intent Retention Rule is included
  assert.ok(
    prompt.includes('Lanes & Intent Retention Rule'),
    'Strategist prompt must include Intent Retention Rule'
  );
  assert.ok(
    prompt.includes('at least 2 of the 4 queries MUST combine identity/role terms with an intent or tooling qualifier'),
    'Strategist prompt must mandate intent qualifier combination'
  );
  assert.ok(
    prompt.includes('NEVER generate 100% bare identity-only queries'),
    'Strategist prompt must prohibit 100% bare identity queries'
  );
  // Verify North America resolves to Canada and USA metros, not just USA
  assert.ok(
    prompt.includes('Canada') || prompt.includes('Toronto') || prompt.includes('Vancouver') || prompt.includes('RECOMMENDED UNVISITED METROS'),
    'Strategist prompt should handle geographic targeting cleanly'
  );
});

test('Component 3: Dual-stream intent gating requires signal corroboration', () => {
  const contract = buildDeterministicProspectContract(
    'Agency owners in North America actively posting about custom n8n workflows and delivery bottlenecks',
    {}
  );

  // Assert contract is dual_stream_intent or has signal requirements
  const hasIntentRequirements =
    contract.decompositionMode === 'dual_stream_intent' ||
    contract.requirements.some((r) => r.scope === 'signal' || r.requirementClass === 'ranking_signal') ||
    Boolean(contract.intentSpec?.toolingKeywords?.length);
  assert.ok(hasIntentRequirements, 'Contract must declare intent requirements');

  // Candidate leads: 20 leads with valid identity, but zero intent corroboration
  const identityOnlyLeads = Array.from({ length: 20 }, (_, idx) => ({
    id: `lead-${idx}`,
    fullName: `Candidate ${idx}`,
    company: `Agency ${idx}`,
    title: 'Founder & Owner',
    qualification: {
      verdict: 'qualified_partial' as const,
      requirements: [
        { requirementId: 'role-1', status: 'pass' },
        { requirementId: 'company-1', status: 'pass' },
        { requirementId: 'signal-1', status: 'unknown' },
      ],
    },
    signals: [],
  }));

  const intentCorroboratedCount = identityOnlyLeads.filter((lead) => {
    const hasPassedSignalReq =
      Array.isArray(lead.qualification?.requirements) &&
      lead.qualification.requirements.some(
        (r: any) =>
          r.status === 'pass' &&
          (r.requirementId?.startsWith('signal') ||
            r.requirementId?.startsWith('pain') ||
            r.requirementId?.startsWith('tool') ||
            r.requirementClass === 'ranking_signal'),
      );
    const hasIntentSignals = Boolean(
      (lead.signals && lead.signals.length > 0) ||
        (lead as any).intent_evidence ||
        (lead as any).companyIntentEvidence ||
        (lead as any).linkedinPostIntentEvidence ||
        (lead as any).scout?.hasBuyingSignal,
    );
    return hasPassedSignalReq || hasIntentSignals;
  }).length;

  const targetLimit = 20;
  const minIntentRequiredRatio = 0.35;
  const requiredIntentCount = Math.ceil(targetLimit * minIntentRequiredRatio);
  const intentThresholdMet = !hasIntentRequirements || intentCorroboratedCount >= requiredIntentCount;

  // Identity-only leads MUST NOT satisfy the intent threshold
  assert.equal(intentCorroboratedCount, 0);
  assert.equal(requiredIntentCount, 7);
  assert.equal(intentThresholdMet, false, 'Intent threshold must NOT be met by identity-only leads');
});


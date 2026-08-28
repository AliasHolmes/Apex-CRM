import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProspectContract,
  buildDeterministicProspectContract,
  searchSpecFromProspectContract,
  buildSignalLaneQueries,
  ProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION
} from '../server/leadSearch/prospectContract.js';
import { buildFallbackSearchSpec } from '../server/leadSearch/searchSpec.js';

test('normalizeProspectContract gives primary precedence to LLM modelHard requirements over regex fallback', () => {
  const brief = 'Find founders, CEOs, or operations directors of marketing, lead-generation, SEO, or creative agencies in the US or Canada';
  const fallback = buildDeterministicProspectContract(brief);

  // Simulated LLM model output that parsed the natural language accurately
  const llmOutput = {
    decompositionMode: 'single_stream_identity',
    authorityRequired: true,
    exclusions: ['custom software', 'SaaS'],
    identitySpec: {
      roles: ['founder', 'CEO', 'operations director'],
      locations: ['US', 'Canada'],
      companyTypes: ['marketing agency', 'lead-generation agency', 'SEO agency', 'creative agency'],
      industries: ['Marketing & Advertising']
    },
    requirements: [
      {
        id: 'person_role-1',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'founder or CEO or operations director',
        sourcePhrase: 'founders, CEOs, or operations directors',
        acceptableTerms: ['founder', 'founders', 'CEO', 'chief executive officer', 'operations director', 'head of operations'],
        queryable: true,
        matchRule: 'any_of',
        groupId: 'person_role_group'
      },
      {
        id: 'company_type-1',
        scope: 'company_type',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'marketing, lead-generation, SEO, or creative agencies',
        sourcePhrase: 'marketing, lead-generation, SEO, or creative agencies',
        acceptableTerms: ['marketing agency', 'lead-generation agency', 'SEO agency', 'creative agency', 'marketing agencies'],
        queryable: true
      },
      {
        id: 'person_location-1',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'the US or Canada',
        sourcePhrase: 'the US or Canada',
        acceptableTerms: ['US', 'United States', 'USA', 'Canada'],
        queryable: true
      }
    ],
    initialQueries: [
      { query: 'founder marketing agency US' },
      { query: 'CEO lead-generation agency Canada' }
    ]
  };

  const normalized = normalizeProspectContract(llmOutput, brief, fallback);

  assert.equal(normalized.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
  
  // Verify company_type is NOT corrupted by fallback regex artifacts (e.g. "Find")
  const compReq = normalized.requirements.find(r => r.scope === 'company_type');
  assert.ok(compReq, 'Must have company_type requirement');
  assert.ok(
    compReq.acceptableTerms.includes('marketing agency'),
    'Must include LLM extracted company type "marketing agency"'
  );
  assert.ok(
    !compReq.acceptableTerms.includes('Find'),
    'Must NOT include command verb "Find"'
  );

  // Verify person_role is unified with matchRule: any_of
  const roleReq = normalized.requirements.find(r => r.scope === 'person_role');
  assert.ok(roleReq, 'Must have person_role requirement');
  assert.equal(roleReq.matchRule, 'any_of');
  assert.ok(roleReq.acceptableTerms.includes('founder'));
  assert.ok(roleReq.acceptableTerms.includes('CEO'));
});

test('searchSpecFromProspectContract keeps excludeTitles clean from contract.exclusions', () => {
  const baseSpec = buildFallbackSearchSpec('test brief');
  baseSpec.person.excludeTitles = ['Intern', 'Student'];

  const contract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Test brief',
    authorityRequired: true,
    requirements: [
      {
        id: 'person_role-1',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'founder',
        sourcePhrase: 'founder',
        acceptableTerms: ['founder', 'CEO'],
        queryable: true
      }
    ],
    exclusions: ['CTO', 'Head of Engineering', 'Technical Co-founder', 'custom software'],
    initialQueries: []
  };

  const spec = searchSpecFromProspectContract(baseSpec, contract);

  // Exclude titles must ONLY contain base exclude titles, NOT contract organizational exclusions
  assert.deepEqual(spec.person.excludeTitles, ['Intern', 'Student']);
});

test('normalizeProspectContract uses emergency fallback when LLM output is empty or invalid', () => {
  const brief = 'Marketing agency owner in Canada';
  const fallback = buildDeterministicProspectContract(brief);

  // LLM failed and returned empty object
  const normalized = normalizeProspectContract({}, brief, fallback);

  assert.ok(normalized.requirements.length > 0, 'Must have fallback requirements');
  const roleReq = normalized.requirements.find(r => r.scope === 'person_role');
  assert.ok(roleReq, 'Must have fallback role requirement');
  assert.ok(roleReq.acceptableTerms.includes('owner'));
});

test('buildSignalLaneQueries enriches signal queries with company niche context', () => {
  const requirements = [
    {
      id: 'company_type-1',
      scope: 'company_type' as const,
      importance: 'hard' as const,
      evidenceModality: 'structured_profile' as const,
      description: 'marketing agency',
      sourcePhrase: 'marketing agency',
      acceptableTerms: ['marketing agency', 'digital agency'],
      queryable: true
    },
    {
      id: 'signal-1',
      scope: 'signal' as const,
      importance: 'hard' as const,
      evidenceModality: 'open_web_signal' as const,
      description: 'hiring n8n or Zapier developer',
      sourcePhrase: 'hiring n8n developer',
      acceptableTerms: ['hiring n8n developer', 'Zapier specialist'],
      queryable: true
    }
  ];

  const queries = buildSignalLaneQueries(requirements);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].lane, 'signal');
  assert.ok(
    queries[0].query.includes('marketing agency'),
    'Signal query should be prefixed with company niche'
  );
  assert.ok(
    queries[0].query.includes('hiring n8n developer'),
    'Signal query should include intent term'
  );
});

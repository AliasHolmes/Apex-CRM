import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuerySignature,
  isNearDuplicateQuery,
} from '../server/leadSearch/querySignature.js';
import {
  buildAtsLaneQueries,
  expandAcceptableTerms,
  buildDeterministicProspectContract,
} from '../server/leadSearch/prospectContract.js';
import {
  isPersonalIdentityLead,
  isCompanyProfileLead,
} from '../server/leadSearch/stages/extractStage.js';
import { MiningTelemetryRecorder } from '../server/leadSearch/telemetry.js';
import {
  sanitizeDomainGuess,
  firstDomain,
  runGatedCompanyAttribution,
} from '../server/leadSearch/companyAttribution.js';
import type { FinalistCandidate } from '../server/leadSearch/finalistJudge.js';
import { canonicalLinkedInIdentity } from '../src/utils/leadDedupe.js';
import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.js';
import {
  determineSelectionShortfall,
  shouldRunIntentEnrichment,
} from '../server/leadSearch/stages/selectStage.js';
import { extractPromotedLeadColumns } from '../server/db.js';

// Fix 1: Query Signature Colon Stripping & STOPWORDS
test('Fix 1: buildQuerySignature strips colons, excludes sitelinkedincom, and prevents near-duplicate drops', () => {
  const query = 'site:linkedin.com/in/ "founder" "AI consultancy" "New Zealand"';
  const sig = buildQuerySignature(query);

  assert.equal(sig.roleClass, 'founder');
  assert.equal(sig.orgClass, 'container_org');
  assert.equal(sig.geoAnchor, 'new zealand');
  assert.deepEqual(sig.topicTokens, ['ai']);

  // Verify that site and domain tokens are completely absent from topicTokens
  assert.ok(!sig.topicTokens.includes('sitelinkedincom'));
  assert.ok(!sig.topicTokens.includes('linkedincom'));
  assert.ok(!sig.topicTokens.includes('site'));
  assert.ok(!sig.topicTokens.includes('linkedin'));
  assert.ok(!sig.topicTokens.includes('com'));

  // Distinct topics under same role and geo anchor must NOT be flagged as near duplicates
  const sigAI = buildQuerySignature('site:linkedin.com/in/ "founder" "AI agency" Auckland');
  const sigRobotics = buildQuerySignature('site:linkedin.com/in/ "founder" "Robotics agency" Auckland');
  assert.equal(isNearDuplicateQuery(sigRobotics, [sigAI]), false);
});

// Fix 2: ATS Query Role Pollution
test('Fix 2: buildAtsLaneQueries filters out executive ownership roles including managing director and targets technical hiring roles', () => {
  const requirements = [
    {
      id: 'req-1',
      description: 'Owner or founder',
      scope: 'person_role' as const,
      importance: 'hard' as const,
      acceptableTerms: ['owner', 'founder', 'CEO', 'managing director'],
    },
    {
      id: 'req-2',
      description: 'AI Agency',
      scope: 'company_type' as const,
      importance: 'hard' as const,
      acceptableTerms: ['AI agency'],
    },
  ];

  const queries = buildAtsLaneQueries('Find AI agencies', requirements as any, {
    roles: ['owner', 'founder', 'CEO', 'managing director'],
    companyTypes: ['established AI agencies'],
  } as any);

  assert.equal(queries.length, 1);
  const q = queries[0].query;

  // Must NOT include executive ownership titles in job board queries
  assert.ok(!q.includes('"owner"'), 'Must not inject "owner" into ATS query');
  assert.ok(!q.includes('"founder"'), 'Must not inject "founder" into ATS query');
  assert.ok(!q.includes('"CEO"'), 'Must not inject "CEO" into ATS query');
  assert.ok(!q.includes('"managing director"'), 'Must not inject "managing director" into ATS query');

  // Must target technical hiring roles appropriate for ATS boards
  assert.ok(q.includes('"Software Engineer"') || q.includes('"Engineer"'));
  assert.ok(q.includes('boards.greenhouse.io'));

  // Fallback test when only executive titles provided
  const fallbackQueries = buildAtsLaneQueries('Agency brief', requirements as any, {
    roles: ['managing director'],
    companyTypes: ['AI agency'],
  } as any);
  assert.ok(!fallbackQueries[0].query.includes('"managing director"'));
  assert.ok(fallbackQueries[0].query.includes('"Software Engineer"'));
});

// Fix 3: AI Agency Base Noun Omission & Truncation Resistance
test('Fix 3: expandAcceptableTerms preserves base nouns (agency, consultancy, studio, firm) for AI briefs without truncation', () => {
  const expanded = expandAcceptableTerms('company_type', ['AI agency', 'AI consultancy'], { agencyBrief: true });

  assert.ok(expanded.includes('agency'), 'Must include "agency"');
  assert.ok(expanded.includes('consultancy'), 'Must include "consultancy"');
  assert.ok(expanded.includes('studio'), 'Must include "studio"');
  assert.ok(expanded.includes('firm'), 'Must include "firm"');
  assert.ok(expanded.includes('AI agency'), 'Must include "AI agency"');
  assert.ok(expanded.includes('AI consultancy'), 'Must include "AI consultancy"');

  // Verify truncation resistance on unlisted/challenger permutations
  const challengerExpanded = expandAcceptableTerms('company_type', ['artificial intelligence consultancy'], { agencyBrief: true });
  assert.ok(challengerExpanded.includes('agency'), 'Must include "agency" for AI consultancy input');
  assert.ok(challengerExpanded.includes('consultancy'), 'Must preserve "consultancy" even when expanded count is high');
  assert.ok(challengerExpanded.includes('consulting firm'), 'Must preserve "consulting firm"');
  assert.ok(challengerExpanded.includes('advisory firm'), 'Must preserve "advisory firm"');
  assert.ok(challengerExpanded.length >= 25, 'Expanded terms must not be prematurely capped at 25');
});

// Fix 4: Authentic Company Profile vs Sole Proprietor Handle Classification
test('Fix 4: isCompanyProfileLead correctly classifies solo proprietors and company pages via production helpers', () => {
  // Scenario A: Solo proprietor whose handle matches their name (URL must be PRESERVED)
  const leadSolo = {
    fullName: 'Dan Miller',
    currentCompany: 'Dan Miller Consulting',
    headline: 'Founder & Consultant | Dan Miller Consulting',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/dan-miller' },
  };
  assert.equal(isPersonalIdentityLead(leadSolo, 'danmiller', 'danmiller'), true);
  assert.equal(isCompanyProfileLead(leadSolo, 'dan-miller', 'danmiller'), false, 'Solo proprietor profile must not be flagged as company handle');

  // Scenario B: True company organization profile (URL must be FLAGGED and CLEARED)
  const leadOrg = {
    fullName: 'Acme Corp',
    currentCompany: 'Acme Corp',
    headline: 'Official LinkedIn Page for Acme Corp',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/acme-corp' },
  };
  assert.equal(isPersonalIdentityLead(leadOrg, 'acmecorp', 'acmecorp'), false);
  assert.equal(isCompanyProfileLead(leadOrg, 'acme-corp', 'acmecorp'), true, 'True company organization page must be flagged as company handle');

  // Scenario C: Company handle attached to non-founder employee (Handle must be FLAGGED and CLEARED)
  const leadEmployee = {
    fullName: 'John Doe',
    currentCompany: 'Acme Corp',
    headline: 'Software Engineer',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/acme-corp' },
  };
  assert.equal(isPersonalIdentityLead(leadEmployee, 'acmecorp', 'acmecorp'), false);
  assert.equal(isCompanyProfileLead(leadEmployee, 'acme-corp', 'acmecorp'), true, 'Company handle on employee must be flagged as company handle');
});

// Fix 5: Telemetry String-Spread Serialization
test('Fix 5: MiningTelemetryRecorder serializes string error without spreading into character indices', () => {
  const tracker = new MiningTelemetryRecorder('session-yield-test', 'test query', 10);

  tracker.record({
    phase: 'strategy',
    operation: 'compile_contract',
    status: 'error',
    error: 'OmniRoute request timeout after 45s',
  });

  const events = tracker.getEvents();
  assert.equal(events.length, 1);
  const event = events[0];

  assert.ok(event.error);
  assert.equal(event.error.message, 'OmniRoute request timeout after 45s');

  const keys = Object.keys(event.error);
  assert.ok(!keys.includes('0'), 'Must not contain character index "0"');
  assert.ok(!keys.includes('1'), 'Must not contain character index "1"');
});

// Fix 6: Synthetic Domain Trailing Hyphens
test('Fix 6: sanitizeDomainGuess strips trailing and leading hyphens from cleaned domain labels', () => {
  assert.equal(sanitizeDomainGuess('Digi-Solutions'), 'digi.com');
  assert.equal(sanitizeDomainGuess('Digital Marketing Org - '), 'digitalmarketingorg.com');
  assert.equal(sanitizeDomainGuess('-Apex-Solutions-'), 'apex.com');
  assert.equal(sanitizeDomainGuess('Cloud-Nine---'), 'cloud-nine.com');
  assert.equal(sanitizeDomainGuess('---'), '');
  assert.equal(sanitizeDomainGuess('AI'), 'ai.com');
});

// Fix 7: Attribution Key Matching & Citation Contradiction Verification
test('Fix 7: firstDomain and runGatedCompanyAttribution validate hostnames and prevent false contradiction drops', async () => {
  // 1. Direct unit verification of firstDomain
  assert.equal(firstDomain('ai'), '', 'Naked word "ai" must not be treated as a domain');
  assert.equal(firstDomain('consultancy'), '', 'Naked word "consultancy" must not be treated as a domain');
  assert.equal(firstDomain('openai.com'), 'openai.com');
  assert.equal(firstDomain('www.flowagency.com'), 'flowagency.com');

  // 2. End-to-end execution of runGatedCompanyAttribution verifying citation downgrading
  const contract = buildDeterministicProspectContract('AI client service agencies in North America', {});
  const sourceSnippet = '[COMPANY SITE: acmesoftware.com] Acme Software is a custom systems development consultancy and engineering partner.';

  const cand: FinalistCandidate = {
    candidateId: 'cand-attr-test',
    lead: {
      id: 'lead-attr-test',
      fullName: 'Alice Smith',
      currentTitle: 'Founder & CEO',
      currentCompany: 'Acme Software',
      contactDetails: { website: 'https://acmesoftware.com' },
    },
    evidence: [{ id: 'e1', text: sourceSnippet }],
  };

  // Fabricated quote must downgrade verdict to unverified and NOT auto-fail lead
  const mockLLMFabricated = async () => ({
    attributions: [
      {
        companyKey: 'acmesoftware.com',
        businessModel: 'other_services',
        primaryOffering: 'Pure SaaS platform.',
        queryAlignment: 'contradicts',
        verbatimEvidenceQuote: 'We do not offer any consulting services whatsoever and are pure SaaS',
        verdict: 'disqualifying_contradiction',
        reason: 'Claims to be pure SaaS.',
      },
    ],
  });

  const summaryFabricated = await runGatedCompanyAttribution([cand], contract, {
    openAIStructured: mockLLMFabricated,
  });

  assert.equal(summaryFabricated.contradictionCount, 0, 'Fabricated quote must prevent contradiction count increment');
  assert.equal(cand.lead.companyAttribution?.verdict, 'unverified', 'Verdict must downgrade to unverified');
  assert.ok(!cand.lead._autoFailed, 'Lead must not be auto-failed on fabricated quote');

  // Verbatim quote must retain contradiction and auto-fail lead
  const mockLLMVerbatim = async () => ({
    attributions: [
      {
        companyKey: 'acmesoftware.com',
        businessModel: 'other_services',
        primaryOffering: 'Custom systems development consultancy.',
        queryAlignment: 'contradicts',
        verbatimEvidenceQuote: 'Acme Software is a custom systems development consultancy',
        verdict: 'disqualifying_contradiction',
        reason: 'Confirmed contradiction.',
      },
    ],
  });

  // Reset lead attribution state
  delete (cand.lead as any).companyAttribution;
  delete (cand.lead as any)._autoFailed;
  const summaryVerbatim = await runGatedCompanyAttribution([cand], contract, {
    openAIStructured: mockLLMVerbatim,
  });

  assert.equal(summaryVerbatim.contradictionCount, 1, 'Verbatim quote must register contradiction');
  assert.equal(cand.lead._autoFailed, true, 'Lead must be auto-failed on genuine verified contradiction');
});

// Fix 8: Fusion Deduplication via executeFuseStage
test('Fix 8: executeFuseStage deduplicates against existing CRM leads using canonical LinkedIn identity', async () => {
  assert.equal(canonicalLinkedInIdentity('sarah-connor'), '', 'Bare handle returns empty from canonical helper');
  assert.equal(canonicalLinkedInIdentity('https://www.linkedin.com/in/sarah-connor'), 'linkedin:sarah-connor');

  const ctx: any = {
    config: { promptQuery: 'test query' },
    state: {
      seenCandidateKeys: new Set(),
      existingKeys: new Set(['linkedin:sarah-connor']),
      acceptedLeads: [],
    },
    logEvent: () => {},
  };

  const input: any = {
    round: 1,
    roundItems: [
      {
        item: {
          url: 'https://www.linkedin.com/in/sarah-connor',
          title: 'Sarah Connor - CEO',
          content: 'Profile details',
        },
        resultIndex: 0,
      },
      {
        item: {
          url: 'https://www.linkedin.com/in/novel-lead-99',
          title: 'Novel Lead - Founder',
          content: 'Profile details',
        },
        resultIndex: 1,
      },
    ],
    roundPlans: [
      { executableQuery: 'test', item: { family: 'search', lane: 'default' } },
      { executableQuery: 'test2', item: { family: 'search', lane: 'default' } },
    ],
    queryRuns: [
      { query: 'test', rawCandidates: 0, rejectionReasons: {} },
      { query: 'test2', rawCandidates: 0, rejectionReasons: {} },
    ],
    searchSpec: {},
    stats: { rejectionReasons: {}, existingCrmLeadsSkipped: 0 },
  };

  const output = await executeFuseStage(ctx, input);
  assert.equal(input.stats.existingCrmLeadsSkipped, 1, 'Duplicate CRM lead must be skipped by fuseStage');
  assert.equal(output.candidateItems.length, 1, 'Only novel candidate must proceed through fuseStage');
  assert.ok(output.candidateItems[0].url.includes('novel-lead-99'));
});

// Fix 9: Shortfall Intent Enrichment Gating
test('Fix 9: determineSelectionShortfall and shouldRunIntentEnrichment prevent intent starvation', () => {
  assert.equal(determineSelectionShortfall(3, 10), true, 'Fewer leads than target must indicate shortfall');
  assert.equal(determineSelectionShortfall(10, 10), false, 'Target met must not indicate shortfall');
  assert.equal(determineSelectionShortfall(15, 10), false, 'Surplus leads must not indicate shortfall');

  // When shortfall occurs, intent enrichment must still execute if qualified leads exist
  assert.equal(shouldRunIntentEnrichment(true, 3), true, 'Intent enrichment must run on qualified leads during shortfall');
  assert.equal(shouldRunIntentEnrichment(true, 0), false, 'Zero leads safely skips enrichment');
  assert.equal(shouldRunIntentEnrichment(false, 10), true, 'Normal session runs enrichment');
  assert.equal(shouldRunIntentEnrichment(true, 0, true), true, 'Force flag overrides zero leads');

  // Also verify with explicit boolean forceShortfallEnrichment as second argument
  assert.equal(shouldRunIntentEnrichment(true, false, 5), true);
  assert.equal(shouldRunIntentEnrichment(true, false, 0), false);
  assert.equal(shouldRunIntentEnrichment(true, true, 0), true);
});

// Fix 10: Database Column Population Hygiene
test('Fix 10: extractPromotedLeadColumns falls back to profile.company, companyName, and headline', () => {
  const storedLeadCompany = {
    id: 'lead-test-1',
    currentCompany: null,
    company: null,
    profile: {
      company: 'Acme AI Studio',
      title: 'Head of AI',
    },
  };
  const colsCompany = extractPromotedLeadColumns(storedLeadCompany);
  assert.equal(colsCompany.company, 'Acme AI Studio');
  assert.equal(colsCompany.title, 'Head of AI');

  const storedLeadName = {
    id: 'lead-test-2',
    currentCompany: null,
    company: null,
    profile: {
      companyName: 'Horizon Agency',
      headline: 'Founder & Principal Consultant',
    },
  };
  const colsName = extractPromotedLeadColumns(storedLeadName);
  assert.equal(colsName.company, 'Horizon Agency');
  assert.equal(colsName.title, 'Founder & Principal Consultant');

  const storedFallback = {
    id: 'lead-test-3',
    company: 'Stored Root Inc',
    profile: {
      company: '   ',
    },
  };
  const colsFallback = extractPromotedLeadColumns(storedFallback);
  assert.equal(colsFallback.company, 'Stored Root Inc');
});

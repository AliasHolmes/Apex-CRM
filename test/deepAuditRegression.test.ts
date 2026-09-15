import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyIntentEnrichmentDelta,
  applyPostIntentDelta,
  computeMMRDiversitySelection,
  normalizeToTenScale,
  rankLeadForFinalSelection,
} from '../server/leadSearch/scoring.js';
import { mapCandidateToPersistedLead } from '../server/leadSearch/leadMapping.js';
import { isPrivateOrInternalHost } from '../server/services/privateHosts.js';
import {
  hasStrictStructuredMatch,
  structuredFieldsForRequirement,
} from '../server/leadSearch/evidenceSelection.js';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.js';
import {
  classifyAblationTier,
  ablateQueryTask,
  ABLATION_TIERS,
} from '../server/leadSearch/constraintAblation.js';
import { companiesMatch } from '../server/leadSearch/signalStore.js';
import type { ProspectContract, ProspectRequirement } from '../server/leadSearch/prospectContract.js';

/**
 * Regression suite for the deep-audit fixes of 2026-09-15.
 *
 * The through-line of the highest-severity bug was a scale-sniffing idiom
 * (`x <= 1.0 ? x * 10 : x`) that misread a legitimate 1-10 score of `1` as a
 * 0-1 probability. `1` is the WORST score a candidate can receive, so the
 * worst candidate was being promoted to the top of the scale. These tests pin
 * the boundary in every place that idiom appeared.
 */

const buildLead = (finalScore: number) => ({
  fullName: `Candidate ${finalScore}`,
  currentTitle: 'Founder',
  currentCompany: 'Acme',
  qualification: { finalScore },
  evidence: { evidenceQuality: 'good', snippets: ['evidence'] },
});

describe('Deep audit regression: score-scale boundary at 1.0', () => {
  it('normalizeToTenScale treats only the open interval (0,1) as a probability', () => {
    assert.equal(normalizeToTenScale(0.5), 5, '0.5 is a probability -> 5');
    assert.equal(normalizeToTenScale(0.1), 1, '0.1 is a probability -> 1');
    assert.equal(normalizeToTenScale(1), 1, '1 is a 1-10 score, NOT a probability');
    assert.equal(normalizeToTenScale(1.2), 1.2, '1.2 stays on the 1-10 scale');
    assert.equal(normalizeToTenScale(9), 9, '9 stays on the 1-10 scale');
    assert.equal(normalizeToTenScale(10), 10, '10 stays on the 1-10 scale');
    assert.equal(normalizeToTenScale(75), 7.5, '75 is a 0-100 score -> 7.5');
    assert.equal(normalizeToTenScale(0), 0, '0 passes through untouched');
    assert.equal(normalizeToTenScale(undefined, 5), 5, 'non-numeric falls back');
  });

  it('rankLeadForFinalSelection is monotonic and never rewards the worst score', () => {
    const ranks = [1, 1.2, 2, 3, 5, 8, 10].map((score) => ({
      score,
      rank: rankLeadForFinalSelection(buildLead(score)),
    }));

    for (let i = 1; i < ranks.length; i++) {
      assert.ok(
        ranks[i].rank >= ranks[i - 1].rank,
        `rank must not decrease: score ${ranks[i - 1].score} -> ${ranks[i - 1].rank}, ` +
          `score ${ranks[i].score} -> ${ranks[i].rank}`,
      );
    }

    // The specific inversion that was observed: a score of 1 used to outrank 2..5.
    const worst = rankLeadForFinalSelection(buildLead(1));
    for (const score of [2, 3, 5, 8, 10]) {
      assert.ok(
        rankLeadForFinalSelection(buildLead(score)) > worst,
        `score ${score} must outrank score 1`,
      );
    }
  });

  it('selects the highest-scoring candidate first instead of the worst', () => {
    const pool = [
      { id: 'best-a', fullName: 'A', currentCompany: 'A Co', location: 'NY', finalSelectionScore: 9 },
      { id: 'best-b', fullName: 'B', currentCompany: 'A Co', location: 'NY', finalSelectionScore: 9 },
      { id: 'best-c', fullName: 'C', currentCompany: 'A Co', location: 'NY', finalSelectionScore: 9 },
      { id: 'worst', fullName: 'D', currentCompany: 'B Co', location: 'NY', finalSelectionScore: 1 },
    ];

    const selected = computeMMRDiversitySelection(pool, 2, 0.75);
    assert.equal(selected.length, 2);
    assert.notEqual(
      selected[0].id,
      'worst',
      'the weakest candidate must never be selected first',
    );
  });

  it('persists a bottom-ranked lead as a bottom-ranked CRM score', () => {
    const persisted = mapCandidateToPersistedLead({
      finalSelectionScore: 1,
      scoreBreakdown: { finalScore: 1 },
    });
    assert.equal(persisted.compositeScore, 10, 'score 1 -> compositeScore 10, not 100');
    assert.equal(persisted.predictiveScore, 9, 'score 1 -> predictiveScore 9, not 90');

    // Ordering must survive the mapping.
    const better = mapCandidateToPersistedLead({ finalSelectionScore: 9 });
    assert.ok(
      better.compositeScore > persisted.compositeScore,
      'a score of 9 must persist higher than a score of 1',
    );
  });

  it('post-intent and company-intent deltas do not jump a score of 1 to 10', () => {
    const intentLead: any = {
      qualification: { finalScore: 1 },
      postIntentEvidence: {
        quality: 'strong',
        confidenceScore: 1,
        postSnippets: ['3 hours ago'],
      },
    };

    const postIntent = applyPostIntentDelta(intentLead);
    assert.ok(postIntent < 5, `post-intent delta must stay near the base, got ${postIntent}`);

    const companyIntent = applyIntentEnrichmentDelta({ qualification: { finalScore: 1 } });
    assert.equal(companyIntent, 1, 'no intent evidence -> base score returned unchanged');
  });

  it('still normalises genuine 0-1 and 0-100 inputs', () => {
    // Guards against over-correcting the boundary.
    assert.equal(applyIntentEnrichmentDelta({ finalSelectionScore: 0.5 }), 5);
    assert.equal(applyIntentEnrichmentDelta({ finalSelectionScore: 75 }), 7.5);
    assert.equal(applyPostIntentDelta({ finalSelectionScore: 0.8 }), 8);
  });
});

describe('Deep audit regression: SSRF host guard', () => {
  it('blocks non-canonical numeric IPv4 literals that resolvers accept', () => {
    // Every one of these resolves to loopback and previously returned false.
    assert.equal(isPrivateOrInternalHost('2130706433'), true, 'bare decimal 127.0.0.1');
    assert.equal(isPrivateOrInternalHost('0x7f000001'), true, 'hex 127.0.0.1');
    assert.equal(isPrivateOrInternalHost('0177.0.0.1'), true, 'octal 127.0.0.1');
    assert.equal(isPrivateOrInternalHost('127.1'), true, 'shortened dotted form');
  });

  it('blocks fully-qualified names with a trailing root dot', () => {
    assert.equal(isPrivateOrInternalHost('localhost.'), true);
    assert.equal(isPrivateOrInternalHost('127.0.0.1.'), true);
    assert.equal(isPrivateOrInternalHost('db.local.'), true);
  });

  it('blocks multicast and reserved ranges', () => {
    assert.equal(isPrivateOrInternalHost('224.0.0.1'), true, 'multicast');
    assert.equal(isPrivateOrInternalHost('239.255.255.255'), true, 'multicast upper bound');
    assert.equal(isPrivateOrInternalHost('240.0.0.1'), true, 'reserved');
    assert.equal(isPrivateOrInternalHost('192.0.0.1'), true, 'IETF protocol assignments');
  });

  it('still allows ordinary public company domains', () => {
    assert.equal(isPrivateOrInternalHost('stripe.com'), false);
    assert.equal(isPrivateOrInternalHost('apexlead.io'), false);
    assert.equal(isPrivateOrInternalHost('subdomain.company.co.uk'), false);
    assert.equal(isPrivateOrInternalHost('123.com'), false, 'numeric label is not an IP');
    assert.equal(isPrivateOrInternalHost('service.internal.example.com'), false);
  });
});

describe('Deep audit regression: strict location gate', () => {
  const locationRequirement: ProspectRequirement = {
    id: 'req-loc',
    description: 'Based in New York',
    sourcePhrase: 'New York',
    acceptableTerms: ['New York', 'NY', 'NYC'],
    scope: 'person_location',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  it('keeps the query fallback available for diagnostics', () => {
    const lead = { fullName: 'Jane', location: '', _sourceQuery: 'AI agency founder New York' };
    const fields = structuredFieldsForRequirement(lead, locationRequirement);
    assert.ok(
      fields.includes('AI agency founder New York'),
      'diagnostic field list must still surface the query fallback',
    );
  });

  it('never auto-passes a location hard requirement from the search query', () => {
    const lead = { fullName: 'Jane', currentTitle: 'Founder', location: '', _sourceQuery: 'AI agency founder New York' };
    assert.equal(
      hasStrictStructuredMatch(lead, locationRequirement),
      false,
      'the search query is not evidence about the candidate',
    );
  });

  it('auto-passes when the profile actually states a matching location', () => {
    assert.equal(
      hasStrictStructuredMatch({ fullName: 'Jane', location: 'New York, NY' }, locationRequirement),
      true,
    );
    assert.equal(
      hasStrictStructuredMatch({ fullName: 'Jane', profile: { location: 'NYC' } }, locationRequirement),
      true,
    );
  });

  it('does not auto-pass a non-matching stated location', () => {
    assert.equal(
      hasStrictStructuredMatch({ fullName: 'Jane', location: 'London, UK' }, locationRequirement),
      false,
    );
  });
});

describe('Deep audit regression: round budget honours configuration', () => {
  it('uses the configured LEAD_SEARCH_MAX_ROUNDS ceiling verbatim', () => {
    // The engine's in-loop extension may no longer grow past this value.
    assert.equal(buildCollectionCapacity({ targetLimit: 30, maxRoundsCap: 6 }).maxRounds, 6);
    assert.equal(buildCollectionCapacity({ targetLimit: 30, maxRoundsCap: 3 }).maxRounds, 3);
  });

  it('falls back to the complexity-derived cap when unconfigured', () => {
    assert.equal(buildCollectionCapacity({ targetLimit: 30 }).maxRounds, 3);
    assert.equal(buildCollectionCapacity({ targetLimit: 50 }).maxRounds, 3);
    assert.equal(buildCollectionCapacity({ targetLimit: 200 }).maxRounds, 6);
  });
});

describe('Deep audit regression: ablation never strips the identity anchor', () => {
  const requirement = (
    id: string,
    scope: ProspectRequirement['scope'],
    description: string,
    acceptableTerms: string[],
  ): ProspectRequirement =>
    ({
      id,
      description,
      sourcePhrase: acceptableTerms[0],
      acceptableTerms,
      scope,
      importance: 'hard',
      evidenceModality: 'structured_profile',
      requirementClass: scope === 'person_role' ? 'identity_hard' : 'context_hard',
      queryHardness: 'required_in_every_query',
      queryable: true,
    }) as ProspectRequirement;

  it('keeps role requirements Tier 1 even when the title contains a volatile keyword', () => {
    // The volatile-context scan is text-based, so these titles matched 'cloud' /
    // 'hiring' / 'salesforce' and were downgraded to ablatable Tier 4.
    for (const title of ['Cloud Architect', 'Head of Hiring', 'Salesforce Administrator', 'VP of Sales']) {
      assert.equal(
        classifyAblationTier(requirement('r', 'person_role', title, [title.toLowerCase()])),
        ABLATION_TIERS.TIER_1_IMMUTABLE_CORE,
        `"${title}" must be Tier 1 (never ablatable)`,
      );
    }
  });

  it('never removes the role term from a query', () => {
    const contract = {
      version: 1,
      policyVersion: 'p',
      brief: 'cloud architects in London',
      authorityRequired: true,
      exclusions: [],
      identitySpec: { roles: ['cloud architect'], locations: ['London'], companyTypes: [], industries: [] },
      requirements: [
        requirement('req-role', 'person_role', 'Cloud Architect', ['cloud architect']),
        requirement('req-loc', 'person_location', 'London', ['london']),
      ],
      initialQueries: [],
    } as unknown as ProspectContract;

    const result = ablateQueryTask('"cloud architect" London', contract);
    if (result) {
      assert.notEqual(
        result.ablatedRequirementId,
        'req-role',
        'ablation must never target the role requirement',
      );
      assert.ok(
        result.ablatedQuery.toLowerCase().includes('cloud architect'),
        `the identity anchor must survive ablation, got "${result.ablatedQuery}"`,
      );
    }
  });

  it('still ablates a volatile description even when the scope is firmographic', () => {
    // Regression guard for the ordering rule: a tooling constraint compiled as
    // company_type ("Snowflake stack") must stay ablatable.
    assert.equal(
      classifyAblationTier(requirement('r', 'company_type', 'Snowflake stack', ['Snowflake', 'Snowflake Data Cloud'])),
      ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT,
    );
    assert.equal(
      classifyAblationTier(requirement('r', 'signal', 'Uses Snowflake', ['snowflake'])),
      ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT,
    );
  });

  it('keeps the non-volatile firmographic and context tiers unchanged', () => {
    assert.equal(
      classifyAblationTier(requirement('r', 'company_industry', 'B2B SaaS', ['B2B SaaS', 'SaaS'])),
      ABLATION_TIERS.TIER_1_IMMUTABLE_CORE,
    );
    assert.equal(
      classifyAblationTier(requirement('r', 'person_location', 'San Francisco', ['san francisco'])),
      ABLATION_TIERS.TIER_2_LOCATION_ANCHOR,
    );
    assert.equal(
      classifyAblationTier(requirement('r', 'company_size', '10 to 50 employees', ['10 to 50 employees'])),
      ABLATION_TIERS.TIER_3_DOMAIN_QUALIFIER,
    );
  });
});

describe('Deep audit regression: company identity matching (documented tolerance)', () => {
  it('separates companies that differ by a conflicting service-model qualifier', () => {
    // INDUSTRY_QUALIFIERS exists to stop two genuinely different firms from being merged
    // when they share a distinctive token. A false match here would attach another
    // company's open-web signals to a candidate's evidence packet.
    assert.equal(companiesMatch('Apex Solutions', 'Apex Growth'), false);
    assert.equal(companiesMatch('Bright Digital', 'Bright Media'), false);
    assert.equal(companiesMatch('North Star Labs', 'North Star Systems'), false);
    assert.equal(companiesMatch('Apex Consulting', 'Apex Partners'), false);
  });

  it('deliberately tolerates industry/tld suffixes that are not service-model qualifiers', () => {
    // 'ai', 'tech', 'io' and 'studio' are intentionally NOT conflicting qualifiers: the
    // same firm is referred to as "TechFlow AI", "TechFlow Studio" and "techflow.io" across
    // SERPs, so treating them as distinct would fragment one company into several.
    // This is a deliberate precision/recall trade-off, pinned here so it is not
    // "fixed" into a regression. See test/signalStore.test.ts and test/twoFunnelEngine.test.ts.
    assert.equal(companiesMatch('TechFlow AI', 'TechFlow Studio'), true);
    assert.equal(companiesMatch('Apex AI', 'Apex Tech'), true);
    assert.equal(companiesMatch('n8n io', 'n8n workflow automation'), true);
  });

  it('still matches the same company written with extra legal or descriptive suffixes', () => {
    assert.equal(companiesMatch('Apex AI', 'Apex AI Consulting'), true);
    assert.equal(companiesMatch('Apex AI', 'Apex AI Agency'), true);
    assert.equal(companiesMatch('Stripe', 'Stripe Inc'), true);
    assert.equal(companiesMatch('Acme Corp', 'ACME Corporation'), true);
    assert.equal(companiesMatch('TechFlow AI', 'TechFlow AI LLC'), true);
    assert.equal(companiesMatch('Acme S.R.L.', 'Acme'), true);
    assert.equal(companiesMatch('n8n', 'n8n'), true);
  });
});

describe('Deep audit regression: recovery guidance reports only non-matching attributes', () => {
  const contract = {
    version: 1,
    brief: 'Agency founders in London',
    requirements: [
      {
        id: 'req_role',
        description: 'Founder, owner or CEO',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        sourcePhrase: 'founder',
        queryable: true,
        acceptableTerms: ['founder', 'owner', 'ceo'],
      },
      {
        id: 'req_loc',
        description: 'Located in London',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        sourcePhrase: 'London',
        queryable: true,
        acceptableTerms: ['london', 'uk'],
      },
    ],
    exclusions: [],
  } as unknown as ProspectContract;

  it('reports contract-violating attributes and omits contract-satisfying ones', () => {
    const diag = buildRoundDiagnostics({
      round: 1,
      rawCandidates: 20,
      extractedCandidates: 3,
      leads: [
        { fullName: 'Alice', currentTitle: 'VP Marketing', location: 'New York, USA' },
        { fullName: 'Bob', currentTitle: 'Senior Recruiter', location: 'San Francisco, CA' },
        { fullName: 'Charlie', currentTitle: 'Owner', location: 'Manchester, UK' },
      ],
      contract,
      targetLimit: 10,
    });

    const locations = diag.observedNonMatchingAttributes?.locations || [];
    const roles = diag.observedNonMatchingAttributes?.roles || [];

    assert.deepEqual(locations.sort(), ['New York, USA', 'San Francisco, CA']);
    assert.deepEqual(roles.sort(), ['Senior Recruiter', 'VP Marketing']);

    // The whole point: the strategist must not be told to steer away from these.
    assert.ok(!locations.includes('Manchester, UK'), 'London/UK location is satisfying, not non-matching');
    assert.ok(!roles.includes('Owner'), 'Owner satisfies the founder/owner/CEO requirement');
  });

  it('does not report an attribute as non-matching when the contract has no requirement of that scope', () => {
    const roleOnlyContract = {
      version: 1,
      brief: 'Founders anywhere',
      requirements: [
        {
          id: 'req_role',
          description: 'Founder',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          sourcePhrase: 'founder',
          queryable: true,
          acceptableTerms: ['founder'],
        },
      ],
      exclusions: [],
    } as unknown as ProspectContract;

    const diag = buildRoundDiagnostics({
      round: 1,
      rawCandidates: 1,
      extractedCandidates: 1,
      leads: [{ fullName: 'Alice', currentTitle: 'Founder', location: 'Berlin' }],
      contract: roleOnlyContract,
      targetLimit: 5,
    });

    // The contract says nothing about location, so a location cannot be "non-matching" -
    // reporting it would tell the strategist to steer away from a free variable.
    assert.deepEqual(diag.observedNonMatchingAttributes?.locations || [], []);
    // The role requirement is satisfied by 'Founder', so no role is non-matching either.
    assert.deepEqual(diag.observedNonMatchingAttributes?.roles || [], []);
  });
});

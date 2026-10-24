import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.js';
import { mapCandidateToPersistedLead } from '../server/leadSearch/leadMapping.js';
import { buildCheckpointEvidence } from '../server/leadSearch/sessionHelpers.js';
import { executePlanStage } from '../server/leadSearch/stages/planStage.js';
import { buildFallbackSearchSpec } from '../server/leadSearch/searchSpec.js';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';

describe('Package 3 Engine Remediations', () => {
  it('B11: continuous calibrated confidence scoring produces a smooth discriminative gradient', () => {
    // 1. Intern / Assistant (ignoredTitle) -> exactly 2
    const intern = verifyDecisionMakerFromEvidence({
      query: 'AI founders',
      currentTitle: 'Marketing Intern',
      currentCompany: 'Apex AI',
    });
    assert.equal(intern.ignoredTitle, true);
    assert.equal(intern.confidence, 2);

    // 2. Product Owner (role context but not positive authority) -> exactly 5
    const po = verifyDecisionMakerFromEvidence({
      query: 'business owners',
      currentTitle: 'Product Owner',
    });
    assert.equal(po.ignoredTitle, false);
    assert.equal(po.titleMatched, false);
    assert.equal(po.confidence, 5);

    // 3. Solo VP of Sales without company or evidence -> 7.3
    const vp = verifyDecisionMakerFromEvidence({
      query: 'find sales leadership',
      currentTitle: 'VP of Sales',
    });
    assert.equal(vp.titleMatched, true);
    assert.equal(vp.confidence, 7.3);

    // 4. Solo Founder & CEO without company or evidence -> 7.5
    const founderSolo = verifyDecisionMakerFromEvidence({
      query: 'find AI founders',
      currentTitle: 'Founder & CEO',
    });
    assert.equal(founderSolo.titleMatched, true);
    assert.equal(founderSolo.confidence, 7.5);

    // 5. Founder with corroborated company -> 8.5
    const founderWithCompany = verifyDecisionMakerFromEvidence({
      query: 'find AI founders',
      currentTitle: 'Founder & CEO',
      currentCompany: 'Apex AI Labs',
      evidenceText: 'Working at Apex AI Labs in New York',
    });
    assert.equal(founderWithCompany.companyMatched, true);
    assert.equal(founderWithCompany.confidence, 8.5);

    // 6. Founder with corroborated company and valid evidence link -> 9.3
    const founderWithLink = verifyDecisionMakerFromEvidence({
      query: 'find AI founders',
      currentTitle: 'Founder & CEO',
      currentCompany: 'Apex AI Labs',
      evidenceText: 'Working at Apex AI Labs. LINK: https://linkedin.com/in/founder-ceo',
    });
    assert.equal(founderWithLink.companyMatched, true);
    assert.equal(founderWithLink.confidence, 9.3);

    // 7. Serial executive founder with career trajectory -> 9.8
    const serialExecutiveExperiences = [
      {
        title: 'Founder & CEO',
        company: 'Apex AI Labs',
        isCurrent: true,
        durationMonths: 24,
      },
      {
        title: 'VP of Engineering',
        company: 'Previous Scale Tech',
        isCurrent: false,
        durationMonths: 48,
      },
    ];
    const serialFounder = verifyDecisionMakerFromEvidence({
      query: 'find AI founders',
      currentTitle: 'Founder & CEO',
      currentCompany: 'Apex AI Labs',
      evidenceText: 'Working at Apex AI Labs. LINK: https://linkedin.com/in/founder-ceo',
      experiences: serialExecutiveExperiences,
    });
    assert.equal(serialFounder.companyMatched, true);
    assert.equal(serialFounder.confidence, 9.8);

    // Verify monotonicity across the gradient
    assert.ok(intern.confidence < po.confidence);
    assert.ok(po.confidence < vp.confidence);
    assert.ok(vp.confidence < founderSolo.confidence);
    assert.ok(founderSolo.confidence < founderWithCompany.confidence);
    assert.ok(founderWithCompany.confidence < founderWithLink.confidence);
    assert.ok(founderWithLink.confidence < serialFounder.confidence);
  });

  it('B13: mapCandidateToPersistedLead stamps provenance as engine', () => {
    const candidate = {
      fullName: 'Alice Walker',
      currentTitle: 'Chief Executive Officer',
      currentCompany: 'Walker Cloud',
      tags: ['Verified Lead'],
    };
    const persisted = mapCandidateToPersistedLead(candidate, 'lead-123');
    assert.equal(persisted.provenance, 'engine');
    assert.equal(persisted.stage, 'SCRAPED');
    assert.equal(persisted.id, 'lead-123');
  });

  it('B17: buildCheckpointEvidence default cap is tightened to 100', () => {
    const evidenceMap = new Map<string, any>();
    const leads: any[] = [];
    for (let i = 0; i < 150; i++) {
      const url = `https://linkedin.com/in/user-${i}`;
      evidenceMap.set(url, { evidenceBlock: `Snippet ${i}`, sourceRound: 1 });
      leads.push({ contactDetails: { linkedinUrl: url } });
    }

    const checkpoint = buildCheckpointEvidence(evidenceMap, leads);
    const keys = Object.keys(checkpoint);
    assert.equal(keys.length, 100, 'Checkpoint evidence must be capped at 100 items by default');
  });

  it('B3: CRM saturation negative company terms are scoped strictly to person lane tasks', async () => {
    const mockCtx = {
      config: {
        sessionId: 'test-session-crm',
        promptQuery: 'AI agency founders in the USA',
        targetLimit: 10,
        contract: {
          brief: 'AI agency founders in the USA',
          identitySpec: {
            roles: ['founder', 'owner'],
            locations: ['United States'],
            companyTypes: ['agency']
          },
          requirements: []
        },
        capacity: buildCollectionCapacity({ targetLimit: 10 }),
      },
      state: {
        abortController: new AbortController(),
        debugLogs: [],
        round: 2,
        queryRuns: [
          {
            round: 1,
            rejectionReasons: {
              duplicate_existing_lead: 8,
              no_evidence: 2,
            },
          },
        ],
        seenCandidateKeys: new Set<string>(),
        signalStore: {
          getUniqueCompanyNames: () => ['FreshSignal Co'],
        },
        _planStageCache: {
          historicalPerformance: [],
          crmCompanies: ['Saturated Acme', 'Saturated Beta'],
          crmDomains: [],
          metroSaturation: {},
        },
      },
      logEvent: () => {},
      recordTrace: () => {},
    } as any;

    const planResult = await executePlanStage(mockCtx, {
      round: 2,
      remaining: 10,
      generatedQueries: [],
      seenQueryTexts: new Set<string>(),
      searchSpec: buildFallbackSearchSpec('AI agency founders in the USA'),
      discoveryProviderMode: 'hybrid',
      stats: { scout: {}, queryRuns: [] } as any,
    });

    assert.ok(planResult.roundPlans.length > 0, 'Must produce planned queries');

    const personPlans = planResult.roundPlans.filter((p) => p.item.lane === 'person');
    const accountPlans = planResult.roundPlans.filter((p) => p.item.lane === 'account');

    // Person lane tasks must contain negative CRM company terms
    assert.ok(personPlans.length > 0, 'Must have person lane plans');
    for (const plan of personPlans) {
      assert.ok(
        plan.executableQuery.includes('-"Saturated Acme"') &&
        plan.executableQuery.includes('-"Saturated Beta"'),
        `Person query must include negative CRM exclusions: ${plan.executableQuery}`,
      );
    }

    // If account flywheel tasks are injected, they must NEVER contain negative CRM exclusions
    for (const plan of accountPlans) {
      assert.equal(
        plan.executableQuery.includes('-"Saturated Acme"'),
        false,
        `Account query must NOT include negative CRM exclusions: ${plan.executableQuery}`,
      );
    }
  });
});

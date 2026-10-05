import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTitleFromQualification } from '../server/leadSearch/titleResolution.js';
import { mapCandidateToPersistedLead } from '../server/leadSearch/leadMapping.js';

test('resolveTitleFromQualification correctly resolves James McCombe fixture from Session 3', () => {
  const lead = {
    fullName: 'James McCombe',
    currentTitle: '',
    headline: 'I build AI automation that runs',
    currentCompany: 'Mitori.ai',
  };

  const qualification = {
    verdict: 'qualified',
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e_company_attr',
        evidenceQuote: 'Auckland-based founder delivering AI automation services to clients.',
      },
      {
        requirementId: 'r2',
        status: 'pass',
        evidenceId: 'e_company_attr',
        evidenceQuote: 'Business Model: b2b_services. Industry: AI automation services.',
      },
    ],
    reason: 'Strong fit as a New Zealand founder providing client-facing AI automation services.',
  };

  const evidence = [
    {
      id: 'e_company_attr',
      text: '[COMPANY ATTRIBUTION (verified_fit): mitori.ai] Business Model: b2b_services.',
    },
    {
      id: 'e0',
      text: '[PROFILE] James McCombe - Founder at Mitori.ai',
    },
  ];

  const result = resolveTitleFromQualification({
    lead,
    qualification: qualification as any,
    contract: null,
    evidence,
  });

  assert.ok(result);
  assert.strictEqual(result.title, 'founder');
  assert.strictEqual(result.source, 'inferred_from_qualification');
});

test('resolveTitleFromQualification picks longest matching span', () => {
  const lead1 = {
    fullName: 'Alice Smith',
    currentTitle: '',
  };
  const qual1 = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'Alice Smith is Co-Founder & CEO of NextGen Systems.',
      },
    ],
  };

  const res1 = resolveTitleFromQualification({
    lead: lead1,
    qualification: qual1 as any,
    evidence: [{ id: 'e0', text: '[PROFILE] Alice Smith profile' }],
  });
  assert.ok(res1);
  assert.strictEqual(res1.title, 'Co-Founder & CEO');

  const lead2 = {
    fullName: 'Bob Taylor',
    currentTitle: '',
  };
  const qual2 = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'Bob Taylor serves as Managing Director at Auckland Digital.',
      },
    ],
  };

  const res2 = resolveTitleFromQualification({
    lead: lead2,
    qualification: qual2 as any,
    evidence: [{ id: 'e0', text: '[PROFILE] Bob Taylor profile' }],
  });
  assert.ok(res2);
  assert.strictEqual(res2.title, 'Managing Director');
});

test('resolveTitleFromQualification rejects bare Director and Principal unless in contract', () => {
  const lead = { fullName: 'Charlie Davis', currentTitle: '' };
  const qualDirector = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'Charlie Davis is a Director in Wellington.',
      },
    ],
  };

  const noContractRes = resolveTitleFromQualification({
    lead,
    qualification: qualDirector as any,
    evidence: [{ id: 'e0', text: '[PROFILE] Charlie Davis' }],
  });
  assert.strictEqual(noContractRes, null);

  const contractWithDirector: any = {
    requirements: [
      {
        scope: 'person_role',
        acceptableTerms: ['director', 'managing director'],
      },
    ],
  };

  const withContractRes = resolveTitleFromQualification({
    lead,
    qualification: qualDirector as any,
    contract: contractWithDirector,
    evidence: [{ id: 'e0', text: '[PROFILE] Charlie Davis' }],
  });
  assert.ok(withContractRes);
  assert.strictEqual(withContractRes.title, 'Director');
});

test('resolveTitleFromQualification rejects quotes with negation or past role keywords', () => {
  const lead = { fullName: 'David Evans', currentTitle: '' };

  const testQuotes = [
    'David Evans is a former founder of BetaTech.',
    'David Evans, ex-CEO of Acme Corp.',
    'David Evans acts as advisor to the executive board.',
    'David Evans is a retired managing director.',
    'David Evans, previous owner of Alpha.',
  ];

  for (const quote of testQuotes) {
    const qual = {
      requirements: [
        {
          requirementId: 'person_role-1',
          status: 'pass',
          evidenceId: 'e0',
          evidenceQuote: quote,
        },
      ],
    };
    const res = resolveTitleFromQualification({
      lead,
      qualification: qual as any,
      evidence: [{ id: 'e0', text: '[PROFILE] David Evans' }],
    });
    assert.strictEqual(res, null, `Expected negation rejection for: "${quote}"`);
  }
});

test('resolveTitleFromQualification rejects team-page quote naming a different person', () => {
  const lead = { fullName: 'Edward Norton', currentTitle: '' };
  const qual = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e_web',
        evidenceQuote: 'Founded by Sarah Jenkins, delivering AI automation.',
      },
    ],
  };

  const res = resolveTitleFromQualification({
    lead,
    qualification: qual as any,
    evidence: [{ id: 'e_web', text: 'About Us page. Founded by Sarah Jenkins, delivering AI automation.' }],
  });
  assert.strictEqual(res, null);
});

test('resolveTitleFromQualification is a no-op when lead already has a valid title', () => {
  const lead = {
    fullName: 'Fiona Gallagher',
    currentTitle: 'Chief Executive Officer',
  };
  const qual = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'Fiona Gallagher is Founder & CEO.',
      },
    ],
  };

  const res = resolveTitleFromQualification({
    lead,
    qualification: qual as any,
    evidence: [{ id: 'e0', text: '[PROFILE] Fiona Gallagher' }],
  });
  assert.strictEqual(res, null);
});

test('resolveTitleFromQualification treats title matching full name as missing', () => {
  const lead = {
    fullName: 'George Clark',
    currentTitle: 'George Clark',
  };
  const qual = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'George Clark is Founder at Clark Systems.',
      },
    ],
  };

  const res = resolveTitleFromQualification({
    lead,
    qualification: qual as any,
    evidence: [{ id: 'e0', text: '[PROFILE] George Clark' }],
  });
  assert.ok(res);
  assert.strictEqual(res.title, 'Founder');
});

test('mapCandidateToPersistedLead backstop resolves missing title when candidate name in quote', () => {
  const candidate: Record<string, any> = {
    fullName: 'Hannah Vance',
    currentTitle: '',
    qualification: {
      requirements: [
        {
          requirementId: 'person_role-1',
          status: 'pass',
          evidenceQuote: 'Hannah Vance is Founder at Vance Logistics.',
        },
      ],
    },
  };

  const persisted = mapCandidateToPersistedLead(candidate);
  assert.strictEqual(candidate.currentTitle, 'Founder');
  assert.strictEqual(candidate.titleSource, 'inferred_from_qualification');
  assert.strictEqual(persisted.profile.currentTitle, 'Founder');
});

test('resolveTitleFromQualification supports non-AI industry contracts (e.g. dental clinic owner)', () => {
  const lead = { fullName: 'Dr. Emily Watson', currentTitle: '' };
  const qual = {
    requirements: [
      {
        requirementId: 'person_role-1',
        status: 'pass',
        evidenceId: 'e0',
        evidenceQuote: 'Dr. Emily Watson is a dental practice owner in Columbus, Ohio.',
      },
    ],
  };

  const contract: any = {
    requirements: [
      {
        scope: 'person_role',
        acceptableTerms: ['dental practice owner', 'practice owner', 'dentist'],
      },
    ],
  };

  const res = resolveTitleFromQualification({
    lead,
    qualification: qual as any,
    contract,
    evidence: [{ id: 'e0', text: '[PROFILE] Dr. Emily Watson profile' }],
  });

  assert.ok(res);
  assert.strictEqual(res.title, 'dental practice owner');
});

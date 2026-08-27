import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.js';

describe('Independent Founder & Boutique Agency Diversification', () => {
  it('does not collapse independent or self-employed agency founders into a single company slot', () => {
    const candidates = [
      {
        id: 'lead-1',
        fullName: 'Alice Smith',
        currentTitle: 'Founder',
        currentCompany: 'Self-Employed',
        finalSelectionScore: 9.5,
        qualification: { verdict: 'qualified', finalScore: 9.5 }
      },
      {
        id: 'lead-2',
        fullName: 'Bob Jones',
        currentTitle: 'Agency Owner',
        currentCompany: 'Self-Employed',
        finalSelectionScore: 9.2,
        qualification: { verdict: 'qualified', finalScore: 9.2 }
      },
      {
        id: 'lead-3',
        fullName: 'Charlie Brown',
        currentTitle: 'CEO & Founder',
        currentCompany: 'Freelance',
        finalSelectionScore: 8.9,
        qualification: { verdict: 'qualified', finalScore: 8.9 }
      },
      {
        id: 'lead-4',
        fullName: 'Diana Prince',
        currentTitle: 'Managing Partner',
        currentCompany: 'Independent Consultant',
        finalSelectionScore: 8.5,
        qualification: { verdict: 'qualified', finalScore: 8.5 }
      },
      {
        id: 'lead-5',
        fullName: 'Evan Wright',
        currentTitle: 'Principal',
        currentCompany: '',
        finalSelectionScore: 8.2,
        qualification: { verdict: 'qualified', finalScore: 8.2 }
      }
    ];

    // Even with maxPerCompany = 1, all 5 distinct independent founders must be selected
    const selected = selectDiversifiedLeads(candidates, 5, 1);
    assert.equal(selected.length, 5, `Expected 5 independent founders to be selected, got ${selected.length}`);
  });

  it('still enforces maxPerCompany for real named corporate entities', () => {
    const candidates = [
      {
        id: 'lead-1',
        fullName: 'Alice Smith',
        currentTitle: 'Founder',
        currentCompany: 'Acme AI Studio',
        finalSelectionScore: 9.5,
        qualification: { verdict: 'qualified', finalScore: 9.5 }
      },
      {
        id: 'lead-2',
        fullName: 'Bob Jones',
        currentTitle: 'Co-Founder',
        currentCompany: 'Acme AI Studio',
        finalSelectionScore: 9.2,
        qualification: { verdict: 'qualified', finalScore: 9.2 }
      },
      {
        id: 'lead-3',
        fullName: 'Charlie Brown',
        currentTitle: 'Founder',
        currentCompany: 'Nexus Agency',
        finalSelectionScore: 8.9,
        qualification: { verdict: 'qualified', finalScore: 8.9 }
      }
    ];

    // With maxPerCompany = 1, only 1 candidate from Acme AI Studio should be selected
    const selected = selectDiversifiedLeads(candidates, 5, 1);
    assert.equal(selected.length, 2);
    const companies = selected.map(s => s.currentCompany);
    assert.ok(companies.includes('Acme AI Studio'));
    assert.ok(companies.includes('Nexus Agency'));
  });
});

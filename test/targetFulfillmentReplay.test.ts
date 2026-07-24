import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.ts';
import { finalistCandidateFromLead, partitionCandidatesByStrictEvidence, validateFinalistJudgments } from '../server/leadSearch/finalistJudge.ts';
import { selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.ts';

describe('Target Fulfillment Replay Simulation', () => {
  it('simulates wave judging early stopping when target is reached', () => {
    const target = 3;
    const contract = buildDeterministicProspectContract('AI Startup Founder in New York', {
      version: 1,
      mode: 'person_first',
      person: { includeTitles: ['founder'], excludeTitles: [], seniorities: [], locations: ['New York'] },
      company: { industries: [], keywords: ['AI'], locations: [] },
      signals: { include: [] },
      exclusions: { companies: [], domains: [] },
      maxPerCompany: 2
    });

    const candidates = Array.from({ length: 10 }, (_, i) => {
      const lead = {
        id: `user-${i + 1}`,
        fullName: `Founder ${i + 1}`,
        currentTitle: 'Co-Founder & CEO',
        currentCompany: `AI Company ${Math.floor(i / 2) + 1}`,
        contactDetails: { linkedinUrl: `https://linkedin.com/in/user-${i + 1}` }
      };
      return finalistCandidateFromLead(`linkedin:user-${i + 1}`, lead, `Co-Founder & CEO at AI Company ${Math.floor(i / 2) + 1} in New York`, contract);
    });

    const qualifiedLeads: any[] = [];
    const judgeConcurrency = 2;
    const waves = Math.ceil(candidates.length / judgeConcurrency);
    let wavesRun = 0;

    for (let w = 0; w < waves; w++) {
      if (qualifiedLeads.length >= target) {
        break; // Stop wave judging immediately once target is reached!
      }
      wavesRun++;
      const waveCandidates = candidates.slice(w * judgeConcurrency, (w + 1) * judgeConcurrency);
      const mockJudgments = waveCandidates.map(c => ({
        candidateId: c.candidateId,
        status: 'qualified',
        reason: 'Verified Founder in New York',
        requirements: contract.requirements.filter(r => r.importance === 'hard').map(r => ({
          requirementId: r.id,
          status: 'pass',
          reason: 'Verified'
        })),
        semanticFit: 9,
        authorityFit: 9,
        evidenceConfidence: 9
      }));

      const validation = validateFinalistJudgments({ judgments: mockJudgments }, contract, waveCandidates);
      for (const candidate of waveCandidates) {
        const outcome = validation.outcomes.get(candidate.candidateId);
        if (outcome && outcome.status === 'qualified') {
          qualifiedLeads.push(candidate.lead);
        }
      }
    }

    assert.equal(wavesRun, 2); // 2 waves * 2 candidates = 4 candidates judged >= 3 target
    assert.ok(qualifiedLeads.length >= target);

    const finalDiversified = selectDiversifiedLeads(qualifiedLeads, target, 2);
    assert.equal(finalDiversified.length, 3);
  });

  it('simulates complete query exhaustion resulting in an HTTP 200 shortfall response', () => {
    const target = 10;
    const candidates = Array.from({ length: 4 }, (_, i) => ({
      id: `user-${i + 1}`,
      fullName: `Founder ${i + 1}`,
      currentCompany: `AI Company ${i + 1}`,
      contactDetails: { linkedinUrl: `https://linkedin.com/in/user-${i + 1}` }
    }));

    // Diversification selection with 4 available leads against 10 requested target
    const finalLeads = selectDiversifiedLeads(candidates, target, 2);
    const shortfall = target - finalLeads.length;

    assert.equal(finalLeads.length, 4);
    assert.equal(shortfall, 6);
  });
});

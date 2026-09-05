import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkStrictContradiction,
  triPartitionCandidatesByEvidence,
  validateFinalistJudgments,
  finalistCandidateFromLead,
  type FinalistCandidate,
} from '../server/leadSearch/finalistJudge.js';
import {
  buildDeterministicProspectContract,
  buildContractFallbackQueries,
  enforceContractQueries,
  isAgencyContract,
  PROSPECT_CONTRACT_POLICY_VERSION,
  type ProspectContract,
} from '../server/leadSearch/prospectContract.js';

describe('Semantic Qualification & Hard Seam Verification', () => {
  const agencyContract = buildDeterministicProspectContract('AI agency owner from first-world countries');

  describe('1. Hard Seam: Client Services / Agencies vs Software Products', () => {
    it('detects agency contract and includes negative exclusions during contract creation', () => {
      assert.equal(isAgencyContract('AI agency owner from first-world countries'), true);
      assert.equal(isAgencyContract('B2B SaaS Founder in Austin'), false);

      assert.ok(agencyContract.exclusions.some(e => /microsoft/i.test(e)));
      assert.ok(agencyContract.exclusions.some(e => /openai/i.test(e)));
      assert.ok(agencyContract.exclusions.some(e => /staff engineer/i.test(e)));
      assert.ok(agencyContract.exclusions.some(e => /principal engineer/i.test(e)));
      assert.ok(agencyContract.exclusions.some(e => /saas/i.test(e)));
      assert.ok(agencyContract.exclusions.some(e => /software product/i.test(e)));
    });

    it('formulates search queries with negative discriminators for agency briefs', () => {
      const queries = buildContractFallbackQueries('AI agency owner from USA', agencyContract.requirements);
      assert.ok(queries.length > 0);
      assert.ok(queries.some(q => q.query.includes('-software') || q.query.includes('-SaaS')));

      const enforced = enforceContractQueries([{ query: 'executive profile' }], agencyContract);
      assert.ok(enforced.length > 0);
      assert.ok(enforced.some(q => q.query.includes('-software') || q.query.includes('-SaaS')));
    });

    it('deterministically auto-fails pure consumer software products and mobile apps for agency contracts', () => {
      const softwareProductLead = {
        fullName: 'Alex Fit',
        currentTitle: 'Founder',
        currentCompany: 'MAGIC AI',
        headline: 'Founder at MAGIC AI personal trainer app',
        location: 'New York, NY, USA',
      };
      const contradiction = checkStrictContradiction(softwareProductLead, agencyContract);
      assert.ok(contradiction !== null);
      assert.match(contradiction!.reason, /software product\/app/i);

      const whatsDoLead = {
        fullName: 'Sam Dev',
        currentTitle: 'Creator',
        currentCompany: 'WhatsDo',
        headline: 'Creator of WhatsDo consumer mobile app for iOS',
        location: 'San Francisco, CA, USA',
      };
      const whatsDoContradiction = checkStrictContradiction(whatsDoLead, agencyContract);
      assert.ok(whatsDoContradiction !== null);
      assert.match(whatsDoContradiction!.reason, /software product\/app/i);
    });

    it('hard-fails candidates when judge fails company_type (no qualified_partial loophole)', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c_ember',
        lead: {
          fullName: 'Jordan Code',
          currentTitle: 'Founder & CEO',
          currentCompany: 'Ember AI',
          headline: 'Founder & CEO at Ember AI',
          location: 'San Francisco, CA, USA',
        },
        evidence: [{ id: 'e0', text: 'Founder & CEO of Ember AI, a consumer journaling platform.' }],
      };

      const hardReqs = agencyContract.requirements.filter(r => r.importance === 'hard');
      const companyReq = hardReqs.find(r => r.scope === 'company_type' || r.scope === 'company_industry');
      assert.ok(companyReq, 'Agency contract must have hard company requirement');

      const mockJudgments = [
        {
          candidateId: 'c_ember',
          semanticFit: 8.5,
          authorityFit: 9.0,
          evidenceConfidence: 8.0,
          reason: 'Founder of Ember AI, which is a software product, not an agency.',
          requirements: hardReqs.map(r => ({
            requirementId: r.id,
            status: r.id === companyReq!.id ? 'fail' : 'pass',
            reason: r.id === companyReq!.id ? 'Ember AI is a consumer product company, not an agency' : 'Matches',
          })),
        },
      ];

      const validation = validateFinalistJudgments({ judgments: mockJudgments }, agencyContract, [candidate]);
      assert.equal(validation.counts.qualified, 0, 'Must NOT qualify when company_type hard requirement fails');
      assert.equal(validation.counts.hardFail, 1, 'Must hard_fail when company_type fails');
      const outcome = validation.outcomes.get('c_ember');
      assert.equal(outcome?.status, 'hard_fail');
    });

    it('does not falsely auto-fail agencies that build internal SaaS or serve SaaS clients', () => {
      const saasAgencyLead = {
        fullName: 'Sara Agency',
        currentTitle: 'Founder & CEO',
        currentCompany: 'SaaS Growth Agency',
        headline: 'Founder & CEO at SaaS Growth Agency | We build AI solutions for SaaS platforms',
        location: 'Austin, TX, USA',
      };
      const contradiction = checkStrictContradiction(saasAgencyLead, agencyContract);
      assert.equal(contradiction, null, 'An agency serving SaaS or with SaaS in name must not be blocked by SaaS exclusion');
    });
  });

  describe('2. Deterministic Anti-Personas & Big-Tech Negative Filters', () => {
    it('auto-fails candidates employed by Big Tech enterprises for agency owner contracts', () => {
      const microsoftLead = {
        fullName: 'Taylor PM',
        currentTitle: 'Principal Product Manager',
        currentCompany: 'Microsoft',
        headline: 'Principal Product Manager @ Microsoft working on Azure AI',
        location: 'Seattle, WA, USA',
      };
      const msContradiction = checkStrictContradiction(microsoftLead, agencyContract);
      assert.ok(msContradiction !== null);
      assert.match(msContradiction!.reason, /non-agency tech enterprise|exclusion/i);

      const openAiLead = {
        fullName: 'Morgan AI',
        currentTitle: 'Research Scientist',
        currentCompany: 'OpenAI',
        headline: 'Member of Technical Staff at OpenAI',
        location: 'San Francisco, CA, USA',
      };
      const openAiContradiction = checkStrictContradiction(openAiLead, agencyContract);
      assert.ok(openAiContradiction !== null);
      assert.match(openAiContradiction!.reason, /non-agency tech enterprise|exclusion/i);
    });

    it('does not falsely auto-fail companies with substring collisions on Big Tech brands', () => {
      const appleseedLead = {
        fullName: 'Arthur Seed',
        currentTitle: 'Founder',
        currentCompany: 'Appleseed Creative Agency',
        headline: 'Founder at Appleseed Creative Agency',
        location: 'Boston, MA, USA',
      };
      assert.equal(checkStrictContradiction(appleseedLead, agencyContract), null, 'Appleseed must not match Apple exclusion');

      const metadataLead = {
        fullName: 'Mia Data',
        currentTitle: 'Managing Partner',
        currentCompany: 'Metadata Advisory Studio',
        headline: 'Managing Partner at Metadata Advisory Studio',
        location: 'New York, NY, USA',
      };
      assert.equal(checkStrictContradiction(metadataLead, agencyContract), null, 'Metadata must not match Meta exclusion');
    });

    it('does not auto-fail Big Tech employees when the contract is not an agency contract', () => {
      const techContract = buildDeterministicProspectContract('VP of Engineering at tech company in Seattle', {
        person: { includeTitles: ['VP of Engineering'], excludeTitles: [], seniorities: [], locations: ['Seattle'] }
      });
      const microsoftVp = {
        fullName: 'Alex VP',
        currentTitle: 'VP of Engineering',
        currentCompany: 'Microsoft',
        headline: 'VP of Engineering at Microsoft',
        location: 'Seattle, WA, USA',
      };
      const contradiction = checkStrictContradiction(microsoftVp, techContract);
      assert.equal(contradiction, null, 'Big Tech employee must not be auto-failed when query is not for an agency');
    });

    it('auto-fails individual contributor roles without founder/owner title when authority is required', () => {
      const icLead = {
        fullName: 'Casey Tech',
        currentTitle: 'Principal AI Engineer',
        currentCompany: 'DataCorp',
        headline: 'Principal AI Engineer at DataCorp',
        location: 'Austin, TX, USA',
      };
      const icContradiction = checkStrictContradiction(icLead, agencyContract);
      assert.ok(icContradiction !== null);
      assert.match(icContradiction!.reason, /individual contributor role/i);

      const staffLead = {
        fullName: 'Pat Staff',
        currentTitle: 'Staff Software Engineer',
        currentCompany: 'CloudWorks',
        headline: 'Staff Software Engineer at CloudWorks',
        location: 'Boston, MA, USA',
      };
      const staffContradiction = checkStrictContradiction(staffLead, agencyContract);
      assert.ok(staffContradiction !== null);
      assert.match(staffContradiction!.reason, /individual contributor role/i);
    });

    it('allows genuine agency founders who also mention technical roles', () => {
      const founderLead = {
        fullName: 'Dana Founder',
        currentTitle: 'Founder & Principal Engineer',
        currentCompany: 'Apex AI Agency',
        headline: 'Founder & Principal Engineer at Apex AI Agency',
        location: 'Denver, CO, USA',
      };
      const contradiction = checkStrictContradiction(founderLead, agencyContract);
      assert.equal(contradiction, null, 'Founder & Principal Engineer must not be blocked by IC filter');
    });
  });

  describe('3. Mandatory Company Verification', () => {
    it('rejects candidates with company: null or empty for contracts with company requirements', () => {
      const nullCompanyLead = {
        fullName: 'Ghost Owner',
        currentTitle: 'Agency Owner',
        currentCompany: null,
        company: '',
        location: 'Chicago, IL, USA',
      };
      const contradiction = checkStrictContradiction(nullCompanyLead, agencyContract);
      assert.ok(contradiction !== null);
      assert.match(contradiction!.reason, /no verified company or organization/i);
    });

    it('accepts candidates with verified company entity resolution even if primary string was blank', () => {
      const entityVerifiedLead = {
        fullName: 'Robin Partner',
        currentTitle: 'Managing Partner',
        currentCompany: '',
        company: '',
        location: 'Chicago, IL, USA',
        companyEntityResolution: {
          verified: true,
          companyName: 'Boutique AI Studio',
        },
      };
      const contradiction = checkStrictContradiction(entityVerifiedLead, agencyContract);
      assert.equal(contradiction, null, 'Verified company entity resolution must pass verification');
    });
  });

  describe('4. Honest Shortfall Reporting & Triage Partitioning', () => {
    it('tri-partitions candidates and drops non-agency / big-tech / null-company leads before judge', () => {
      const candidates: FinalistCandidate[] = [
        finalistCandidateFromLead(
          'c_valid',
          {
            fullName: 'Sarah Boss',
            currentTitle: 'CEO & Founder',
            currentCompany: 'Vanguard AI Agency',
            location: 'New York, NY, USA',
          },
          'CEO & Founder of Vanguard AI Agency in New York, USA.',
          agencyContract,
        ),
        finalistCandidateFromLead(
          'c_bigtech',
          {
            fullName: 'Tim Tech',
            currentTitle: 'Principal Product Manager',
            currentCompany: 'Microsoft',
            location: 'Seattle, WA, USA',
          },
          'Principal Product Manager at Microsoft in Seattle.',
          agencyContract,
        ),
        finalistCandidateFromLead(
          'c_no_company',
          {
            fullName: 'No Co',
            currentTitle: 'Owner',
            currentCompany: null,
            location: 'Austin, TX, USA',
          },
          'Owner with no company listed.',
          agencyContract,
        ),
        finalistCandidateFromLead(
          'c_product',
          {
            fullName: 'App Maker',
            currentTitle: 'Founder',
            currentCompany: 'FitBot App',
            headline: 'Founder of FitBot consumer mobile app',
            location: 'Los Angeles, CA, USA',
          },
          'Founder of FitBot consumer mobile app in LA.',
          agencyContract,
        ),
      ];

      const triage = triPartitionCandidatesByEvidence(candidates, agencyContract);
      assert.ok(triage.autoFailed.some(f => f.candidate.candidateId === 'c_bigtech'));
      assert.ok(triage.autoFailed.some(f => f.candidate.candidateId === 'c_no_company'));
      assert.ok(triage.autoFailed.some(f => f.candidate.candidateId === 'c_product'));
      assert.ok(
        triage.autoQualified.some(q => q.candidate.candidateId === 'c_valid') ||
        triage.needsJudge.some(n => n.candidateId === 'c_valid'),
      );
    });
  });
});

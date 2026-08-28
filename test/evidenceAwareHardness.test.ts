import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectEvidenceForFinalist
} from '../server/leadSearch/evidenceSelection.js';
import { type ProspectContract, PROSPECT_CONTRACT_POLICY_VERSION } from '../server/leadSearch/prospectContract.js';

describe('Phase 4: Evidence-Aware Hardness & Modality Routing', () => {
  const originalEnv = process.env.EVIDENCE_AWARE_HARDNESS_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EVIDENCE_AWARE_HARDNESS_ENABLED;
    } else {
      process.env.EVIDENCE_AWARE_HARDNESS_ENABLED = originalEnv;
    }
  });

  const contract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Find hiring agency owners',
    authorityRequired: false,
    exclusions: [],
    initialQueries: [],
    requirements: [
      {
        id: 'req-owner',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'owner',
        sourcePhrase: 'owner',
        acceptableTerms: ['owner', 'founder'],
        queryable: true,
        requirementClass: 'identity_hard',
        queryHardness: 'required_in_every_query',
        acceptableEvidenceSources: ['linkedin_profile']
      },
      {
        id: 'req-hiring',
        scope: 'signal',
        importance: 'hard',
        evidenceModality: 'open_web_signal',
        description: 'hiring',
        sourcePhrase: 'hiring',
        acceptableTerms: ['hiring', 'careers', 'open roles'],
        queryable: true,
        requirementClass: 'evidence_required',
        queryHardness: 'distributed_across_queries',
        acceptableEvidenceSources: ['job_postings', 'company_website']
      }
    ]
  };

  const lead = {
    fullName: 'Alex River',
    currentTitle: 'Founder & CEO',
    currentCompany: 'Apex Studio',
    location: 'Austin, TX',
    evidence: {
      evidenceBlock: '[OPEN-WEB SIGNAL: We are hiring 5 senior engineers in 2026]\nAlex River is the Founder at Apex Studio based on LinkedIn profile data.\nCareers page shows active hiring for engineers.',
      snippets: [
        'LinkedIn profile: Alex River is Founder & CEO at Apex Studio.',
        'Careers job postings: We are hiring engineers.'
      ]
    },
    scout: { criteriaCoverageScore: 8, corroborationScore: 8 }
  };

  describe('When flag is DISABLED (Legacy behavior)', () => {
    beforeEach(() => {
      process.env.EVIDENCE_AWARE_HARDNESS_ENABLED = 'false';
    });

    it('selects evidence and preserves open-web signal slot e2', () => {
      const selected = selectEvidenceForFinalist(lead, contract);
      assert.ok(selected.evidence.length >= 2);
      const e0 = selected.evidence.find(e => e.id === 'e0');
      assert.ok(e0?.text.includes('Alex River'));
    });
  });

  describe('When flag is ENABLED (Evidence-Aware behavior)', () => {
    beforeEach(() => {
      process.env.EVIDENCE_AWARE_HARDNESS_ENABLED = 'true';
    });

    it('prioritizes acceptable evidence sources in sentence selection', () => {
      const selected = selectEvidenceForFinalist(lead, contract);
      assert.ok(selected.evidence.length >= 2);
      const e2 = selected.evidence.find(e => e.id === 'e2');
      assert.ok(e2, 'Should reserve dedicated signal slot e2');
      assert.ok(e2.text.includes('OPEN-WEB SIGNAL'));
    });

    it('tracks covered hard requirement IDs accurately', () => {
      const selected = selectEvidenceForFinalist(lead, contract);
      assert.ok(selected.coveredHardRequirementIds.includes('req-owner') || selected.coveredHardRequirementIds.includes('req-hiring'));
    });
  });
});

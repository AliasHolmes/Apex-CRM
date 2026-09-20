import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCompanySourceText,
  sanitizeDomainGuess,
  runGatedCompanyAttribution,
} from '../server/leadSearch/companyAttribution.js';
import type { FinalistCandidate } from '../server/leadSearch/finalistJudge.js';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';

describe('Gated Company Attribution Module', () => {
  const contract = buildDeterministicProspectContract(
    'Agency owners in North America actively posting about custom n8n workflows and delivery bottlenecks',
    {},
  );

  describe('sanitizeDomainGuess', () => {
    it('cleans company name, strips spaces and entity suffixes into valid hostname', () => {
      const domain = sanitizeDomainGuess('Austin Artificial Intelligence, Inc.');
      assert.equal(domain, 'austinartificialintelligence.com');
      assert.ok(!domain.includes(' '), 'Guessed domain must never contain spaces');
    });

    it('handles international entities and punctuation', () => {
      const domain = sanitizeDomainGuess('Mueller & Schmidt Consulting GmbH');
      assert.equal(domain, 'muellerschmidt.com');
    });
  });

  describe('extractCompanySourceText', () => {
    it('extracts domain and site evidence from candidate', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'cand-1',
        lead: {
          id: 'lead-1',
          fullName: 'Alice Smith',
          currentTitle: 'Founder & CEO',
          currentCompany: 'Flow Agency',
          contactDetails: {
            website: 'https://www.flowagency.com/about',
          },
        },
        evidence: [
          {
            id: 'e1',
            text: '[COMPANY SITE: flowagency.com] We are a bespoke automation agency specializing in n8n workflows and API integrations for client teams.',
          },
        ],
      };

      const extracted = extractCompanySourceText(candidate);
      assert.equal(extracted.companyName, 'Flow Agency');
      assert.equal(extracted.domain, 'flowagency.com');
      assert.ok(
        extracted.sourceText.includes('bespoke automation agency'),
        'Source text should contain the scraped company site content',
      );
    });

    it('falls back to general evidence mentioning the company name when site snippet tag is missing', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'cand-2',
        lead: {
          id: 'lead-2',
          fullName: 'Bob Jones',
          currentTitle: 'Managing Partner',
          company: 'Nexus Digital',
          website: 'https://nexusdigital.io',
        },
        evidence: [
          {
            id: 'e2',
            text: 'Nexus Digital is an elite client services agency building custom cloud and automation infrastructure for modern enterprises.',
          },
        ],
      };

      const extracted = extractCompanySourceText(candidate);
      assert.equal(extracted.companyName, 'Nexus Digital');
      assert.equal(extracted.domain, 'nexusdigital.io');
      assert.ok(extracted.sourceText.includes('Nexus Digital is an elite client services agency'));
    });

    it('guards Fallback-3 by rejecting person-bio and LinkedIn resume snippets', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'cand-bio',
        lead: {
          id: 'lead-bio',
          fullName: 'John Miller',
          currentTitle: 'CEO',
          company: 'Acme Cloud Solutions',
        },
        evidence: [
          {
            id: 'e0',
            text: '[PROFILE: linkedin.com/in/johnmiller] John Miller is the CEO at Acme Cloud Solutions. Passionate about sales leadership, coaching, and team development.',
          },
        ],
      };

      const extracted = extractCompanySourceText(candidate);
      assert.equal(extracted.companyName, 'Acme Cloud Solutions');
      assert.equal(extracted.sourceText, '', 'Person profile text must be excluded from company source text');
    });
  });

  describe('runGatedCompanyAttribution', () => {
    it('deduplicates multiple candidates from the same company and verifies valid quotes', async () => {
      const sourceSnippet =
        '[COMPANY SITE: automationsmith.com] Automation Smith is a full-service automation consultancy helping B2B agencies streamline fulfillment with n8n.';

      const cand1: FinalistCandidate = {
        candidateId: 'cand-1',
        lead: {
          id: 'lead-1',
          fullName: 'Sarah Smith',
          currentTitle: 'Co-Founder & CEO',
          currentCompany: 'Automation Smith',
          contactDetails: { website: 'https://automationsmith.com' },
        },
        evidence: [{ id: 'e1', text: sourceSnippet }],
      };

      const cand2: FinalistCandidate = {
        candidateId: 'cand-2',
        lead: {
          id: 'lead-2',
          fullName: 'Dave Miller',
          currentTitle: 'Head of Solutions',
          currentCompany: 'Automation Smith',
          contactDetails: { website: 'https://automationsmith.com' },
        },
        evidence: [{ id: 'e1', text: sourceSnippet }],
      };

      let llmCallCount = 0;

      const mockOpenAIStructured = async () => {
        llmCallCount++;
        return {
          attributions: [
            {
              companyKey: 'automationsmith.com',
              businessModel: 'client_services_agency',
              primaryOffering: 'Full-service automation consultancy for B2B agencies using n8n.',
              queryAlignment: 'matches_brief',
              verbatimEvidenceQuote:
                'Automation Smith is a full-service automation consultancy helping B2B agencies streamline fulfillment with n8n.',
              verdict: 'verified_fit',
              reason: 'Matches client services agency requirement with n8n expertise.',
            },
          ],
        };
      };

      const summary = await runGatedCompanyAttribution(
        [cand1, cand2],
        contract,
        {
          openAIStructured: mockOpenAIStructured,
        },
      );

      // Verify deduplication: 2 candidates at the same domain should result in only 1 LLM evaluation
      assert.equal(llmCallCount, 1, 'Should batch/deduplicate candidates from the same domain into 1 LLM call');
      assert.equal(summary.attributedCount, 2, 'Both candidates should be attributed');
      assert.equal(summary.verifiedCount, 2, 'Both candidates should be verified');
      assert.equal(summary.contradictionCount, 0);

      // Verify cand1 attribution result
      const attr1 = cand1.lead.companyAttribution;
      assert.ok(attr1, 'cand1 should have companyAttribution');
      assert.equal(attr1.businessModel, 'client_services_agency');
      assert.equal(attr1.verdict, 'verified_fit');
      assert.equal(attr1.quoteVerified, true, 'Verbatim quote must be verified against source text');

      // Verify cand2 also received the attribution result
      const attr2 = cand2.lead.companyAttribution;
      assert.ok(attr2, 'cand2 should also have companyAttribution');
      assert.equal(attr2.verdict, 'verified_fit');

      // Verify structured attribution evidence was prepended to candidate.evidence
      assert.equal(cand1.evidence[0].id, 'e_company_attr');
      assert.ok(cand1.evidence[0].text.includes('[COMPANY ATTRIBUTION (verified_fit): automationsmith.com]'));
    });

    it('downgrades verdict to unverified when LLM invents or hallucinates an evidence quote', async () => {
      const sourceSnippet =
        '[COMPANY SITE: quickreach.io] QuickReach provides cold outreach tooling and lead enrichment software for sales teams.';

      const cand: FinalistCandidate = {
        candidateId: 'cand-fab',
        lead: {
          id: 'lead-fab',
          fullName: 'Mark Hall',
          currentTitle: 'Founder',
          currentCompany: 'QuickReach',
          contactDetails: { website: 'https://quickreach.io' },
        },
        evidence: [{ id: 'e1', text: sourceSnippet }],
      };

      const mockOpenAIStructured = async () => {
        return {
          attributions: [
            {
              companyKey: 'quickreach.io',
              businessModel: 'client_services_agency',
              primaryOffering: 'We are a premier agency doing custom workflow design.',
              queryAlignment: 'matches_brief',
              // Fabricated quote not in sourceSnippet!
              verbatimEvidenceQuote: 'We are a premier agency doing custom workflow design and n8n consulting.',
              verdict: 'verified_fit',
              reason: 'Claims to be an agency.',
            },
          ],
        };
      };

      const summary = await runGatedCompanyAttribution([cand], contract, {
        openAIStructured: mockOpenAIStructured,
      });

      assert.equal(summary.attributedCount, 1);
      assert.equal(summary.verifiedCount, 0, 'Fabricated quote must prevent verifiedCount promotion');

      const attr = cand.lead.companyAttribution;
      assert.ok(attr);
      assert.equal(attr.verdict, 'unverified', 'Should downgrade from verified_fit to unverified on citation mismatch');
      assert.equal(attr.quoteVerified, false);
      assert.equal(attr.verbatimEvidenceQuote, '', 'Fabricated quote should be cleared');
    });

    it('auto-fails disqualifying contradictions (e.g. detective agency on an agency brief)', async () => {
      const sourceSnippet =
        '[COMPANY SITE: travisinvestigations.com] Travis Investigations is a licensed private detective agency specializing in background checks, surveillance, and marital infidelity investigations.';

      const cand: FinalistCandidate = {
        candidateId: 'cand-pi',
        lead: {
          id: 'lead-pi',
          fullName: 'Travis Scott',
          currentTitle: 'Owner & Chief Investigator',
          currentCompany: 'Travis Investigations',
          contactDetails: { website: 'https://travisinvestigations.com' },
        },
        evidence: [{ id: 'e1', text: sourceSnippet }],
      };

      const mockOpenAIStructured = async () => {
        return {
          attributions: [
            {
              companyKey: 'travisinvestigations.com',
              businessModel: 'other_services',
              primaryOffering: 'Private investigation, surveillance, and background checks.',
              queryAlignment: 'contradicts',
              verbatimEvidenceQuote:
                'Travis Investigations is a licensed private detective agency specializing in background checks',
              verdict: 'disqualifying_contradiction',
              reason: 'Private detective agency, not a digital/tech client-services agency.',
            },
          ],
        };
      };

      const summary = await runGatedCompanyAttribution([cand], contract, {
        openAIStructured: mockOpenAIStructured,
      });

      assert.equal(summary.attributedCount, 1);
      assert.equal(summary.contradictionCount, 1);
      assert.equal(cand.lead._autoFailed, true, 'Disqualifying contradiction must flag _autoFailed = true');
      assert.ok(
        cand.lead._contradictionReason?.includes('Private detective agency'),
        'Contradiction reason must explain disqualification',
      );
    });

    it('handles batching across multiple companies up to batch limit', async () => {
      const companies = ['alpha-consulting.com', 'beta-design.com', 'gamma-ops.com', 'delta-marketing.com', 'epsilon-tech.com'];
      const candidates: FinalistCandidate[] = companies.map((domain, i) => ({
        candidateId: `cand-${i}`,
        lead: {
          id: `lead-${i}`,
          fullName: `Exec ${i}`,
          currentCompany: `Company ${i}`,
          contactDetails: { website: `https://${domain}` },
        },
        evidence: [
          {
            id: `e-${i}`,
            text: `[COMPANY SITE: ${domain}] Company ${i} provides full service digital consultancy and automation.`,
          },
        ],
      }));

      let batchCalls = 0;
      const mockOpenAIStructured = async () => {
        batchCalls++;
        const returnedAttributions = companies.map((domain, idx) => ({
          companyKey: domain,
          businessModel: 'client_services_agency',
          primaryOffering: `Consultancy ${idx}`,
          queryAlignment: 'matches_brief',
          verbatimEvidenceQuote: `Company ${idx} provides full service digital consultancy and automation.`,
          verdict: 'verified_fit',
          reason: 'Matches brief',
        }));
        return { attributions: returnedAttributions };
      };

      const summary = await runGatedCompanyAttribution(candidates, contract, {
        openAIStructured: mockOpenAIStructured,
      });

      // 5 companies with BATCH_SIZE = 4 should yield exactly 2 LLM calls (4 in first, 1 in second)
      assert.equal(batchCalls, 2, '5 companies should be split into 2 batches (4 + 1)');
      assert.equal(summary.attributedCount, 5);
      assert.equal(summary.verifiedCount, 5);
    });
  });
});

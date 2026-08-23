import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveCompanyDomain,
  deriveCompanyDomainWithProvenance,
  extractSiteSignals,
  applySiteProbe,
  normalizeDomainUrl,
  parseSiteSignalsFromEvidenceBlock,
  matchesCompanyIdentity
} from '../server/leadSearch/siteProbe.ts';

describe('Company Site Probe', () => {
  describe('deriveCompanyDomain & Provenance', () => {
    it('normalizes domain URLs and filters out blocked social / aggregator domains', () => {
      assert.equal(normalizeDomainUrl('https://www.linkedin.com/in/jane-doe'), null);
      assert.equal(normalizeDomainUrl('https://crunchbase.com/organization/acme'), null);
      assert.equal(normalizeDomainUrl('https://facebook.com/acme'), null);
      assert.equal(normalizeDomainUrl('https://twitter.com/acme'), null);
      assert.equal(normalizeDomainUrl('https://www.acmeautomation.io/about'), 'https://acmeautomation.io');
      assert.equal(normalizeDomainUrl('growthagency.co.uk/team'), 'https://growthagency.co.uk');
    });

    it('extracts non-social company website with explicit or evidence_url provenance', () => {
      const leadWithExplicitWebsite = {
        fullName: 'Jane Doe',
        company: 'Acme Digital',
        website: 'https://acmedigital.com/services'
      };
      const res1 = deriveCompanyDomainWithProvenance(leadWithExplicitWebsite);
      assert.ok(res1);
      assert.equal(res1.domain, 'https://acmedigital.com');
      assert.equal(res1.provenance, 'explicit');

      const leadWithEvidenceUrl = {
        fullName: 'John Smith',
        company: 'FlowOps Studio',
        evidence: {
          evidenceBlock: 'LINK: https://linkedin.com/in/johnsmith\nCheck our work at https://flowops.agency/case-studies'
        }
      };
      const res2 = deriveCompanyDomainWithProvenance(leadWithEvidenceUrl);
      assert.ok(res2);
      assert.equal(res2.domain, 'https://flowops.agency');
      assert.equal(res2.provenance, 'evidence_url');
    });

    it('falls back to clean slug guess with slug_guess provenance', () => {
      const leadWithCompanyOnly = {
        fullName: 'Alice Walker',
        currentCompany: 'Apex Automation Agency LLC'
      };
      const res = deriveCompanyDomainWithProvenance(leadWithCompanyOnly);
      assert.ok(res);
      assert.equal(res.domain, 'https://apexautomation.com');
      assert.equal(res.provenance, 'slug_guess');
      assert.equal(deriveCompanyDomain(leadWithCompanyOnly), 'https://apexautomation.com');
    });
  });

  describe('matchesCompanyIdentity', () => {
    it('verifies that page content contains distinctive company name tokens', () => {
      assert.equal(matchesCompanyIdentity('NeuralSpark AI', '# Welcome to NeuralSpark\nWe build AI agents.'), true);
      assert.equal(matchesCompanyIdentity('Apex Workflow Solutions LLC', 'Apex is a premier automation studio.'), true);
      assert.equal(matchesCompanyIdentity('CloudOps', 'CloudOps engineering team delivers 24/7 reliability.'), true);
    });

    it('rejects unrelated page content for slug guesses', () => {
      const unrelatedPage = `
# Best Dental Care in Miami
Call Dr. Smith for all your dental needs in Miami, Florida.
`;
      assert.equal(matchesCompanyIdentity('NeuralSpark', unrelatedPage), false);
      assert.equal(matchesCompanyIdentity('Apex Automation', unrelatedPage), false);
    });
  });

  describe('parseSiteSignalsFromEvidenceBlock', () => {
    it('parses structured location, headcount, and services from cached evidence block', () => {
      const cachedBlock = `
Location: Austin, TX
Team: 24
Services: Custom Zapier integrations | Make workflow architecture
`;
      const signals = parseSiteSignalsFromEvidenceBlock(cachedBlock);
      assert.equal(signals.location, 'Austin, TX');
      assert.equal(signals.headcount, '24');
      assert.equal(signals.services, 'Custom Zapier integrations | Make workflow architecture');
    });

    it('handles empty or partial evidence blocks gracefully', () => {
      const emptySignals = parseSiteSignalsFromEvidenceBlock('');
      assert.deepEqual(emptySignals, {});

      const partialSignals = parseSiteSignalsFromEvidenceBlock('Location: London, UK');
      assert.equal(partialSignals.location, 'London, UK');
      assert.equal(partialSignals.headcount, undefined);
      assert.equal(partialSignals.services, undefined);
    });
  });

  describe('extractSiteSignals', () => {
    it('extracts location, headcount, and services from markdown content', () => {
      const markdown = `
# Welcome to Apex Automation
We are an elite workflow consultancy.
Headquartered in Austin, TX, our team of 18 specialists builds custom Zapier, Make, and CRM integrations.

## What We Do
- Workflow automation & API integrations
- Custom CRM architecture and RevOps consulting
- AI automated workflows for marketing agencies

## Contact Us
Reach out to our Austin office today.
`;

      const signals = extractSiteSignals(markdown);
      assert.ok(signals);
      assert.match(signals.location || '', /Austin,\s*TX/i);
      assert.equal(signals.headcount, '18');
      assert.match(signals.services || '', /automation|crm/i);
    });

    it('rejects parked, domain-for-sale, and cloudflare challenge pages', () => {
      const parkedPage = `
Buy this domain! This domain is available for purchase.
Contact our domain broker today to make an offer on this premium web address.
`;
      assert.equal(extractSiteSignals(parkedPage), null);

      const cloudflarePage = `
Attention Required! | Cloudflare
Please complete the security check to access the website.
Ray ID: 123456789.
`;
      assert.equal(extractSiteSignals(cloudflarePage), null);
    });
  });

  describe('applySiteProbe', () => {
    it('fills only empty fields, tags provenance, and never overwrites existing verified fields', () => {
      const lead: Record<string, any> = {
        fullName: 'Jane Doe',
        currentCompany: 'Flow Studio',
        location: 'San Francisco, CA', // Existing verified location
        profile: {
          location: 'San Francisco, CA'
        },
        companyAccount: {},
        evidence: {
          evidenceBlock: 'NAME: Jane Doe\nCOMPANY: Flow Studio'
        }
      };

      const target: any = {
        lead,
        evidenceMeta: {
          evidenceBlock: 'NAME: Jane Doe\nCOMPANY: Flow Studio'
        }
      };

      let refreshed = false;
      applySiteProbe(
        target,
        {
          location: 'Austin, TX', // Probe found Austin, TX
          headcount: '14',
          services: 'Zapier & Make Automation',
          provenance: 'explicit'
        },
        'https://flowstudio.io',
        () => { refreshed = true; }
      );

      // Existing location must NOT be overwritten
      assert.equal(lead.location, 'San Francisco, CA');
      assert.equal(lead.profile.location, 'San Francisco, CA');

      // Empty headcount must be populated
      assert.equal(lead.companySizeEst, '14');
      assert.equal(lead.companyAccount.employeeCount, '14');
      assert.equal(lead.companyAccount.description, 'Zapier & Make Automation');

      // Site evidence line must be appended with provenance
      assert.match(target.evidenceMeta.evidenceBlock, /\[COMPANY SITE \(verified-site\): https:\/\/flowstudio\.io\]/);
      assert.match(target.evidenceMeta.evidenceBlock, /Team: 14/);
      assert.equal(refreshed, true);
    });

    it('populates missing location and tags name-match for slug guesses', () => {
      const lead: Record<string, any> = {
        fullName: 'Bob Smith',
        currentCompany: 'Cloud Agency',
        companyAccount: {},
        evidence: {
          evidenceBlock: 'NAME: Bob Smith\nCOMPANY: Cloud Agency'
        }
      };

      const target: any = {
        lead,
        evidenceMeta: {
          evidenceBlock: 'NAME: Bob Smith\nCOMPANY: Cloud Agency'
        }
      };

      applySiteProbe(
        target,
        {
          location: 'Denver, CO',
          headcount: '8',
          services: 'Marketing Automation',
          provenance: 'slug_guess'
        },
        'https://cloudagency.co'
      );

      assert.equal(lead.location, 'Denver, CO');
      assert.equal(lead.profile.location, 'Denver, CO');
      assert.equal(lead.companySizeEst, '8');
      assert.match(target.evidenceMeta.evidenceBlock, /\[COMPANY SITE \(name-match\): https:\/\/cloudagency\.co\]/);
    });
  });
});

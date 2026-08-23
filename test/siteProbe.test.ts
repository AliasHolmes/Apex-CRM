import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveCompanyDomain,
  extractSiteSignals,
  applySiteProbe,
  normalizeDomainUrl
} from '../server/leadSearch/siteProbe.ts';

describe('Company Site Probe', () => {
  describe('deriveCompanyDomain', () => {
    it('normalizes domain URLs and filters out blocked social / aggregator domains', () => {
      assert.equal(normalizeDomainUrl('https://www.linkedin.com/in/jane-doe'), null);
      assert.equal(normalizeDomainUrl('https://crunchbase.com/organization/acme'), null);
      assert.equal(normalizeDomainUrl('https://facebook.com/acme'), null);
      assert.equal(normalizeDomainUrl('https://twitter.com/acme'), null);
      assert.equal(normalizeDomainUrl('https://www.acmeautomation.io/about'), 'https://acmeautomation.io');
      assert.equal(normalizeDomainUrl('growthagency.co.uk/team'), 'https://growthagency.co.uk');
    });

    it('extracts non-social company website from lead website fields or evidence snippets', () => {
      const leadWithExplicitWebsite = {
        fullName: 'Jane Doe',
        company: 'Acme Digital',
        website: 'https://acmedigital.com/services'
      };
      assert.equal(deriveCompanyDomain(leadWithExplicitWebsite), 'https://acmedigital.com');

      const leadWithEvidenceUrl = {
        fullName: 'John Smith',
        company: 'FlowOps Studio',
        evidence: {
          evidenceBlock: 'LINK: https://linkedin.com/in/johnsmith\nCheck our work at https://flowops.agency/case-studies'
        }
      };
      assert.equal(deriveCompanyDomain(leadWithEvidenceUrl), 'https://flowops.agency');
    });

    it('falls back to clean slug guess from company name', () => {
      const leadWithCompanyOnly = {
        fullName: 'Alice Walker',
        currentCompany: 'Apex Automation Agency LLC'
      };
      assert.equal(deriveCompanyDomain(leadWithCompanyOnly), 'https://apexautomation.com');
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
    it('fills only empty fields and never overwrites existing verified fields', () => {
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
          services: 'Zapier & Make Automation'
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

      // Site evidence line must be appended
      assert.match(target.evidenceMeta.evidenceBlock, /\[COMPANY SITE: https:\/\/flowstudio\.io\]/);
      assert.match(target.evidenceMeta.evidenceBlock, /Team: 14/);
      assert.equal(refreshed, true);
    });

    it('populates missing location when candidate had no location', () => {
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
          services: 'Marketing Automation'
        },
        'https://cloudagency.co'
      );

      assert.equal(lead.location, 'Denver, CO');
      assert.equal(lead.profile.location, 'Denver, CO');
      assert.equal(lead.companySizeEst, '8');
    });
  });
});

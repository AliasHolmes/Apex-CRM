import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCompanyDomainWithProvenance,
  matchesCompanyIdentity
} from '../server/leadSearch/siteProbe.js';

describe('Optimization 2: Safe Slug Probing & Anti-Hijacking', () => {
  const originalEnv = process.env.SAFE_SLUG_PROBE_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SAFE_SLUG_PROBE_ENABLED;
    } else {
      process.env.SAFE_SLUG_PROBE_ENABLED = originalEnv;
    }
  });

  const shortBrandLead = {
    fullName: 'Alex River',
    currentCompany: 'Apex',
    location: 'Austin, TX',
    industry: 'Software Consulting'
  };

  const specificBrandLead = {
    fullName: 'Jane Smith',
    currentCompany: 'TechFlow Systems',
    location: 'Denver, CO',
    industry: 'Cloud Infrastructure'
  };

  describe('deriveCompanyDomainWithProvenance', () => {
    it('allows slug guess for short generic brands in legacy mode', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'false';
      const derived = deriveCompanyDomainWithProvenance(shortBrandLead);
      assert.equal(derived?.domain, 'https://apex.com');
      assert.equal(derived?.provenance, 'slug_guess');
    });

    it('blocks unverified naked .com slug guessing for generic short brands when safe slug probe is enabled', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'true';
      const derived = deriveCompanyDomainWithProvenance(shortBrandLead);
      assert.equal(derived, null, 'Should block apex.com slug guess for short generic brand');
    });

    it('allows slug guess for multi-word or distinctive company names', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'true';
      const derived = deriveCompanyDomainWithProvenance(specificBrandLead);
      assert.equal(derived?.domain, 'https://techflowsystems.com');
      assert.equal(derived?.provenance, 'slug_guess');
    });
  });

  describe('matchesCompanyIdentity anti-hijacking', () => {
    const scrapedUnrelatedMegaCorp = `
      Apex Global Insurance Corporation
      Headquarters: New York, NY
      Employees: 50,000
      Services: Global Life Insurance and Underwriting
    `;

    const scrapedGenuineTarget = `
      Apex Studio
      Location: Austin, Texas
      Team: 15 senior software engineers
      Services: Software Consulting and AI integrations
    `;

    it('falsely matches unrelated mega-corp in legacy mode simply because "Apex" is mentioned', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'false';
      const matched = matchesCompanyIdentity('Apex', scrapedUnrelatedMegaCorp, shortBrandLead, 'slug_guess');
      assert.equal(matched, true, 'Legacy mode falsely matches solely on single token');
    });

    it('rejects unrelated mega-corp when safe slug probe is enabled due to lack of secondary corroboration', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'true';
      const matched = matchesCompanyIdentity('Apex', scrapedUnrelatedMegaCorp, shortBrandLead, 'slug_guess');
      assert.equal(matched, false, 'Safe probe rejects because Austin / Software Consulting is not in the scraped text');
    });

    it('accepts genuine target site because location (Austin) or industry matches', () => {
      process.env.SAFE_SLUG_PROBE_ENABLED = 'true';
      const matched = matchesCompanyIdentity('Apex', scrapedGenuineTarget, shortBrandLead, 'slug_guess');
      assert.equal(matched, true, 'Safe probe accepts because Austin / Software Consulting is confirmed in scraped text');
    });
  });
});

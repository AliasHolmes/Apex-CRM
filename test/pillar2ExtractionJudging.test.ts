import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeCareerTrajectoryDCR
} from '../server/leadSearch/verification.ts';
import {
  normalizeCompanyName
} from '../server/leadSearch/signalStore.ts';
import {
  extractSiteSignals
} from '../server/leadSearch/siteProbe.ts';

describe('Pillar 2: Extraction, Site Probing & Entity Resolution Intelligence', () => {
  describe('Career Trajectory DCR & Title Verification', () => {
    it('accurately scores Partner and Managing Partner roles (fixing label bug)', () => {
      const expPartner = [
        { title: 'Managing Partner', company: 'Apex Advisory', description: 'Leading corporate strategy' },
        { title: 'Senior Partner', company: 'McKinsey', description: 'Management consulting' }
      ];
      const dcr = computeCareerTrajectoryDCR(expPartner, ['strategy', 'consulting']);
      assert.ok(dcr.trajectoryScore >= 8.5, `Partner score should be >= 8.5, got ${dcr.trajectoryScore}`);
    });

    it('accurately scores modern leadership titles (Fractional CXO, Practice Lead, RevOps Head)', () => {
      const expModern = [
        { title: 'Fractional CMO', company: 'Growth Partners', description: 'GTM strategy' },
        { title: 'Head of RevOps and GTM', company: 'ScaleFlow', description: 'Revenue operations' },
        { title: 'Practice Lead & Principal Consultant', company: 'Cloud Solutions', description: 'Advisory' }
      ];
      const dcr = computeCareerTrajectoryDCR(expModern, ['growth', 'revops']);
      assert.ok(dcr.trajectoryScore >= 8.0, `Modern leadership score should be >= 8.0, got ${dcr.trajectoryScore}`);
    });
  });

  describe('Global Corporate Form & Branch Normalization (normalizeCompanyName)', () => {
    it('strips global corporate suffixes and regional indicators', () => {
      assert.equal(normalizeCompanyName('Acme Solutions S.R.L.'), 'acme solutions');
      assert.equal(normalizeCompanyName('BioTech Innovations S.A.S.'), 'biotech innovations');
      assert.equal(normalizeCompanyName('Apex Ventures AG'), 'apex ventures');
      assert.equal(normalizeCompanyName('CloudScale Pte Ltd'), 'cloudscale');
      assert.equal(normalizeCompanyName('DataCorp Sdn Bhd'), 'datacorp');
      assert.equal(normalizeCompanyName('Nordic Software Sp. z o.o.'), 'nordic software');
      assert.equal(normalizeCompanyName('Pacific Media Pty Ltd'), 'pacific media');
      assert.equal(normalizeCompanyName('Fintech Global EMEA'), 'fintech');
      assert.equal(normalizeCompanyName('Alpha Tech Holdings Group'), 'alpha tech');
    });
  });

  describe('Site Probing Signal Extraction (extractSiteSignals)', () => {
    it('extracts pricing models, tech stack badges, case studies, and open roles from scraped web markdown', () => {
      const sampleMarkdown = `
# Acme B2B Solutions
We help high-growth SaaS scale customer acquisition.

## Pricing
Plans start at $2,500 / month with custom pricing for enterprise clients.

## Tech Stack & Integrations
We seamlessly integrate with HubSpot, Salesforce, Stripe, Next.js, and Zapier.

## Case Studies
Case Studies: How we drove 400% pipeline growth for FinTech Alpha.

## Join Our Team
We're hiring Senior Fullstack Engineers and Product Designers in Austin, TX!
      `;

      const signals = extractSiteSignals(sampleMarkdown);
      assert.ok(signals !== null, 'Signals should be extracted');
      assert.ok(signals?.pricingModel?.includes('$2,500') || signals?.pricingModel?.includes('pricing'));
      assert.ok(signals?.techStack?.includes('hubspot'));
      assert.ok(signals?.techStack?.includes('salesforce'));
      assert.ok(signals?.caseStudies?.includes('FinTech Alpha'));
      assert.ok(signals?.openRoles?.includes('Senior Fullstack Engineers') || signals?.openRoles?.includes('hiring'));
    });
  });
});

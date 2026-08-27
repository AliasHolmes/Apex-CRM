import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanyRegistry,
  companiesMatch,
  SignalStore
} from '../server/leadSearch/signalStore.js';

describe('Optimization 3 & 4: Company Entity Resolution & Anchored Flywheel', () => {
  const originalEntityEnv = process.env.COMPANY_ENTITY_REGISTRY_ENABLED;
  const originalFlywheelEnv = process.env.ANCHORED_FLYWHEEL_QUERIES_ENABLED;

  afterEach(() => {
    if (originalEntityEnv === undefined) {
      delete process.env.COMPANY_ENTITY_REGISTRY_ENABLED;
    } else {
      process.env.COMPANY_ENTITY_REGISTRY_ENABLED = originalEntityEnv;
    }

    if (originalFlywheelEnv === undefined) {
      delete process.env.ANCHORED_FLYWHEEL_QUERIES_ENABLED;
    } else {
      process.env.ANCHORED_FLYWHEEL_QUERIES_ENABLED = originalFlywheelEnv;
    }
  });

  describe('CompanyRegistry', () => {
    it('normalizes international legal suffixes and URLs to domain stems', () => {
      const e1 = CompanyRegistry.resolve('Stripe Payments Europe, Ltd.');
      const e2 = CompanyRegistry.resolve('https://www.stripe.com/about');
      assert.equal(e1.normalizedName, 'stripe payments europe');
      assert.equal(e2.domainStem, 'stripe');
      assert.equal(e2.normalizedName, 'stripe');
    });

    it('matches company variations with shared domain stems or legal suffixes', () => {
      const match = CompanyRegistry.areEquivalent('Acme Corp LLC', 'Acme Corporation Ltd');
      assert.equal(match, true);
    });

    it('prevents short brand collisions (e.g. "Box" vs "Boxed" or "Go" vs "Google")', () => {
      const match = CompanyRegistry.areEquivalent('Box', 'Boxed');
      assert.equal(match, false, 'Short brands must not collide');
    });

    it('integrates with companiesMatch when COMPANY_ENTITY_REGISTRY_ENABLED is true', () => {
      process.env.COMPANY_ENTITY_REGISTRY_ENABLED = 'true';
      const match = companiesMatch('Apex Studio GmbH', 'https://apexstudio.io');
      assert.equal(match, true, 'Domain stem matching should connect Apex Studio GmbH to apexstudio.io');
    });
  });

  describe('SignalStore Anchored Flywheel Queries', () => {
    it('returns bare company name in legacy mode', () => {
      process.env.ANCHORED_FLYWHEEL_QUERIES_ENABLED = 'false';
      const store = new SignalStore();
      store.add({
        companyName: 'Apex Studio',
        text: 'We are hiring React engineers in Austin, Texas.',
        url: 'https://apexstudio.io/careers',
        round: 1,
        query: 'react hiring',
        lane: 'signal',
        confidence: 0.9,
        provider: 'tavily',
        category: 'hiring'
      });

      const terms = store.getAnchoredQueryTerms('Apex Studio');
      assert.deepEqual(terms, ['Apex Studio']);
    });

    it('returns anchored location terms when ANCHORED_FLYWHEEL_QUERIES_ENABLED is true', () => {
      process.env.ANCHORED_FLYWHEEL_QUERIES_ENABLED = 'true';
      const store = new SignalStore();
      store.add({
        companyName: 'Apex Studio',
        text: 'We are hiring React engineers in Austin, Texas.',
        url: 'https://apexstudio.io/careers',
        round: 1,
        query: 'react hiring',
        lane: 'signal',
        confidence: 0.9,
        provider: 'tavily',
        category: 'hiring'
      });

      const terms = store.getAnchoredQueryTerms('Apex Studio');
      assert.ok(terms.length >= 2);
      assert.equal(terms[0], 'Apex Studio');
      assert.ok(terms[1].includes('Austin'));
    });
  });
});

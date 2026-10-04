import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  looksLikeCompanyHint,
  extractCompanyHintDeterministic,
  extractCompanyHintFromProfile,
  companyEqualsLocation,
  cleanCompanyNameFromUrlOrTitle,
  type FusedObservation
} from '../server/leadSearch/observations.ts';

const makeObs = (overrides: Partial<FusedObservation>): FusedObservation => ({
  identityKey: 'url:https://example.com',
  title: '',
  url: 'https://example.com',
  content: '',
  provider: 'tavily',
  query: 'test',
  sourceProviders: ['tavily'],
  sourceQueries: ['test'],
  lanes: ['signal'],
  lane: 'signal',
  round: 1,
  corroborated: false,
  sourceCount: 1,
  raw: {},
  ...overrides
});

describe('Phase 1.1: looksLikeCompanyHint & company extraction heuristics', () => {
  it('accepts lowercase-start and mixed-case brand names (eBay, iRobot, n8n, monday.com)', () => {
    assert.equal(looksLikeCompanyHint('eBay'), true);
    assert.equal(looksLikeCompanyHint('iRobot'), true);
    assert.equal(looksLikeCompanyHint('n8n'), true);
    assert.equal(looksLikeCompanyHint('monday.com'), true);
    assert.equal(looksLikeCompanyHint('zapier'), true);
    assert.equal(looksLikeCompanyHint('openai'), true);
  });

  it('keeps "make" blocked as an ambiguous common English verb/noun', () => {
    assert.equal(looksLikeCompanyHint('make'), false);
    assert.equal(looksLikeCompanyHint('Make'), false);
  });

  it('accepts legitimate company names containing words like Work, Role, News, or Guide', () => {
    assert.equal(looksLikeCompanyHint('Work & Co'), true);
    assert.equal(looksLikeCompanyHint('Role Models Inc'), true);
    assert.equal(looksLikeCompanyHint('News Corp'), true);
    assert.equal(looksLikeCompanyHint('Guidewire Software'), true);
  });

  it('rejects Reddit paths, questions, conversational fragments, and whole-string page-type phrases', () => {
    assert.equal(looksLikeCompanyHint('how to scale'), false);
    assert.equal(looksLikeCompanyHint('r/sales'), false);
    assert.equal(looksLikeCompanyHint('/r/curtin'), false);
    assert.equal(looksLikeCompanyHint('What is Acme?'), false);
    assert.equal(looksLikeCompanyHint('Hiring now'), false);
    assert.equal(looksLikeCompanyHint('Open roles'), false);
    assert.equal(looksLikeCompanyHint('Company news'), false);
    assert.equal(looksLikeCompanyHint('About us'), false);
    assert.equal(looksLikeCompanyHint('Careers page'), false);
    assert.equal(looksLikeCompanyHint('Senior engineer role open for immediate work today'), false);
  });

  it('rejects bare geographic names via shared GENERIC_GEO_NAMES', () => {
    assert.equal(looksLikeCompanyHint('Sydney'), false);
    assert.equal(looksLikeCompanyHint('Auckland'), false);
    assert.equal(looksLikeCompanyHint('United States'), false);
    assert.equal(looksLikeCompanyHint('London'), false);
    assert.equal(looksLikeCompanyHint('San Francisco'), false);
  });

  it('extracts lowercase brand and domain hints in extractCompanyHintDeterministic and extractCompanyHintFromProfile', () => {
    const leverObs = makeObs({
      title: 'Senior Backend Engineer',
      url: 'https://jobs.lever.co/stripe/12345',
      content: 'Join our payments engineering team.'
    });
    assert.equal(extractCompanyHintDeterministic(leverObs), 'stripe');

    const ebayHiringObs = makeObs({
      title: 'eBay is hiring Staff AI Engineers',
      url: 'https://example.org/post',
      content: 'eBay is actively hiring engineers in Austin.'
    });
    assert.equal(extractCompanyHintDeterministic(ebayHiringObs), 'eBay');

    const profileObs = makeObs({
      title: 'Alex Morgan | LinkedIn',
      url: 'https://www.linkedin.com/in/alex-morgan',
      content: 'VP of Engineering at iRobot | Robotics & AI'
    });
    assert.equal(extractCompanyHintFromProfile(profileObs), 'iRobot');
  });

  it('rejects URLs and bare domains in looksLikeCompanyHint', () => {
    assert.equal(looksLikeCompanyHint('https://www.dataleadershipgroup.ai/'), false);
    assert.equal(looksLikeCompanyHint('http://acme.org'), false);
    assert.equal(looksLikeCompanyHint('www.company.com'), false);
    assert.equal(looksLikeCompanyHint('myfirm.ai/'), false);
  });

  it('detects when company string equals a location segment via companyEqualsLocation', () => {
    assert.equal(companyEqualsLocation('The Villages', 'The Villages, Florida, United States'), true);
    assert.equal(companyEqualsLocation('Chicago', 'Greater Chicago Area, Illinois'), true);
    assert.equal(companyEqualsLocation('Denver', 'Denver Metropolitan Area'), true);
    assert.equal(companyEqualsLocation('Acme Austin', 'Austin, Texas'), false);
    assert.equal(companyEqualsLocation('Chicago AI Lab', 'Chicago, Illinois'), false);
    assert.equal(companyEqualsLocation('Data Leadership Group', 'Columbia, Maryland'), false);
  });

  it('cleans URL companies or recovers name from headline via cleanCompanyNameFromUrlOrTitle', () => {
    assert.equal(
      cleanCompanyNameFromUrlOrTitle(
        'https://www.dataleadershipgroup.ai/',
        'LinkedIn Top Voice | Founder of Data Leadership Group (Data Scientist)'
      ),
      'Data Leadership Group'
    );
    assert.equal(
      cleanCompanyNameFromUrlOrTitle('https://www.dataleadershipgroup.ai/', ''),
      'Dataleadershipgroup'
    );
    assert.equal(
      cleanCompanyNameFromUrlOrTitle('Acme Technologies', 'CEO at Acme Technologies'),
      'Acme Technologies'
    );
  });
});

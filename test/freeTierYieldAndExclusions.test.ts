import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicProspectContract, enforceContractQueries } from '../server/leadSearch/prospectContract.js';
import { checkStrictContradiction } from '../server/leadSearch/finalistJudge.js';
import { extractPostSnippets, buildLinkedInPostSearchQuery } from '../server/leadSearch/linkedinPostIntent.js';

test('buildDeterministicProspectContract expands company_type for AI business and does not inject negative search operators', () => {
  const brief = 'I want to find AI business and service provider founders in Manchester';
  const contract = buildDeterministicProspectContract(brief);

  // 1. Verify acceptableTerms for company_type includes business and agency synonyms
  const companyTypeReq = contract.requirements.find(r => r.scope === 'company_type' && r.importance === 'hard');
  assert.ok(companyTypeReq, 'Should have company_type requirement');
  assert.ok(companyTypeReq.acceptableTerms && companyTypeReq.acceptableTerms.length > 0);
  assert.ok(
    companyTypeReq.acceptableTerms.some(t => /business|agency|consult/i.test(t)),
    'acceptableTerms should contain business/agency/consult',
  );

  // 2. Verify contract exclusions do not contain hyphenated search operators
  for (const exclusion of contract.exclusions) {
    assert.equal(
      exclusion.startsWith('-'),
      false,
      `Exclusion '${exclusion}' should not start with hyphen`,
    );
  }
});

test('buildDeterministicProspectContract strips trailing location prepositions from company types', () => {
  const brief = 'Find founders of AI agencies and consultancies in Manchester';
  const contract = buildDeterministicProspectContract(brief);

  const companyTypeReq = contract.requirements.find(r => r.scope === 'company_type' && r.importance === 'hard');
  assert.ok(companyTypeReq, 'Should have company_type requirement');
  assert.equal(companyTypeReq.sourcePhrase, 'AI agencies');
  assert.ok(!companyTypeReq.sourcePhrase.includes('Manchester'), 'sourcePhrase should not include location');
  assert.ok(companyTypeReq.acceptableTerms.includes('AI agencies'));
  assert.ok(companyTypeReq.acceptableTerms.includes('consultancies'));
  assert.ok(companyTypeReq.acceptableTerms.includes('AI agencies and consultancies'));
});

test('enforceContractQueries does not inject -software -platform -SaaS into client-service queries', () => {
  const brief = 'Find founders of AI agencies and consultancies in Manchester';
  const contract = buildDeterministicProspectContract(brief);
  const rawQueries = [
    'site:linkedin.com/in/ "AI agency" founder Manchester',
    'site:linkedin.com/in/ "AI consulting" CEO Manchester',
  ];

  const enforced = enforceContractQueries(rawQueries, contract);
  for (const item of enforced) {
    const q = item.query;
    assert.equal(
      q.includes('-software'),
      false,
      `Query '${q}' should not contain negative operator -software`,
    );
    assert.equal(
      q.includes('-platform'),
      false,
      `Query '${q}' should not contain negative operator -platform`,
    );
    assert.equal(
      q.includes('-SaaS') || q.includes('-saas'),
      false,
      `Query '${q}' should not contain negative operator -saas`,
    );
  }
});

test('finalistJudge checkStrictContradiction does not disqualify agency founders serving SaaS clients', () => {
  const contract = buildDeterministicProspectContract('Find AI agency founders and consultancies');
  
  const agencyFounderLead = {
    fullName: 'Jane Doe',
    headline: 'Founder at Apex Automation | Helping SaaS companies scale with AI workflows',
    currentTitle: 'Founder & CEO',
    currentCompany: 'Apex Automation',
    company: 'Apex Automation',
    evidenceReasons: ['Founder of AI agency', 'Helping SaaS companies automate'],
    evidence: {
      evidenceBlock: 'Apex Automation is a boutique I implementation agency for B2B SaaS businesses.',
    },
  };

  const contradiction = checkStrictContradiction(agencyFounderLead, contract);
  assert.equal(contradiction, null, 'Agency founder serving SaaS clients should not be flagged as contradiction');
});

test('LinkedIn post intent relies on SERP snippets and excludes authwalled markdown scrape', () => {
  const query = buildLinkedInPostSearchQuery({
    fullName: 'Alex Mercer',
    company: 'Cognitive Solutions',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/alex-mercer' }
  });

  assert.ok(query.startsWith('site:linkedin.com'), 'Should target site:linkedin.com');
  assert.ok(query.includes('alex-mercer'), 'Should query by handle');

  const mockSerpResults = [
    {
      title: 'Alex Mercer on LinkedIn: We are expanding our AI engineering team',
      url: 'https://www.linkedin.com/posts/alex-mercer_ai-engineering-hiring-activity-12345',
      content: 'Excited to share that Cognitive Solutions is hiring 3 Senior AI Engineers to build agentic workflows.',
      sourceProvider: 'brightdata_search' as const,
    }
  ];

  const extracted = extractPostSnippets(mockSerpResults);
  assert.equal(extracted.snippets.length, 1);
  assert.ok(extracted.snippets[0].includes('Cognitive Solutions is hiring'));
  assert.equal(extracted.firstUrl, 'https://www.linkedin.com/posts/alex-mercer_ai-engineering-hiring-activity-12345');
});

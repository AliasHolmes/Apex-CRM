import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeterministicLinkedInProfile, extractSerpLocation } from '../server/leadSearch/stages/extractStage.js';

const url = 'https://uk.linkedin.com/in/jane-doe-123';
const parse = (title: string, content = '') => parseDeterministicLinkedInProfile({ url, title, content });

test('parses Name - Title - Company', () => {
  const p = parse('Jane Doe - Founder & CEO - Acme Corp | LinkedIn', 'London, England, United Kingdom \u00b7 Founder \u00b7 Acme Corp');
  assert.deepEqual(
    { name: p?.fullName, title: p?.currentTitle, company: p?.currentCompany, loc: p?.location, conf: p?.extractionConfidence },
    { name: 'Jane Doe', title: 'Founder & CEO', company: 'Acme Corp', loc: 'London, England, United Kingdom', conf: 8 },
  );
});

test('hands Name - Company titles to the LLM instead of treating the company as a title', () => {
  assert.equal(parse('Jane Doe - Acme Corp | LinkedIn'), null);
});

test('keeps pipe-separated headlines inside the title field', () => {
  const p = parse('Jane Doe - Founder | AI Automation | Speaker - Nimbus | LinkedIn');
  assert.equal(p?.currentTitle, 'Founder');
  assert.equal(p?.headline, 'Founder | AI Automation | Speaker');
  assert.equal(p?.currentCompany, 'Nimbus');
});

test('accepts en-dash separators and Name - Role at Company', () => {
  assert.equal(parse('Jane Doe \u2013 Head of Growth \u2013 Acme | LinkedIn')?.currentCompany, 'Acme');
  const p = parse('John Smith - Co-Founder at NextGen AI | LinkedIn');
  assert.equal(p?.currentTitle, 'Co-Founder');
  assert.equal(p?.currentCompany, 'NextGen AI');
  assert.equal(p?.extractionConfidence, 6);
});

test('only accepts place-like or explicitly labelled locations', () => {
  assert.equal(extractSerpLocation('Experience: Acme \u00b7 Location: Leeds \u00b7 500+ connections'), 'Leeds');
  assert.equal(extractSerpLocation('I help agencies scale with n8n. Based in Bristol.'), 'Bristol');
  assert.equal(extractSerpLocation('Growth leader in London tech \u00b7 500+ connections'), undefined);
  assert.equal(extractSerpLocation('Sales leader driving growth \u00b7 Acme'), undefined);
});

test('rejects non-profile URLs and name-only titles', () => {
  assert.equal(parseDeterministicLinkedInProfile({ url: 'https://www.linkedin.com/company/acme', title: 'Acme - Software - Acme | LinkedIn' }), null);
  assert.equal(parse('Jane Doe | LinkedIn'), null);
});

test('hands profile to LLM when parsed company name equals the location', () => {
  const p = parse(
    'Max Brown - AI Automation Agency Owner - The Villages | LinkedIn',
    'Location: The Villages, Florida, United States \u00b7 500+ connections'
  );
  assert.equal(p, null);
});


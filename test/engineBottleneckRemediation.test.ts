import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEvidenceHash } from '../server/leadSearch/candidateVerdicts.ts';
import { buildAccountFlywheelItems } from '../server/leadSearch/stages/planStage.ts';

test('evidence hash is stable for the same ids and lengths, regardless of wording or order', () => {
  const first = [
    { id: 'e0', text: 'Founder at Acme AI' },
    { id: 'e1', text: 'Automation agency serving local SMBs in Texas with a team of twelve people' },
  ];
  // Re-scraped profile: same evidence items, re-worded text of the same length.
  const rescraped = [
    { id: 'e1', text: 'Automation agency serving local SMBs in Texas with a team of twelve humans' },
    { id: 'e0', text: 'Founder at Acme AI' },
  ];
  assert.equal(computeEvidenceHash(first), computeEvidenceHash(rescraped));
});

test('evidence hash changes when the evidence shape changes', () => {
  const base = [
    { id: 'e0', text: 'Founder at Acme AI' },
    { id: 'e1', text: 'Automation agency serving local SMBs' },
  ];
  const extraItem = [...base, { id: 'e2', text: 'Hiring an automation specialist' }];
  const shorter = [base[0], { id: 'e1', text: 'Automation agency' }];
  const differentIds = [{ id: 'x0', text: base[0].text }];

  assert.notEqual(computeEvidenceHash(base), computeEvidenceHash(extraItem));
  assert.notEqual(computeEvidenceHash(base), computeEvidenceHash(shorter));
  assert.notEqual(computeEvidenceHash(base), computeEvidenceHash(differentIds));
});

test('evidence hash excludes company attribution and handles empty input', () => {
  const withAttr = [
    { id: 'e0', text: 'Founder at Acme AI' },
    { id: 'e_company_attr', text: 'client_services_agency | verified_fit' },
  ];
  const withoutAttr = [{ id: 'e0', text: 'Founder at Acme AI' }];
  assert.equal(computeEvidenceHash(withAttr), computeEvidenceHash(withoutAttr));
  assert.equal(computeEvidenceHash([]), '');
  assert.equal(computeEvidenceHash(undefined), '');
});

test('account flywheel items target the spec titles at signal companies with the account lane', () => {
  const spec: any = {
    person: { includeTitles: ['Founder', 'CEO', 'Managing Partner', 'CTO'] },
  };
  const items = buildAccountFlywheelItems(['Acme AI', 'Bright Loop', 'Tiny Co', ''], spec, 12);

  assert.equal(items.length, 3, 'company budget is min(3, floor(maxTasks/4))');
  assert.ok(items.every((item) => item.lane === 'account'));
  assert.ok(items.every((item) => item.family === 'company_type'));
  assert.ok(items.every((item) => item.intent === 'find_decision_makers'));
  assert.match(items[0].query, /"Acme AI" \(/);
  // Only the first three spec titles are used, short companies skipped.
  assert.ok(items[0].query.includes('"Founder"'));
  assert.ok(items[0].query.includes('"CEO"'));
  assert.ok(items[0].query.includes('"Managing Partner"'));
  assert.ok(!items[0].query.includes('"CTO"'));
});

test('account flywheel falls back to default titles when the spec has none', () => {
  const items = buildAccountFlywheelItems(['Acme AI'], { person: { includeTitles: [] } } as any, 4);
  assert.equal(items.length, 1);
  assert.match(items[0].query, /"founder"/i);
  assert.match(items[0].query, /"CEO"/);
  assert.match(items[0].query, /"owner"/);
});

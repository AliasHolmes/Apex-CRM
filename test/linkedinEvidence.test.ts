import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractLinkedInUsername, extractPublicEmail, normalizeLinkedInUrl, parseLinkedInEvidence } from '../server/services/linkedinEvidence.ts';

describe('linkedinEvidence', () => {
  it('normalizes LinkedIn profile URLs and usernames', () => {
    assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/in/Jane-Doe/?trk=public_profile'), 'linkedin.com/in/jane-doe');
    assert.equal(extractLinkedInUsername('https://linkedin.com/in/Jane-Doe/'), 'jane-doe');
  });

  it('extracts compact CRM evidence from useful markdown', () => {
    const markdown = `
# Jane Doe
Founder & CEO at Acme Dental Growth
Memphis, Tennessee, United States

## About
Building patient acquisition systems for dental practices and automating front-office follow-up.

## Experience
Founder & CEO
Acme Dental Growth
2021 - Present
Scaled clinic booking operations across 42 practices.

VP Growth
Previous Co
2018 - 2021

## Skills
Practice Growth
CRM
Appointment Setting
Operations

## Activity
Jane liked 400 posts that should not enter evidence.

## Recommendations
A very long recommendation that should be ignored.
`;

    const parsed = parseLinkedInEvidence(markdown, { title: 'Jane Doe - LinkedIn', url: 'https://linkedin.com/in/jane-doe/', snippet: 'Founder at Acme Dental Growth' });

    assert.equal(parsed.quality, 'good');
    assert.match(parsed.evidenceBlock, /NAME: Jane Doe/);
    assert.match(parsed.evidenceBlock, /HEADLINE: Founder & CEO at Acme Dental Growth/);
    assert.match(parsed.evidenceBlock, /EXPERIENCE:/);
    assert.doesNotMatch(parsed.evidenceBlock, /liked 400 posts/);
    assert.doesNotMatch(parsed.evidenceBlock, /Recommendations/);
  });

  it('rejects login wall markdown', () => {
    const parsed = parseLinkedInEvidence('Sign in to view Jane Doe profile on LinkedIn. Join LinkedIn today.', { title: 'Jane Doe' });
    assert.equal(parsed.quality, 'bad');
    assert.equal(parsed.rejectionReason, 'blocked_or_login_wall');
  });

  it('captures only explicitly published usable emails from profile evidence', () => {
    const markdown = `
# Jane Doe
Founder at Acme Dental Growth
Austin, TX, United States
Industry: Dental Technology

## About
Contact me at Jane.Doe@AcmeHealth.com for partnerships.

## Experience
Founder at Acme Dental Growth
2022 - Present
`;
    const parsed = parseLinkedInEvidence(markdown, { title: 'Jane Doe', url: 'https://linkedin.com/in/jane-doe' });
    assert.equal(parsed.publicEmail, 'jane.doe@acmehealth.com');
    assert.equal(parsed.industry, 'Dental Technology');
    assert.match(parsed.evidenceBlock, /EMAIL: jane\.doe@acmehealth\.com/);
    assert.equal(extractPublicEmail('Email: noreply@example.com'), undefined);
    assert.equal(extractPublicEmail('Email pattern: first.last@domain.com'), undefined);
  });
});

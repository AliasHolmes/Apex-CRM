import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProfileDedupeKeys,
  canonicalLinkedInIdentity,
  hasDuplicateProfile,
} from '../src/utils/leadDedupe.ts';

test('canonical LinkedIn identity collapses URL presentation variations', () => {
  const expected = 'linkedin:jane-doe-123';
  for (const value of [
    'https://www.linkedin.com/in/Jane-Doe-123/',
    'linkedin.com/in/jane-doe-123?trk=public_profile',
    'HTTP://uk.linkedin.com/in/jane-doe-123/#about',
  ]) {
    assert.equal(canonicalLinkedInIdentity(value), expected);
  }
});

test('only public LinkedIn profile URLs produce a persisted identity', () => {
  assert.equal(canonicalLinkedInIdentity('https://www.linkedin.com/company/acme'), '');
  assert.equal(canonicalLinkedInIdentity('jane-doe-123'), '');
  assert.equal(canonicalLinkedInIdentity('https://linkedin.com/in/jane-doe-124'), 'linkedin:jane-doe-124');
});

test('different LinkedIn profiles do not fall back to a name/company collision', () => {
  const existing = {
    fullName: 'Jane Doe',
    currentCompany: 'Acme',
    contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-doe-one' },
  };
  const candidate = {
    fullName: 'Jane Doe',
    currentCompany: 'Acme',
    contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-doe-two' },
  };
  const keys = buildProfileDedupeKeys(existing);
  assert.equal(hasDuplicateProfile(candidate, keys), false);
});

test('buildProfileDedupeKeys extracts keys from both nested profile wrappers and flat lead shapes', () => {
  const nestedLead = {
    id: 'lead-1',
    profile: {
      fullName: 'Alex Vance',
      currentCompany: 'FlowState AI',
      contactDetails: {
        linkedinUrl: 'https://www.linkedin.com/in/alex-vance',
        email: 'alex@flowstate.ai'
      }
    }
  };

  const flatLead = {
    id: 'lead-2',
    fullName: 'Alex Vance',
    currentCompany: 'FlowState AI',
    contactDetails: {
      linkedinUrl: 'https://www.linkedin.com/in/alex-vance',
      email: 'alex@flowstate.ai'
    }
  };

  const directPropsLead = {
    id: 'lead-3',
    name: 'Alex Vance',
    company: 'FlowState AI',
    linkedinUrl: 'https://www.linkedin.com/in/alex-vance',
    email: 'alex@flowstate.ai'
  };

  const nestedKeys = buildProfileDedupeKeys(nestedLead);
  const flatKeys = buildProfileDedupeKeys(flatLead);
  const directKeys = buildProfileDedupeKeys(directPropsLead);

  assert.ok(nestedKeys.has('linkedin:alex-vance'));
  assert.ok(nestedKeys.has('email:alex@flowstate.ai'));
  assert.ok(flatKeys.has('linkedin:alex-vance'));
  assert.ok(flatKeys.has('email:alex@flowstate.ai'));
  assert.ok(directKeys.has('linkedin:alex-vance'));
  assert.ok(directKeys.has('email:alex@flowstate.ai'));

  assert.equal(hasDuplicateProfile(flatLead, nestedKeys), true);
  assert.equal(hasDuplicateProfile(nestedLead, flatKeys), true);
  assert.equal(hasDuplicateProfile(directPropsLead, nestedKeys), true);
});


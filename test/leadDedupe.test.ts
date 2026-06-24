import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileDedupeKeys, hasDuplicateProfile } from '../src/utils/leadDedupe';
import type { LinkedInProfile } from '../src/types';

const profile = (overrides: Partial<LinkedInProfile>): LinkedInProfile => ({
  id: overrides.id || 'p-1',
  fullName: overrides.fullName || 'Jane Smith',
  currentCompany: overrides.currentCompany || 'North Star Dental',
  currentTitle: overrides.currentTitle || 'Practice Owner',
  contactDetails: overrides.contactDetails || {},
});

test('dedupe keys normalize LinkedIn profile handles', () => {
  const existing = profile({ contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/jane-smith/' } });
  const incoming = profile({ id: 'p-2', contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-smith?trk=public' } });
  const keys = buildProfileDedupeKeys(existing);
  assert.equal(hasDuplicateProfile(incoming, keys), true);
});

test('dedupe catches same person at same company with missing email', () => {
  const existing = profile({ fullName: 'Jane Smith', currentCompany: 'North Star Dental' });
  const incoming = profile({ id: 'p-2', fullName: ' jane smith ', currentCompany: 'NORTH STAR DENTAL' });
  const keys = buildProfileDedupeKeys(existing);
  assert.equal(hasDuplicateProfile(incoming, keys), true);
});

test('dedupe catches same person by website/email domain', () => {
  const existing = profile({ contactDetails: { website: 'https://www.northstardental.com' } });
  const incoming = profile({ id: 'p-2', contactDetails: { email: 'jane@northstardental.com' } });
  const keys = buildProfileDedupeKeys(existing);
  assert.equal(hasDuplicateProfile(incoming, keys), true);
});
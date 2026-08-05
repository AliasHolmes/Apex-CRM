import type { LinkedInProfile } from '../types';

export const normalizeDedupeValue = (value?: string) =>
  (value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .trim();

export const getLinkedInHandle = (url?: string) => {
  const normalized = normalizeDedupeValue(url);
  const match = normalized.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (match?.[1]) return match[1].toLowerCase();
  if (normalized && !normalized.includes('/') && !normalized.includes('linkedin.com')) return normalized;
  return '';
};

/**
 * The stable identity used for a real LinkedIn public profile. This is
 * deliberately narrower than getLinkedInHandle(): a bare string may be useful
 * for search inputs, but it must never become a persisted identity key.
 */
export const canonicalLinkedInIdentity = (url?: string) => {
  const normalized = normalizeDedupeValue(url);
  if (!/linkedin\.com\/in\//i.test(normalized)) return '';
  const handle = getLinkedInHandle(normalized);
  return handle ? `linkedin:${handle}` : '';
};

export const getProfileDomain = (profile?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!profile || typeof profile !== 'object') return '';
  const website = profile.contactDetails?.website;
  if (website) return normalizeDedupeValue(website).split('/')[0];
  const email = profile.contactDetails?.email;
  if (email && typeof email === 'string' && email.includes('@')) return email.toLowerCase().split('@')[1];
  return '';
};

export const buildProfileDedupeKeys = (profile?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!profile || typeof profile !== 'object') return new Set<string>();
  const keys = new Set<string>();
  const email = normalizeDedupeValue(profile.contactDetails?.email);
  const linkedinIdentity = canonicalLinkedInIdentity(profile.contactDetails?.linkedinUrl);
  const name = normalizeDedupeValue(profile.fullName);
  const company = normalizeDedupeValue(profile.currentCompany);
  const domain = getProfileDomain(profile);

  if (email) keys.add(`email:${email}`);
  if (linkedinIdentity) keys.add(linkedinIdentity);
  // A real LinkedIn profile is the authoritative person identity. Name and
  // company fallbacks are only for profiles without that stable identifier.
  if (!linkedinIdentity && name && company) keys.add(`name_company:${name}::${company}`);
  if (!linkedinIdentity && name && domain) keys.add(`name_domain:${name}::${domain}`);
  return keys;
};

export const hasDuplicateProfile = (profile: Partial<LinkedInProfile> | Record<string, any>, existingKeys: Set<string>) => {
  for (const key of buildProfileDedupeKeys(profile)) {
    if (existingKeys.has(key)) return true;
  }
  return false;
};

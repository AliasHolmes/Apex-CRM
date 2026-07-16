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
  const linkedinHandle = getLinkedInHandle(profile.contactDetails?.linkedinUrl);
  const name = normalizeDedupeValue(profile.fullName);
  const company = normalizeDedupeValue(profile.currentCompany);
  const domain = getProfileDomain(profile);

  if (email) keys.add(`email:${email}`);
  if (linkedinHandle) keys.add(`linkedin:${linkedinHandle}`);
  if (name && company) keys.add(`name_company:${name}::${company}`);
  if (name && domain) keys.add(`name_domain:${name}::${domain}`);
  return keys;
};

export const hasDuplicateProfile = (profile: Partial<LinkedInProfile> | Record<string, any>, existingKeys: Set<string>) => {
  for (const key of buildProfileDedupeKeys(profile)) {
    if (existingKeys.has(key)) return true;
  }
  return false;
};
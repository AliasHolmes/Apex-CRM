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

export const getProfileDomain = (input?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, any>;
  const p = record.profile && typeof record.profile === 'object' ? (record.profile as Record<string, any>) : record;
  const cd = (p.contactDetails && typeof p.contactDetails === 'object' ? p.contactDetails : undefined) ||
             (record.contactDetails && typeof record.contactDetails === 'object' ? record.contactDetails : {});
  const website = cd.website || record.website || p.website;
  if (website) return normalizeDedupeValue(website).split('/')[0];
  const email = cd.email || record.email || p.email;
  if (email && typeof email === 'string' && email.includes('@')) return email.toLowerCase().split('@')[1];
  return '';
};

export const buildProfileDedupeKeys = (input?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!input || typeof input !== 'object') return new Set<string>();
  const record = input as Record<string, any>;
  const p = record.profile && typeof record.profile === 'object' ? (record.profile as Record<string, any>) : record;
  const cd = (p.contactDetails && typeof p.contactDetails === 'object' ? p.contactDetails : undefined) ||
             (record.contactDetails && typeof record.contactDetails === 'object' ? record.contactDetails : {});
  const email = normalizeDedupeValue(cd.email || record.email || p.email);
  const linkedinIdentity = canonicalLinkedInIdentity(
    cd.linkedinUrl || record.linkedinUrl || p.linkedinUrl || record.sourceUrl || p.sourceUrl
  );
  const name = normalizeDedupeValue(p.fullName || record.fullName || p.name || record.name);
  const company = normalizeDedupeValue(p.currentCompany || record.currentCompany || p.company || record.company);
  const domain = getProfileDomain(input);

  const keys = new Set<string>();
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

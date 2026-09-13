import type { LinkedInProfile } from '../types';

export const normalizeDedupeValue = (value?: string) =>
  (value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .trim();

export function unwrapRedirectUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let current = rawUrl.trim();

  if (current.startsWith('/goto?') || current.startsWith('/url?')) {
    current = `https://brightdata.com${current}`;
  }

  for (let iter = 0; iter < 3; iter++) {
    const redirectParamMatch =
      current.match(/[?&](?:url|q|dest|target|redirect_to|redirect_url)=([^&]+)/i) ||
      current.match(/\/goto\?url=([^&]+)/i);

    if (redirectParamMatch && redirectParamMatch[1]) {
      try {
        const decoded = decodeURIComponent(redirectParamMatch[1]);
        if (decoded && (decoded.startsWith('http') || decoded.includes('linkedin.com') || decoded.startsWith('/'))) {
          current = decoded.startsWith('/') ? `https://brightdata.com${decoded}` : decoded;
          continue;
        }
      } catch {}
    }

    if (current.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(current);
        if (/linkedin\.com/i.test(decoded)) {
          const match = decoded.match(/(https?:\/\/[^\s"'<>)]*linkedin\.com[^\s"'<>)]*)/i);
          if (match && match[1]) {
            current = match[1];
            continue;
          }
        }
      } catch {}
    }

    break;
  }

  return current;
}

const RESERVED_LINKEDIN_PATHS = new Set([
  'feed', 'posts', 'pulse', 'in', 'jobs', 'company', 'school', 'learning',
  'groups', 'events', 'login', 'signup', 'help', 'about', 'legal', 'search',
  'home', 'messaging', 'notifications', 'newsletters', 'mwlite', 'check', 'biz',
  'activity', 'salary', 'showcase', 'services', 'hire', 'profinder'
]);

export function isValidLinkedInHandle(handle: string): boolean {
  if (!handle || typeof handle !== 'string') return false;
  const clean = handle.trim().replace(/[.,;:)\]]+$/, '').toLowerCase();
  if (clean.length < 2 || clean.length > 100) return false;
  if (RESERVED_LINKEDIN_PATHS.has(clean)) return false;
  if (/^activity(?:[-_]|\b)/i.test(clean)) return false;
  if (/^\d+$/.test(clean)) return false;
  return /^[a-z0-9\u0080-\uffff](?:[a-z0-9_.\u0080-\uffff-]*[a-z0-9\u0080-\uffff])?$/i.test(clean);
}

export const getLinkedInHandle = (url?: string) => {
  const unwrapped = unwrapRedirectUrl(url);
  const normalized = normalizeDedupeValue(unwrapped);
  const match = normalized.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (match?.[1]) {
    let rawSegment = match[1];
    try {
      rawSegment = decodeURIComponent(rawSegment);
    } catch {}
    rawSegment = rawSegment.replace(/[.,;:)\]]+$/, '').trim();
    const handle = rawSegment.toLowerCase();
    if (isValidLinkedInHandle(handle)) return handle;
  }

  const postMatch = normalized.match(/linkedin\.com\/posts\/([^/?#]+)/i);
  if (postMatch?.[1]) {
    let segment = postMatch[1];
    if (segment.includes('_')) {
      segment = segment.split('_')[0];
    } else if (segment.includes('-activity-')) {
      segment = segment.split('-activity-')[0];
    } else if (/-activity$/i.test(segment)) {
      segment = segment.replace(/-activity$/i, '');
    }
    const handle = segment.toLowerCase();
    if (isValidLinkedInHandle(handle)) return handle;
  }

  const pulseMatch = normalized.match(/linkedin\.com\/pulse\/([^/?#]+)/i);
  if (pulseMatch?.[1]) {
    const segment = pulseMatch[1];
    if (isValidLinkedInHandle(segment)) return segment.toLowerCase();
  }

  if (normalized && !normalized.includes('/') && !normalized.includes('linkedin.com') && isValidLinkedInHandle(normalized)) {
    return normalized;
  }
  return '';
};

/**
 * The stable identity used for a real LinkedIn public profile. This is
 * deliberately narrower than getLinkedInHandle(): a bare string may be useful
 * for search inputs, but it must never become a persisted identity key.
 */
export const canonicalLinkedInIdentity = (url?: string) => {
  const unwrapped = unwrapRedirectUrl(url);
  const normalized = normalizeDedupeValue(unwrapped);
  if (!/linkedin\.com\/(?:in|posts|pulse)\//i.test(normalized)) return '';
  const handle = getLinkedInHandle(unwrapped);
  return handle ? `linkedin:${handle}` : '';
};

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'mail.com', 'zoho.com', 'protonmail.com', 'proton.me', 'gmx.com', 'live.com'
]);

export const getProfileDomain = (input?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, any>;
  const p = record.profile && typeof record.profile === 'object' ? (record.profile as Record<string, any>) : record;
  const cd = (p.contactDetails && typeof p.contactDetails === 'object' ? p.contactDetails : undefined) ||
             (record.contactDetails && typeof record.contactDetails === 'object' ? record.contactDetails : {});
  const website = cd.website || record.website || p.website;
  if (website) return normalizeDedupeValue(website).split('/')[0];
  const email = cd.email || record.email || p.email;
  if (email && typeof email === 'string' && email.includes('@')) {
    const domain = email.toLowerCase().split('@')[1];
    if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
      return domain;
    }
  }
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

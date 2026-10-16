/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical blocklists of social networks, search engines, directories,
 * media/aggregators, and public email domains.
 * Consolidated single source of truth across siteProbe, companyDomainLookup,
 * companyIntent, observations, and db.
 */

export const SOCIAL_AND_SEARCH_DOMAINS = [
  'linkedin.com',
  'google.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'crunchbase.com',
  'glassdoor.com',
  'youtube.com',
  'github.com',
  'tiktok.com',
  'reddit.com',
  't.co',
  'bit.ly',
] as const;

export const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'protonmail.com',
] as const;

export const DIRECTORY_AND_MEDIA_DOMAINS = [
  // Social & Professional Networks
  'threads.net',
  // Job boards, ATS & Search Engines
  'indeed.com',
  'seek.com.au',
  'seek.co.nz',
  'bing.com',
  'duckduckgo.com',
  'angellist.com',
  'wellfound.com',
  'lever.co',
  'greenhouse.io',
  'ashbyhq.com',
  'workable.com',
  'ziprecruiter.com',
  'monster.com',
  'simplyhired.com',
  // Video, Media, News, Newsletters & Community Platforms
  'youtu.be',
  'vimeo.com',
  'medium.com',
  'substack.com',
  'quora.com',
  'wikipedia.org',
  'techcrunch.com',
  'forbes.com',
  'bloomberg.com',
  'businessinsider.com',
  'wsj.com',
  'nytimes.com',
  'reuters.com',
  'itbrew.com',
  'morningbrew.com',
  'seekout.com',
  // Developer, Review & Directory Sites
  'gitlab.com',
  'stackoverflow.com',
  'g2.com',
  'capterra.com',
  'trustpilot.com',
  'clutch.co',
  'yelp.com',
  'yellowpages.com',
  'zoominfo.com',
  'apollo.io',
  'pitchbook.com',
  'dnb.com',
  'owler.com',
] as const;

/**
 * Core set of social and search domains (including explicit www variants)
 * used by siteProbe and companyDomainLookup.
 */
export const CORE_BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  ...SOCIAL_AND_SEARCH_DOMAINS,
  ...SOCIAL_AND_SEARCH_DOMAINS.map(d => `www.${d}`),
]);

/**
 * Union of all non-company domains for observation extraction.
 */
export const ALL_OBSERVATION_BLOCKED_DOMAINS: readonly string[] = [
  ...SOCIAL_AND_SEARCH_DOMAINS,
  ...DIRECTORY_AND_MEDIA_DOMAINS,
];

/**
 * Common public platform & email domains used by db.ts extractValidCompanyDomain.
 */
export const COMMON_PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'github.com',
  'google.com',
  ...PUBLIC_EMAIL_DOMAINS,
  'reddit.com',
  'medium.com',
  'substack.com',
]);

/**
 * Checks whether a given host matches or is a subdomain of any blocked domain.
 */
export function isDomainOrSubdomainBlocked(
  host: string,
  blockedDomains: Iterable<string>
): boolean {
  if (!host) return true;
  const cleanHost = host.toLowerCase().replace(/^www\./, '');
  for (const domain of blockedDomains) {
    const cleanDomain = domain.toLowerCase().replace(/^www\./, '');
    if (cleanHost === cleanDomain || cleanHost.endsWith(`.${cleanDomain}`)) {
      return true;
    }
  }
  return false;
}

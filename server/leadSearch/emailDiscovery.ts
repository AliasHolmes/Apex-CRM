import dnsPromise from 'dns/promises';
import dnsSync from 'dns';
import https from 'https';
import http from 'http';
import net from 'node:net';

const dns = dnsPromise;

import {
  getEmailDiscoveryCacheEntry,
  upsertEmailDiscoveryCacheEntry,
  type EmailDiscoveryStatus
} from '../db.js';
import { brightDataSearch, classifyBrightDataError, scrapeBatchAsMarkdown, shouldAttemptBrightData } from '../services/brightdata.js';
import { hasTavilyKey, tavilyExtract, tavilySearch } from '../services/llm.js';
import { extractLinkedInUsername } from '../services/linkedinEvidence.js';
import { findCompanyWebsite } from './companyIntent.js';

export type EmailDiscoveryEvidence = {
  type: 'brightdata_batch' | 'brightdata_search' | 'tavily_extract' | 'tavily_search' | 'direct_fetch' | 'pattern' | 'dns' | 'cache';
  url?: string;
  email?: string;
  evidence: string;
};

export type EmailDiscoveryResult = {
  bestEmail?: string;
  status: EmailDiscoveryStatus;
  confidence: number;
  companyDomain?: string;
  mxValid?: boolean;
  sources: EmailDiscoveryEvidence[];
  fallbackChannels: {
    contactPage?: string;
    genericEmail?: string;
    website?: string;
    linkedinUrl?: string;
  };
};

export type DiscoverProspectEmailInput = {
  fullName?: string;
  currentCompany?: string;
  companyWebsite?: string;
  linkedinUrl?: string;
  title?: string;
  location?: string;
};

const CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/contact-us/',
  '/about',
  '/about-us',
  '/team',
  '/staff',
  '/people',
  '/leadership',
  '/management',
  '/company',
  '/our-team',
  '/team-members',
  '/directory',
  '/press',
  '/news',
  '/blog',
  '/careers',
  '/privacy',
  '/terms'
];

const GENERIC_PREFIXES = new Set([
  'info', 'hello', 'contact', 'sales', 'support', 'admin', 'office', 'team', 'careers',
  'jobs', 'press', 'media', 'marketing', 'billing', 'help', 'service', 'enquiries', 'inquiries',
  'noreply', 'no-reply', 'privacy', 'legal', 'abuse', 'webmaster'
]);

const DIRECTORY_DOMAINS = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com',
  'tiktok.com', 'crunchbase.com', 'zoominfo.com', 'apollo.io', 'rocketreach.co',
  'signalhire.com', 'hunter.io', 'lusha.com', 'clutch.co', 'upwork.com', 'glassdoor.com',
  'indeed.com', 'wikipedia.org', 'wikidata.org', 'bloomberg.com', 'reuters.com',
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com'
]);

const COMPANY_STOP_WORDS = new Set([
  'the', 'and', 'of', 'for', 'in', 'llc', 'inc', 'ltd', 'co', 'corp', 'corporation',
  'company', 'group', 'holdings', 'partners', 'services', 'solutions', 'systems', 'technologies',
  'technology', 'international', 'global', 'usa', 'us'
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAX_DIRECT_FETCH_BYTES = 512 * 1024;

const normalizeText = (value?: string) => (value || '').trim();
const normalizeKey = (value?: string) => normalizeText(value).toLowerCase();

function asUrl(value?: string) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    return new URL(text.startsWith('http://') || text.startsWith('https://') ? text : `https://${text}`);
  } catch {
    return null;
  }
}

function isPublicIpAddress(address: string) {
  if (net.isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return !(
      first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }

  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:'));
  }

  return false;
}

function isSafePublicHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return false;
  return net.isIP(normalized) ? isPublicIpAddress(normalized) : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized);
}

async function hostnameResolvesPublicly(hostname: string) {
  if (!isSafePublicHostname(hostname)) return false;
  if (net.isIP(hostname)) return isPublicIpAddress(hostname);

  const records = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = records.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  return addresses.length > 0 && addresses.every(isPublicIpAddress);
}

export function domainFromUrl(value?: string) {
  const url = asUrl(value);
  if (!url) return '';
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function companyTokens(value?: string) {
  return normalizeKey(value)
    .split(/[^a-z0-9]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 3 && !COMPANY_STOP_WORDS.has(part));
}

function rootDomain(domain: string) {
  const parts = domain.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function isDirectoryDomain(domain: string) {
  const root = rootDomain(domain);
  return DIRECTORY_DOMAINS.has(root) || Array.from(DIRECTORY_DOMAINS).some(blocked => root.endsWith(`.${blocked}`));
}

function selectCompanyWebsiteFromSearch(items: Array<{ title?: string; url?: string; content?: string }>, input: DiscoverProspectEmailInput) {
  const tokens = companyTokens(input.currentCompany);
  const person = normalizeKey(input.fullName);
  const scored = items
    .map(item => {
      const domain = domainFromUrl(item.url || '');
      if (!domain || isDirectoryDomain(domain)) return null;
      const haystack = normalizeKey(`${item.title || ''} ${item.url || ''} ${item.content || ''}`);
      const host = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
      const tokenHits = tokens.filter(token => haystack.includes(token) || host.includes(token)).length;
      const personHit = person && haystack.includes(person) ? 1 : 0;
      const score = tokenHits * 10 + personHit * 3 + (tokens.length > 0 && tokenHits === tokens.length ? 8 : 0);
      if (tokens.length > 0 && tokenHits === 0) return null;
      return { item, domain, score };
    })
    .filter((item): item is { item: { title?: string; url?: string; content?: string }; domain: string; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best ? { domain: best.domain, website: best.item.url || `https://${best.domain}` } : null;
}

function domainFromEmail(value?: string) {
  const email = normalizeKey(value);
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].replace(/^www\./, '') : '';
}

function sameDomain(email: string, domain: string) {
  const emailDomain = domainFromEmail(email);
  return emailDomain === domain || emailDomain.endsWith(`.${domain}`);
}

function buildLikelyContactUrls(domain: string) {
  const base = `https://${domain}`;
  return [base, ...CONTACT_PATHS.map(path => `${base}${path}`)];
}

function safeSnippet(text: string, email?: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!email) return clean.slice(0, 240);
  const index = clean.toLowerCase().indexOf(email.toLowerCase());
  if (index < 0) return clean.slice(0, 240);
  return clean.slice(Math.max(0, index - 100), Math.min(clean.length, index + email.length + 140));
}

function extractEmails(text: string) {
  const matches = text.match(EMAIL_RE) || [];
  return Array.from(new Set(matches.map(email => email.toLowerCase().replace(/[),.;:]+$/, ''))));
}

function personTokens(fullName?: string) {
  return normalizeKey(fullName)
    .split(/\s+/)
    .map(part => part.replace(/[^a-z]/g, ''))
    .filter(part => part.length >= 2);
}

function isGenericEmail(email: string) {
  return GENERIC_PREFIXES.has(email.split('@')[0].toLowerCase());
}

function scorePublicEmail(params: { email: string; text: string; url: string; fullName?: string; domain: string }) {
  const tokens = personTokens(params.fullName);
  const lowerText = normalizeKey(params.text);
  const local = params.email.split('@')[0].toLowerCase();
  const hasNameNearby = tokens.length > 0 && tokens.every(token => lowerText.includes(token));
  const localMatchesName = tokens.some(token => local.includes(token));
  const generic = isGenericEmail(params.email);

  if (hasNameNearby && localMatchesName && sameDomain(params.email, params.domain)) {
    return { status: 'confirmed_public' as const, confidence: 95 };
  }
  if (hasNameNearby && sameDomain(params.email, params.domain)) {
    return { status: 'confirmed_public' as const, confidence: 85 };
  }
  if (!generic && sameDomain(params.email, params.domain)) {
    return { status: 'company_public' as const, confidence: 70 };
  }
  if (generic && sameDomain(params.email, params.domain)) {
    return { status: 'domain_only' as const, confidence: 38 };
  }
  return { status: 'company_public' as const, confidence: 45 };
}

function inferPatternEmail(fullName: string | undefined, domain: string, knownEmails: string[]) {
  const tokens = personTokens(fullName);
  if (tokens.length < 2) return null;
  const [first, ...rest] = tokens;
  const last = rest[rest.length - 1];
  const personalLocals = Array.from(new Set(knownEmails
    .filter(email => sameDomain(email, domain) && !isGenericEmail(email))
    .map(email => email.split('@')[0].toLowerCase())
    .filter(local => /^[a-z][a-z._-]*[a-z0-9]$/.test(local))));

  if (personalLocals.length < 2) return null;

  const patternCounts = new Map<string, number>();
  for (const local of personalLocals) {
    if (/^[a-z]+\.[a-z]+$/.test(local)) patternCounts.set('first.last', (patternCounts.get('first.last') || 0) + 1);
    if (/^[a-z]+_[a-z]+$/.test(local)) patternCounts.set('first_last', (patternCounts.get('first_last') || 0) + 1);
    if (/^[a-z]+-[a-z]+$/.test(local)) patternCounts.set('first-last', (patternCounts.get('first-last') || 0) + 1);
    if (/^[a-z][a-z]+$/.test(local)) patternCounts.set('first', (patternCounts.get('first') || 0) + 1);
    if (/^[a-z][a-z]{2,}$/.test(local)) patternCounts.set('flast', (patternCounts.get('flast') || 0) + 1);
    if (/^[a-z]+[a-z]{3,}$/.test(local)) patternCounts.set('firstlast', (patternCounts.get('firstlast') || 0) + 1);
  }

  const best = Array.from(patternCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return null;

  const local = best[0] === 'first.last'
    ? `${first}.${last}`
    : best[0] === 'first_last'
      ? `${first}_${last}`
      : best[0] === 'first-last'
        ? `${first}-${last}`
        : best[0] === 'flast'
          ? `${first[0]}${last}`
          : best[0] === 'firstlast'
            ? `${first}${last}`
            : first;

  return `${local}@${domain}`;
}

async function hasValidMailServer(domain: string, timeoutMs = 5000) {
  if (!domain || !isSafePublicHostname(domain)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS MX lookup timed out')), timeoutMs);
      })
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fetchPage(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return resolve('');
    }

    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password
    ) {
      return resolve('');
    }

    // Reject non-standard ports - only 80 (http) and 443 (https) are expected for contact pages.
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') return resolve('');

    const mod = parsed.protocol === 'https:' ? https : http;

    // The lookup callback fires at socket connect time - AFTER DNS resolves but
    // BEFORE the TCP connection is established. This is the correct place to block
    // private/loopback IPs because there is no race between resolution and connect.
    const lookupGuard = (
      hostname: string,
      opts: dnsSync.LookupOptions,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
    ) => {
      dnsSync.lookup(hostname, { ...opts, all: false }, (err, address, family) => {
        if (err) return cb(err, '', 0);
        if (!isPublicIpAddress(address)) {
          const blocked = new Error(`SSRF_BLOCKED: Resolved IP ${address} for ${hostname} is private or loopback.`) as NodeJS.ErrnoException;
          blocked.code = 'EACCES';
          return cb(blocked, '', 0);
        }
        cb(null, address, family);
      });
    };

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      headers: { 'User-Agent': 'ApexCRM/1.0 contact discovery' },
      timeout: timeoutMs,
      lookup: lookupGuard
    };

    const req = mod.get(options as any, (res) => {
      const { statusCode = 0 } = res;
      // Only follow 2xx; do NOT follow redirects (manual redirect handling).
      if (statusCode < 200 || statusCode >= 300) {
        res.destroy();
        return resolve('');
      }
      const contentType = res.headers['content-type'] || '';
      if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('markdown')) {
        res.destroy();
        return resolve('');
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_DIRECT_FETCH_BYTES) {
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', () => resolve(''));
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EACCES') {
        // Only log unexpected errors; EACCES is our intentional SSRF block.
        console.debug('[fetchPage] Request error:', err.message);
      }
      resolve('');
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

async function asyncMapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).then(result => { results.push(result); });
    executing.add(task);
    task.finally(() => executing.delete(task));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}
async function resolveCompanyDomain(input: DiscoverProspectEmailInput, timeoutMs: number): Promise<{ domain: string; website: string; sources: EmailDiscoveryEvidence[] }> {
  const explicitDomain = domainFromUrl(input.companyWebsite);
  if (explicitDomain) {
    return {
      domain: explicitDomain,
      website: `https://${explicitDomain}`,
      sources: [{ type: 'direct_fetch', url: `https://${explicitDomain}`, evidence: `Used supplied company website domain ${explicitDomain}` }]
    };
  }

  if (!input.currentCompany) return { domain: '', website: '', sources: [] };

  const sources: EmailDiscoveryEvidence[] = [];
  try {
    const website = await findCompanyWebsite({
      companyName: input.currentCompany,
      location: input.location,
      brightDataSearch
    });
    const domain = domainFromUrl(website || '');
    if (domain) {
      sources.push({ type: 'brightdata_search', url: website || `https://${domain}`, evidence: `Resolved official company domain for ${input.currentCompany}` });
      return { domain, website: website || `https://${domain}`, sources };
    }
  } catch {
    // Continue with explicit SERP/Tavily domain resolution fallbacks.
  }

  const queries = Array.from(new Set([
    `"${input.currentCompany}" official website`,
    input.location ? `"${input.currentCompany}" "${input.location}" official website` : '',
    input.fullName ? `"${input.fullName}" "${input.currentCompany}"` : '',
    `"${input.currentCompany}" contact email`
  ].filter(Boolean)));
  const domainSearchLimit = clampNumber(process.env.EMAIL_DISCOVERY_DOMAIN_QUERY_LIMIT, 3, 1, 6);

  if (shouldAttemptBrightData()) {
    for (const query of queries.slice(0, domainSearchLimit)) {
      try {
        const results = await brightDataSearch(query, { timeoutMs });
        const selected = selectCompanyWebsiteFromSearch(results.slice(0, 8), input);
        if (selected) {
          sources.push({ type: 'brightdata_search', url: selected.website, evidence: `Resolved official company domain from query: ${query}` });
          return { ...selected, sources };
        }
      } catch {
        // Search provider failures should not block the rest of the waterfall.
      }
    }
  }

  if (hasTavilyKey()) {
    for (const query of queries.slice(0, domainSearchLimit)) {
      try {
        const search = await tavilySearch(query);
        const selected = selectCompanyWebsiteFromSearch(search.items.slice(0, 8), input);
        if (selected) {
          sources.push({ type: 'tavily_search', url: selected.website, evidence: `Resolved official company domain from query: ${query}` });
          return { ...selected, sources };
        }
      } catch {
        // Continue to no-domain result.
      }
    }
  }

  return { domain: '', website: '', sources };
}

function chooseBestResult(candidates: EmailDiscoveryResult[]) {
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

function fromCache(row: NonNullable<ReturnType<typeof getEmailDiscoveryCacheEntry>>): EmailDiscoveryResult {
  let evidence: EmailDiscoveryEvidence[] = [];
  try {
    evidence = JSON.parse(row.evidence || '[]');
  } catch {
    evidence = [{ type: 'cache', evidence: row.evidence || 'Cached email discovery result' }];
  }
  return {
    bestEmail: row.discoveredEmail,
    status: row.status,
    confidence: row.confidence,
    companyDomain: row.companyDomain,
    sources: [{ type: 'cache', evidence: 'Loaded from email discovery cache' }, ...evidence],
    fallbackChannels: row.companyDomain ? { website: `https://${row.companyDomain}` } : {}
  };
}

function hasStableCacheKey(input: DiscoverProspectEmailInput, linkedinUsername: string, domain?: string) {
  return Boolean(
    domain ||
    input.companyWebsite ||
    linkedinUsername ||
    (input.fullName && input.currentCompany)
  );
}

function writeEmailDiscoveryCache(
  input: DiscoverProspectEmailInput,
  linkedinUsername: string,
  result: EmailDiscoveryResult,
  ttlDays: number,
  normalizedUrl?: string
) {
  const domain = result.companyDomain || domainFromUrl(input.companyWebsite);
  if (!hasStableCacheKey(input, linkedinUsername, domain)) return;
  upsertEmailDiscoveryCacheEntry({
    normalizedUrl: normalizedUrl || input.companyWebsite,
    linkedinUsername,
    personName: input.fullName,
    companyName: input.currentCompany,
    companyDomain: domain,
    discoveredEmail: result.bestEmail,
    status: result.status,
    confidence: result.confidence,
    evidence: JSON.stringify(result.sources)
  }, ttlDays);
}

function buildEmailSearchQueries(input: DiscoverProspectEmailInput, domain: string) {
  return Array.from(new Set([
    input.fullName ? `"${input.fullName}" "@${domain}"` : '',
    input.fullName && input.currentCompany ? `"${input.fullName}" "${input.currentCompany}" email` : '',
    input.title && input.currentCompany ? `"${input.title}" "${input.currentCompany}" "@${domain}"` : '',
    `site:${domain} "@${domain}"`,
    input.fullName ? `site:${domain} "${input.fullName}"` : '',
    input.currentCompany ? `"${input.currentCompany}" email contact "@${domain}"` : `"${domain}" email contact "@${domain}"`
  ].filter(query => query.replace(/[^a-zA-Z0-9]/g, '').length > 8)));
}

export function applyEmailDiscoveryToLead<T extends Record<string, any>>(lead: T, result: EmailDiscoveryResult): T {
  const profile = lead.profile || lead;
  const contactDetails = {
    ...(profile.contactDetails || {}),
    ...(result.bestEmail ? { email: result.bestEmail } : {}),
    emailStatus: result.status,
    emailConfidence: result.confidence,
    emailSources: result.sources,
    fallbackChannels: result.fallbackChannels,
    ...(result.fallbackChannels.website && !profile.contactDetails?.website ? { website: result.fallbackChannels.website } : {})
  };

  if (lead.profile) {
    return {
      ...lead,
      profile: { ...profile, contactDetails },
      emailDiscovery: result
    };
  }

  return {
    ...lead,
    contactDetails,
    emailDiscovery: result
  };
}

export async function discoverProspectEmail(input: DiscoverProspectEmailInput): Promise<EmailDiscoveryResult> {
  const linkedinUsername = extractLinkedInUsername(input.linkedinUrl || '');
  const preliminaryDomain = domainFromUrl(input.companyWebsite);
  const cached = hasStableCacheKey(input, linkedinUsername, preliminaryDomain)
    ? getEmailDiscoveryCacheEntry({
      normalizedUrl: input.companyWebsite,
      linkedinUsername,
      personName: input.fullName,
      companyName: input.currentCompany,
      companyDomain: preliminaryDomain
    })
    : null;
  if (cached) return fromCache(cached);

  const ttlDays = Math.min(Math.max(Number(process.env.EMAIL_DISCOVERY_CACHE_TTL_DAYS || 14), 1), 60);
  const timeoutMs = Math.min(Math.max(Number(process.env.EMAIL_DISCOVERY_CRAWL_TIMEOUT_MS || 8000), 1000), 30000);
  const { domain, website, sources: domainEvidence } = await resolveCompanyDomain(input, timeoutMs);
  const mxValid = await hasValidMailServer(domain);
  const evidence: EmailDiscoveryEvidence[] = [...domainEvidence];
  if (domain) {
    evidence.push(mxValid
      ? { type: 'dns', evidence: `MX records found for ${domain}` }
      : { type: 'dns', evidence: `No MX records found for ${domain}` });
  }

  if (!domain) {
    const result: EmailDiscoveryResult = {
      status: 'not_found',
      confidence: 0,
      mxValid,
      sources: evidence,
      fallbackChannels: { linkedinUrl: input.linkedinUrl }
    };
    writeEmailDiscoveryCache(input, linkedinUsername, result, ttlDays, input.companyWebsite);
    return result;
  }

  const contactUrls = buildLikelyContactUrls(domain);
  const candidates: EmailDiscoveryResult[] = [];
  const knownEmails = new Set<string>();

  const inspectText = (text: string, url: string, type: EmailDiscoveryEvidence['type']) => {
    const emails = extractEmails(text).filter(email => sameDomain(email, domain));
    for (const email of emails) {
      knownEmails.add(email);
      const score = scorePublicEmail({ email, text, url, fullName: input.fullName, domain });
      const source = { type, url, email, evidence: safeSnippet(text, email) };
      candidates.push({
        bestEmail: email,
        status: score.status,
        confidence: mxValid ? score.confidence : Math.max(score.confidence - 15, 20),
        companyDomain: domain,
        mxValid,
        sources: [...evidence, source],
        fallbackChannels: {
          contactPage: contactUrls.find(candidate => candidate.includes('/contact')),
          genericEmail: isGenericEmail(email) ? email : undefined,
          website: website || `https://${domain}`,
          linkedinUrl: input.linkedinUrl
        }
      });
    }
  };

  const contactUrlLimit = clampNumber(process.env.EMAIL_DISCOVERY_CONTACT_URL_LIMIT, 12, 4, 20);
  const searchQueryLimit = clampNumber(process.env.EMAIL_DISCOVERY_BRIGHTDATA_QUERY_LIMIT, 5, 1, 10);
  const searchResultLimit = clampNumber(process.env.EMAIL_DISCOVERY_SEARCH_RESULT_LIMIT, 6, 2, 10);
  const publicQueries = buildEmailSearchQueries(input, domain);

  if (shouldAttemptBrightData()) {
    for (const query of publicQueries.slice(0, searchQueryLimit)) {
      try {
        const results = await brightDataSearch(query, { timeoutMs });
        for (const item of results.slice(0, searchResultLimit)) {
          inspectText(`${item.title}\n${item.content}`, item.url, 'brightdata_search');
        }
      } catch (error) {
        const classified = classifyBrightDataError(error);
        evidence.push({ type: 'brightdata_search', evidence: 'Bright Data search skipped: ' + classified.reasonCode });
        // Bright Data search is high value but optional; continue the waterfall on provider errors.
      }
    }
  }

  if (shouldAttemptBrightData()) {
    try {
      const brightDataResults = await scrapeBatchAsMarkdown(contactUrls.slice(0, contactUrlLimit), timeoutMs);
      for (const item of brightDataResults) inspectText(item.content, item.url, 'brightdata_batch');
    } catch (error) {
      const classified = classifyBrightDataError(error);
      evidence.push({ type: 'brightdata_batch', evidence: 'Bright Data contact-page batch skipped: ' + classified.reasonCode });
    }
  }

  if ((candidates.length === 0 || knownEmails.size < 2) && hasTavilyKey()) {
    try {
      const extracted = await tavilyExtract(contactUrls.slice(0, contactUrlLimit), 'email contact address staff team leadership privacy about', {
        extractDepth: 'basic',
        chunksPerSource: 5,
        timeout: Math.ceil(timeoutMs / 1000)
      });
      for (const item of extracted) inspectText(item.rawContent, item.url, 'tavily_extract');
    } catch {
      // Tavily is a lower-budget fallback; ignore provider failures and continue free local checks.
    }
  }

  if (candidates.length === 0 || knownEmails.size < 2) {
    const directFetches = await asyncMapLimit(contactUrls.slice(0, Math.min(contactUrlLimit, 8)), 3, async url => ({ url, text: await fetchPage(url, timeoutMs) }));
    for (const item of directFetches) {
      if (item.text) inspectText(item.text, item.url, 'direct_fetch');
    }
  }

  if ((candidates.length === 0 || knownEmails.size < 2) && hasTavilyKey()) {
    try {
      const search = await tavilySearch(publicQueries[0] || `"${input.fullName || input.currentCompany || domain}" "@${domain}" email OR contact`, [domain]);
      for (const item of search.items.slice(0, searchResultLimit)) {
        inspectText(`${item.title || ''}\n${item.content || ''}\n${item.raw_content || ''}`, item.url || '', 'tavily_search');
      }
    } catch {
      // Keep result deterministic when search quota is unavailable.
    }
  }

  const exactOrGeneric = chooseBestResult(candidates);
  let result = exactOrGeneric;

  if (!result) {
    const inferred = inferPatternEmail(input.fullName, domain, Array.from(knownEmails));
    if (inferred && mxValid) {
      result = {
        bestEmail: inferred,
        status: 'pattern_likely',
        confidence: 55,
        companyDomain: domain,
        mxValid,
        sources: [
          ...evidence,
          { type: 'pattern', email: inferred, evidence: `Generated from ${knownEmails.size} public same-domain emails. Not mailbox-verified.` }
        ],
        fallbackChannels: { website: website || `https://${domain}`, linkedinUrl: input.linkedinUrl }
      };
    }
  }

  if (!result) {
    result = {
      status: mxValid ? 'domain_only' : 'not_found',
      confidence: mxValid ? 20 : 0,
      companyDomain: domain,
      mxValid,
      sources: evidence,
      fallbackChannels: {
        contactPage: contactUrls.find(url => url.includes('/contact')),
        website: website || `https://${domain}`,
        linkedinUrl: input.linkedinUrl
      }
    };
  }

  writeEmailDiscoveryCache(input, linkedinUsername, result, ttlDays, website || input.companyWebsite);

  return result;
}

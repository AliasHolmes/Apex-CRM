import dns from 'dns/promises';

import {
  getEmailDiscoveryCacheEntry,
  upsertEmailDiscoveryCacheEntry,
  type EmailDiscoveryStatus
} from '../db.js';
import { brightDataSearch, scrapeBatchAsMarkdown } from '../services/brightdata.js';
import { tavilyExtract, tavilySearch } from '../services/llm.js';
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
  '/about',
  '/about-us',
  '/team',
  '/staff',
  '/people',
  '/leadership',
  '/management',
  '/press',
  '/news',
  '/careers'
];

const GENERIC_PREFIXES = new Set([
  'info', 'hello', 'contact', 'sales', 'support', 'admin', 'office', 'team', 'careers',
  'jobs', 'press', 'media', 'marketing', 'billing', 'help', 'service', 'enquiries', 'inquiries'
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

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

export function domainFromUrl(value?: string) {
  const url = asUrl(value);
  if (!url) return '';
  return url.hostname.toLowerCase().replace(/^www\./, '');
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
  const personalLocals = knownEmails
    .filter(email => sameDomain(email, domain) && !isGenericEmail(email))
    .map(email => email.split('@')[0].toLowerCase());

  if (personalLocals.length < 2) return null;

  const patternCounts = new Map<string, number>();
  for (const local of personalLocals) {
    if (/^[a-z]+\.[a-z]+$/.test(local)) patternCounts.set('first.last', (patternCounts.get('first.last') || 0) + 1);
    if (/^[a-z][a-z]+$/.test(local)) patternCounts.set('first', (patternCounts.get('first') || 0) + 1);
    if (/^[a-z][a-z]+$/.test(local) && local.length > 4) patternCounts.set('flast', (patternCounts.get('flast') || 0) + 1);
    if (/^[a-z]+_[a-z]+$/.test(local)) patternCounts.set('first_last', (patternCounts.get('first_last') || 0) + 1);
  }

  const best = Array.from(patternCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return null;

  const local = best === 'first.last'
    ? `${first}.${last}`
    : best === 'first_last'
      ? `${first}_${last}`
      : best === 'flast'
        ? `${first[0]}${last}`
        : first;

  return `${local}@${domain}`;
}

async function hasValidMailServer(domain: string) {
  if (!domain) return false;
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

async function fetchPage(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ApexCRM/1.0 contact discovery' }
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('markdown')) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCompanyDomain(input: DiscoverProspectEmailInput) {
  const explicitDomain = domainFromUrl(input.companyWebsite);
  if (explicitDomain) return { domain: explicitDomain, website: `https://${explicitDomain}` };

  if (!input.currentCompany) return { domain: '', website: '' };

  try {
    const website = await findCompanyWebsite({
      companyName: input.currentCompany,
      location: input.location,
      brightDataSearch
    });
    const domain = domainFromUrl(website || '');
    return { domain, website: website || (domain ? `https://${domain}` : '') };
  } catch {
    return { domain: '', website: '' };
  }
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
  const cached = getEmailDiscoveryCacheEntry({
    normalizedUrl: input.companyWebsite,
    linkedinUsername,
    personName: input.fullName,
    companyName: input.currentCompany,
    companyDomain: preliminaryDomain
  });
  if (cached) return fromCache(cached);

  const ttlDays = Math.min(Math.max(Number(process.env.EMAIL_DISCOVERY_CACHE_TTL_DAYS || 14), 1), 60);
  const timeoutMs = Math.min(Math.max(Number(process.env.EMAIL_DISCOVERY_CRAWL_TIMEOUT_MS || 8000), 1000), 30000);
  const { domain, website } = await resolveCompanyDomain(input);
  const mxValid = await hasValidMailServer(domain);
  const evidence: EmailDiscoveryEvidence[] = mxValid
    ? [{ type: 'dns', evidence: `MX records found for ${domain}` }]
    : domain ? [{ type: 'dns', evidence: `No MX records found for ${domain}` }] : [];

  if (!domain) {
    const result: EmailDiscoveryResult = {
      status: 'not_found',
      confidence: 0,
      mxValid,
      sources: evidence,
      fallbackChannels: { linkedinUrl: input.linkedinUrl }
    };
    upsertEmailDiscoveryCacheEntry({
      normalizedUrl: input.companyWebsite,
      linkedinUsername,
      personName: input.fullName,
      companyName: input.currentCompany,
      companyDomain: domain,
      status: result.status,
      confidence: result.confidence,
      evidence: JSON.stringify(result.sources)
    }, ttlDays);
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

  const brightDataResults = await scrapeBatchAsMarkdown(contactUrls.slice(0, 10), timeoutMs);
  for (const item of brightDataResults) inspectText(item.content, item.url, 'brightdata_batch');

  if (candidates.length === 0 && process.env.TAVILY_API_KEY) {
    try {
      const extracted = await tavilyExtract(contactUrls.slice(0, 10), 'email contact address staff team leadership', {
        extractDepth: 'basic',
        chunksPerSource: 5,
        timeout: Math.ceil(timeoutMs / 1000)
      });
      for (const item of extracted) inspectText(item.rawContent, item.url, 'tavily_extract');
    } catch {
      // Tavily is a lower-budget fallback; ignore provider failures and continue free local checks.
    }
  }

  if (candidates.length === 0) {
    const directFetches = await Promise.all(contactUrls.slice(0, 6).map(async url => ({ url, text: await fetchPage(url, timeoutMs) })));
    for (const item of directFetches) {
      if (item.text) inspectText(item.text, item.url, 'direct_fetch');
    }
  }

  if (process.env.BRIGHTDATA_API_TOKEN || process.env.API_TOKEN) {
    const publicQueries = [
      `"${input.fullName || input.currentCompany || domain}" "@${domain}"`,
      `site:${domain} "@${domain}" "${input.fullName || input.currentCompany || ''}"`,
      `"${input.currentCompany || domain}" email contact "@${domain}"`
    ].filter(query => query.replace(/[^a-zA-Z0-9]/g, '').length > 8);

    for (const query of publicQueries.slice(0, 3)) {
      const results = await brightDataSearch(query, { timeoutMs });
      for (const item of results.slice(0, 5)) inspectText(`${item.title}\n${item.content}`, item.url, 'brightdata_search');
    }
  }

  if (candidates.length === 0 && process.env.TAVILY_API_KEY) {
    try {
      const domains = [domain, 'github.com', 'linkedin.com'];
      const search = await tavilySearch(`"${input.fullName || input.currentCompany || domain}" "@${domain}" email OR contact`, domains);
      for (const item of search.items.slice(0, 5)) {
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

  upsertEmailDiscoveryCacheEntry({
    normalizedUrl: website || input.companyWebsite,
    linkedinUsername,
    personName: input.fullName,
    companyName: input.currentCompany,
    companyDomain: domain,
    discoveredEmail: result.bestEmail,
    status: result.status,
    confidence: result.confidence,
    evidence: JSON.stringify(result.sources)
  }, ttlDays);

  return result;
}
import { tavilyExtract, hasTavilyKey } from '../services/llm.js';
import {
  getEnrichmentCacheEntry,
  upsertEnrichmentCacheEntry,
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry
} from '../db.js';
import type { EnrichmentTarget } from './stages/enrichStage.js';

const BLOCKED_DOMAINS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'google.com',
  'www.google.com',
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
  'crunchbase.com',
  'www.crunchbase.com',
  'glassdoor.com',
  'www.glassdoor.com',
  'youtube.com',
  'www.youtube.com',
  'github.com',
  'www.github.com',
  'tiktok.com',
  'www.tiktok.com',
  'reddit.com',
  'www.reddit.com',
  't.co',
  'bit.ly'
]);

const PARKED_JUNK_PATTERNS = [
  /domain\s+(?:is\s+)?(?:for\s+sale|available\s+for\s+purchase|parked)/i,
  /buy\s+this\s+domain/i,
  /please\s+enable\s+cookies/i,
  /enable\s+javascript/i,
  /attention\s+required\s*\|\s*cloudflare/i,
  /404\s+not\s+found/i,
  /page\s+not\s+found/i,
  /access\s+denied/i,
  /security\s+checkpoint/i
];

export type SiteSignals = {
  location?: string;
  headcount?: string;
  services?: string;
  sourceUrl?: string;
};

const clean = (val: unknown) => String(val || '').replace(/\s+/g, ' ').trim();

export function normalizeDomainUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./i, '');
    if (!host || BLOCKED_DOMAINS.has(host) || BLOCKED_DOMAINS.has(`www.${host}`)) {
      return null;
    }
    // Host must look like a real domain (e.g. contains at least one dot, no spaces)
    if (!host.includes('.') || host.endsWith('.')) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function deriveCompanyDomain(lead: Record<string, any>): string | null {
  // 1. Check explicit website fields
  const explicitSite = lead.website || lead.companyWebsite || lead.profile?.website || lead.companyAccount?.website;
  const fromExplicit = normalizeDomainUrl(explicitSite);
  if (fromExplicit) return fromExplicit;

  // 2. Scan evidence text and snippets for non-social URLs
  const candidateTexts: string[] = [
    lead.evidence?.evidenceBlock || '',
    ...(Array.isArray(lead.evidence?.snippets)
      ? lead.evidence.snippets.map((s: any) => typeof s === 'string' ? s : s?.text || '')
      : []),
    lead.sourceUrl || ''
  ];

  const urlRegex = /\bhttps?:\/\/[^\s"'<>()[\]]+/gi;
  for (const text of candidateTexts) {
    const matches = text.match(urlRegex) || [];
    for (const match of matches) {
      const normalized = normalizeDomainUrl(match);
      if (normalized) return normalized;
    }
  }

  // 3. Fallback: Slug guess from company name
  const rawCompany = lead.currentCompany || lead.company || lead.profile?.currentCompany;
  if (rawCompany && typeof rawCompany === 'string') {
    const slug = rawCompany
      .toLowerCase()
      .replace(/\b(?:inc|llc|ltd|corp|corporation|gmbh|co|company|group|holdings|services|solutions|agency|consulting)\b/gi, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();

    if (slug.length >= 3 && slug.length <= 32) {
      return `https://${slug}.com`;
    }
  }

  return null;
}

export function extractSiteSignals(markdown: string): SiteSignals | null {
  if (!markdown || markdown.length < 180) return null;

  // Sanity check: reject parked/junk/blocked pages
  if (PARKED_JUNK_PATTERNS.some(pattern => pattern.test(markdown))) {
    return null;
  }

  const signals: SiteSignals = {};

  // 1. Location extraction
  const locationMatch = markdown.match(/\b(?:based|located|headquartered|offices?)\s+(?:in|at|across)\s+([A-Za-z0-9 ,.'-]{3,70})/i);
  if (locationMatch?.[1]) {
    const loc = clean(locationMatch[1].split(/[\r\n;.]/)[0]).slice(0, 80);
    if (loc.length >= 3 && !/^(the|a|an|our|their|multiple|various)\b/i.test(loc)) {
      signals.location = loc;
    }
  }

  if (!signals.location) {
    const addressMatch = markdown.match(/\b([A-Z][a-zA-Z\s.-]+,\s*(?:[A-Z]{2}|United States|Canada|United Kingdom|Australia|Germany|France|Netherlands)(?:\s+\d{5})?)\b/);
    if (addressMatch?.[1]) {
      const loc = clean(addressMatch[1]).slice(0, 80);
      if (loc.length >= 3) {
        signals.location = loc;
      }
    }
  }

  // 2. Headcount extraction
  const headcountMatch =
    markdown.match(/\b(?:team of|we are|we're)\s+([0-9]{1,4})\b/i) ||
    markdown.match(/\b([0-9]{1,4})\+?\s*(?:people|employees|team members|creatives|specialists|engineers|consultants|staff)\b/i);

  if (headcountMatch?.[1]) {
    const count = parseInt(headcountMatch[1], 10);
    if (Number.isFinite(count) && count > 0 && count < 50000) {
      signals.headcount = String(count);
    }
  }

  // 3. Services extraction
  const serviceLines = markdown
    .split(/\r?\n/)
    .map(line => clean(line))
    .filter(line =>
      line.length >= 10 &&
      line.length <= 160 &&
      /\b(automation|integration|workflow|crm|seo|paid media|growth|development|consulting|marketing|revops|design|software|ai|lead gen|b2b|custom api|make|zapier|n8n)\b/i.test(line)
    )
    .slice(0, 4);

  if (serviceLines.length > 0) {
    signals.services = clean(serviceLines.join(' | ')).slice(0, 380);
  }

  return Object.keys(signals).length > 0 ? signals : null;
}

export type ProbeTarget = {
  target: EnrichmentTarget;
  domain: string;
};

export async function probeCompanySites(
  targets: EnrichmentTarget[],
  options: {
    abortSignal?: AbortSignal;
    onProviderUsage?: (units: number) => void;
  } = {}
): Promise<Map<string, SiteSignals>> {
  const results = new Map<string, SiteSignals>();
  if (!targets.length || !hasTavilyKey()) return results;

  const validTargets: ProbeTarget[] = [];
  for (const target of targets) {
    const domain = deriveCompanyDomain(target.lead);
    if (domain) {
      validTargets.push({ target, domain });
    }
  }

  if (!validTargets.length) return results;

  // Group unique domains to avoid duplicate probes
  const uniqueDomains = Array.from(new Set(validTargets.map(t => t.domain)));

  // For each domain, construct probe URLs (root, /about, /team, /contact)
  const probeUrlsToDomain = new Map<string, string>();
  const urlsToExtract: string[] = [];

  for (const domain of uniqueDomains) {
    const cleanRoot = domain.replace(/\/$/, '');
    const urls = [cleanRoot, `${cleanRoot}/about`, `${cleanRoot}/team`, `${cleanRoot}/contact`];
    for (const u of urls) {
      urlsToExtract.push(u);
      probeUrlsToDomain.set(u, domain);
    }
  }

  // Tavily extract supports up to 20 URLs per batch
  const BATCH_SIZE = 20;
  const extractedByDomain = new Map<string, string[]>();

  for (let i = 0; i < urlsToExtract.length; i += BATCH_SIZE) {
    if (options.abortSignal?.aborted) break;
    const batchUrls = urlsToExtract.slice(i, i + BATCH_SIZE);
    try {
      options.onProviderUsage?.(1);
      const extractResults = await tavilyExtract(batchUrls, 'company location team size services about us');
      for (const res of extractResults) {
        const url = res.url || '';
        const domain = probeUrlsToDomain.get(url) || probeUrlsToDomain.get(url.replace(/\/$/, ''));
        const content = res.rawContent || '';
        if (domain && content) {
          const list = extractedByDomain.get(domain) || [];
          list.push(content);
          extractedByDomain.set(domain, list);
        }
      }
    } catch {
      // Continue with remaining batches on error
    }
  }

  for (const domain of uniqueDomains) {
    const contents = extractedByDomain.get(domain) || [];
    const combinedMarkdown = contents.join('\n\n');
    const signals = extractSiteSignals(combinedMarkdown);
    if (signals) {
      signals.sourceUrl = domain;
      results.set(domain, signals);
    }
  }

  return results;
}

export function applySiteProbe(
  target: EnrichmentTarget,
  signals: SiteSignals,
  sourceUrl: string,
  refreshLeadEvidence?: (target: EnrichmentTarget) => void
) {
  const lead = target.lead;
  lead.profile = lead.profile || {};
  lead.companyAccount = lead.companyAccount || {};

  // 1. Populate empty location
  if (!lead.location && !lead.profile.location && signals.location) {
    lead.location = signals.location;
    lead.profile.location = signals.location;
  }

  // 2. Populate empty headcount / company size
  if (!lead.companySizeEst && !lead.profile.companySizeEst && signals.headcount) {
    lead.companySizeEst = signals.headcount;
    lead.profile.companySizeEst = signals.headcount;
  }
  if (!lead.companyAccount.employeeCount && signals.headcount) {
    lead.companyAccount.employeeCount = signals.headcount;
  }

  // 3. Populate empty company description / services
  if (!lead.companyAccount.description && signals.services) {
    lead.companyAccount.description = signals.services;
  }

  // 4. Append site evidence line
  const evidenceLines: string[] = [];
  if (signals.location) evidenceLines.push(`Location: ${signals.location}`);
  if (signals.headcount) evidenceLines.push(`Team: ${signals.headcount}`);
  if (signals.services) evidenceLines.push(`Services: ${signals.services}`);

  if (evidenceLines.length > 0) {
    const siteEvidence = `[COMPANY SITE: ${sourceUrl}] ${evidenceLines.join(' | ')}`;
    if (target.evidenceMeta) {
      target.evidenceMeta.evidenceBlock = [target.evidenceMeta.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
    }
    if (lead.evidence) {
      lead.evidence.evidenceBlock = [lead.evidence.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
      lead.evidence.snippets = lead.evidence.snippets || [];
      lead.evidence.snippets.push(siteEvidence);
    }
  }

  // 5. Recompute verification and scoring if callback provided
  if (refreshLeadEvidence) {
    refreshLeadEvidence(target);
  }

  // 6. Record positive cache entry
  try {
    upsertEnrichmentCacheEntry({
      normalizedUrl: sourceUrl,
      companyName: lead.currentCompany || lead.company,
      evidenceBlock: evidenceLines.join('\n'),
      scrapeQuality: signals.location && signals.services ? 'good' : 'partial',
      sourceProvider: 'site_probe'
    }, 7);
  } catch {
    // ignore cache write errors
  }
}

import { scrapeAsMarkdown } from '../services/brightdata.js';
import type { SearchSpec } from './searchSpec.js';

export type CompanyIntentEvidence = {
  websiteUrl?: string;
  evidenceQuality: 'weak' | 'partial' | 'good';
  snippets: string[];
  buyingSignals: string[];
  painSignals: string[];
};

type SearchResult = { title: string; url: string; content: string };

const BUYING_SIGNALS = [
  'hiring', 'expanding', 'launched', 'opening', 'growing', 'locations',
  'booking', 'scheduling', 'automation', 'crm', 'intake', 'patient acquisition',
  'lead generation', 'operations', 'workflow', 'follow-up', 'no-show', 'conversion'
];

const BLOCKED_DOMAINS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'crunchbase.com', 'indeed.com', 'glassdoor.com', 'yelp.com'
];

const normalizeCompanyToken = (value: string) => value
  .toLowerCase()
  .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|pllc|pc|group)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const hostnameFor = (url: string) => {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const isPublicDomain = (hostname: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname);

const isBlockedUrl = (url: string) => {
  const host = hostnameFor(url);
  return !isPublicDomain(host) || BLOCKED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
};

const companyMatchScore = (companyName: string, result: SearchResult) => {
  const normalizedCompany = normalizeCompanyToken(companyName);
  const tokens = normalizedCompany.split(/\s+/).filter(token => token.length > 2);
  if (tokens.length === 0) return 0;

  const host = hostnameFor(result.url).replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]+/g, ' ');
  const text = `${host} ${result.title || ''} ${result.content || ''}`.toLowerCase();
  const hostMatches = tokens.filter(token => host.includes(token));
  // Search snippets often mention a company while belonging to a news article.
  // An official-site candidate needs at least one meaningful company token in
  // its own hostname, not merely in its page text.
  if (hostMatches.length === 0) return 0;
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0) + hostMatches.length * 3;
};

export async function findCompanyWebsite(input: {
  companyName: string;
  location?: string;
  brightDataSearch: (query: string) => Promise<SearchResult[]>;
}): Promise<string | null> {
  const companyName = input.companyName?.trim();
  if (!companyName) return null;

  const query = input.location
    ? `"${companyName}" official website ${input.location}`
    : `"${companyName}" official website`;

  const results = await input.brightDataSearch(query).catch(() => []);
  const ranked = results
    .filter(result => result.url && !isBlockedUrl(result.url))
    .map(result => ({ result, score: companyMatchScore(companyName, result) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.result.url || null;
}

export async function checkCompanyIntent(
  websiteUrl: string,
  options?: { searchSpec?: SearchSpec; companyName?: string }
): Promise<CompanyIntentEvidence | null> {
  if (!websiteUrl || isBlockedUrl(websiteUrl)) return null;

  try {
    const markdown = await scrapeAsMarkdown(websiteUrl);
    if (!markdown) return null;

    const lowerMarkdown = markdown.toLowerCase();
    const buyingSignalsFound: string[] = [];
    const painSignalsFound: string[] = [];

    for (const signal of BUYING_SIGNALS) {
      if (lowerMarkdown.includes(signal)) {
        buyingSignalsFound.push(signal);
      }
    }

    const targetKeywords = options?.searchSpec?.company?.keywords || [];
    const targetMatches = targetKeywords.filter(k => k && k.length > 2 && lowerMarkdown.includes(k.toLowerCase()));
    if (targetMatches.length > 0) {
      buyingSignalsFound.push(...targetMatches);
    }

    const uniqueBuyingSignals = Array.from(new Set(buyingSignalsFound));
    const snippets: string[] = [];
    if (uniqueBuyingSignals.length > 0) {
      snippets.push(`Found relevant intent signals: ${uniqueBuyingSignals.join(', ')}`);
    }

    let quality: 'weak' | 'partial' | 'good' = 'weak';
    if (uniqueBuyingSignals.length >= 3) {
      quality = 'good';
    } else if (uniqueBuyingSignals.length >= 1) {
      quality = 'partial';
    }

    if (uniqueBuyingSignals.length === 0) return null;

    return {
      websiteUrl,
      evidenceQuality: quality,
      snippets,
      buyingSignals: uniqueBuyingSignals,
      painSignals: painSignalsFound
    };
  } catch (error) {
    console.warn(`[checkCompanyIntent] failed for ${websiteUrl}:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

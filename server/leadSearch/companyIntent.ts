import { scrapeAsMarkdown } from '../services/brightdata.js';
import type { SearchSpec } from './searchSpec.js';
import { UNIVERSAL_SIGNALS, type IntentSignalSpec } from './intentSignals.js';

export type CompanyIntentEvidence = {
  websiteUrl?: string;
  evidenceQuality: 'weak' | 'partial' | 'good';
  snippets: string[];
  buyingSignals: string[];
  dynamicSignals: string[];
  universalSignals: string[];
  painSignals: string[];
  /** TF-IDF weighted aggregate intent score (0-1 normalised) for this company. */
  tfidfWeightedScore: number;
};

/**
 * Session-scoped TF-IDF corpus.
 * Call registerOccurrences() for each company scraped.
 * Call computeWeight() after all companies have been registered.
 */
export class SignalCorpus {
  private docFrequency = new Map<string, number>();
  private totalDocs = 0;

  registerOccurrences(foundSignals: string[]): void {
    this.totalDocs += 1;
    const unique = new Set(foundSignals.map(s => s.toLowerCase()));
    for (const signal of unique) {
      this.docFrequency.set(signal, (this.docFrequency.get(signal) ?? 0) + 1);
    }
  }

  /**
   * TF-IDF weight for a signal found `termCount` times in this document.
   * weight = termCount * log(totalDocs / (1 + df(signal)))
   */
  computeWeight(signal: string, termCount: number): number {
    const df = this.docFrequency.get(signal.toLowerCase()) ?? 0;
    const idf = Math.log(Math.max(1, this.totalDocs) / (1 + df));
    return Math.max(0, termCount * idf);
  }

  get total(): number { return this.totalDocs; }
}

type SearchResult = { title: string; url: string; content: string };

/** @deprecated Use UNIVERSAL_SIGNALS from intentSignals.ts */
export const BUYING_SIGNALS = UNIVERSAL_SIGNALS;

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
  if (hostMatches.length === 0) return 0;
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0) + hostMatches.length * 3;
};

export async function findCompanyWebsite(input: {
  companyName: string;
  location?: string;
  brightDataSearch: (query: string) => Promise<SearchResult[]>;
  tavilySearchFallback?: (query: string) => Promise<SearchResult[]>;
}): Promise<string | null> {
  const companyName = input.companyName?.trim();
  if (!companyName) return null;

  const query = input.location
    ? `"${companyName}" official website ${input.location}`
    : `"${companyName}" official website`;

  let results = await input.brightDataSearch(query).catch(() => []);
  if ((!results || results.length === 0) && input.tavilySearchFallback) {
    results = await input.tavilySearchFallback(query).catch(() => []);
  }

  const ranked = results
    .filter(result => result.url && !isBlockedUrl(result.url))
    .map(result => ({ result, score: companyMatchScore(companyName, result) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.result.url || null;
}

export async function checkCompanyIntent(
  websiteUrl: string,
  options?: {
    searchSpec?: SearchSpec;
    companyName?: string;
    intentSignals?: IntentSignalSpec;
    /** Pass the session-scoped corpus for TF-IDF weighting (strongly recommended). */
    corpus?: SignalCorpus;
  }
): Promise<CompanyIntentEvidence | null> {
  if (!websiteUrl || isBlockedUrl(websiteUrl)) return null;

  try {
    const markdown = await scrapeAsMarkdown(websiteUrl);
    if (!markdown) return null;

    const lowerMarkdown = markdown.toLowerCase();
    const dynamicSet = options?.intentSignals?.dynamic || [];
    const universalSet = options?.intentSignals?.universal || UNIVERSAL_SIGNALS;

    const dynamicSignalsFound: string[] = [];
    const universalSignalsFound: string[] = [];
    const painSignalsFound: string[] = [];
    // Track per-signal occurrence counts for TF weighting
    const signalCounts = new Map<string, number>();

    const countOccurrences = (signal: string): number => {
      const lower = signal.toLowerCase();
      let count = 0;
      let idx = lowerMarkdown.indexOf(lower);
      while (idx !== -1) { count++; idx = lowerMarkdown.indexOf(lower, idx + 1); }
      return count;
    };

    for (const signal of dynamicSet) {
      const count = countOccurrences(signal);
      if (count > 0) {
        dynamicSignalsFound.push(signal);
        signalCounts.set(signal.toLowerCase(), count);
      }
    }

    for (const signal of universalSet) {
      const count = countOccurrences(signal);
      if (count > 0) {
        universalSignalsFound.push(signal);
        signalCounts.set(signal.toLowerCase(), (signalCounts.get(signal.toLowerCase()) ?? 0) + count);
      }
    }

    const targetKeywords = options?.searchSpec?.company?.keywords || [];
    for (const k of targetKeywords) {
      if (k && k.length > 2 && lowerMarkdown.includes(k.toLowerCase())) {
        if (!dynamicSignalsFound.includes(k) && !universalSignalsFound.includes(k)) {
          dynamicSignalsFound.push(k);
        }
      }
    }

    const uniqueDynamic = Array.from(new Set(dynamicSignalsFound));
    const uniqueUniversal = Array.from(new Set(universalSignalsFound));
    const uniqueBuying = Array.from(new Set([...uniqueDynamic, ...uniqueUniversal]));

    // Register this document's signals with the session corpus for IDF weighting
    if (options?.corpus) {
      options.corpus.registerOccurrences(uniqueBuying);
    }

    // Compute TF-IDF aggregate score for this company (0-1 normalised)
    let tfidfRawTotal = 0;
    for (const signal of uniqueBuying) {
      const count = signalCounts.get(signal.toLowerCase()) ?? 1;
      if (options?.corpus) {
        tfidfRawTotal += options.corpus.computeWeight(signal, count);
      } else {
        // Fallback: simple term-frequency proxy when no corpus is provided
        tfidfRawTotal += Math.log1p(count);
      }
    }
    // Normalise to 0-1 using a soft cap (sum of 10 signals at max IDF ~= saturation)
    const tfidfWeightedScore = Math.min(1, tfidfRawTotal / 10);

    let quality: 'weak' | 'partial' | 'good' = 'weak';
    if (uniqueDynamic.length >= 2 || tfidfWeightedScore >= 0.6) {
      quality = 'good';
    } else if (uniqueDynamic.length === 1 || uniqueUniversal.length >= 4 || tfidfWeightedScore >= 0.3) {
      quality = 'partial';
    } else {
      quality = 'weak';
    }

    const snippets: string[] = [];
    if (uniqueBuying.length > 0) {
      snippets.push(`Found relevant intent signals: ${uniqueBuying.join(', ')} (TF-IDF score: ${tfidfWeightedScore.toFixed(3)})`);
    } else {
      snippets.push(`Scraped website but no intent signals matched query context.`);
    }

    return {
      websiteUrl,
      evidenceQuality: quality,
      snippets,
      buyingSignals: uniqueBuying,
      dynamicSignals: uniqueDynamic,
      universalSignals: uniqueUniversal,
      painSignals: painSignalsFound,
      tfidfWeightedScore
    };
  } catch (error) {
    console.warn(`[checkCompanyIntent] failed for ${websiteUrl}:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

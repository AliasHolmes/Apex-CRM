export type ScoutProvider = 'tavily' | 'brightdata';

export type FreeTierCapabilities = {
  plan: 'free';
  monthlyLimit: number;
  supported: string[];
  unavailable: string[];
};

const boundedNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

export const tavilyFreeTierCapabilities = (): FreeTierCapabilities => ({
  plan: 'free',
  monthlyLimit: boundedNumber(process.env.TAVILY_MONTHLY_CREDIT_BUDGET, 1000, 1, 1000),
  supported: ['search:basic', 'search:fast', 'search:advanced', 'extract:basic'],
  unavailable: ['research', 'crawl', 'map']
});

export const brightDataFreeTierCapabilities = (): FreeTierCapabilities => ({
  plan: 'free',
  monthlyLimit: boundedNumber(process.env.BRIGHTDATA_MONTHLY_REQUEST_BUDGET, 5000, 1, 5000),
  supported: ['search_engine', 'scrape_as_markdown'],
  unavailable: ['scrape_batch', 'structured_linkedin', 'browser_automation']
});

export type ScoutBudgetSnapshot = {
  tavilyCreditsReserved: number;
  tavilyCreditsRemaining: number;
  brightDataRequestsReserved: number;
  brightDataRequestsRemaining: number;
  advancedSearchesRemaining: number;
  extractionUrlsRemaining: number;
};

/**
 * A per-session guard for the documented free plans. Monthly accounting is
 * deliberately handled by persistence; this guard prevents one search from
 * unexpectedly consuming the month's allocation.
 */
export class ScoutFreeTierBudget {
  private tavilyCreditsRemaining: number;
  private brightDataRequestsRemaining: number;
  private advancedSearchesRemaining: number;
  private extractionUrlsRemaining: number;
  private tavilyCreditsReserved = 0;
  private brightDataRequestsReserved = 0;

  constructor() {
    this.tavilyCreditsRemaining = boundedNumber(process.env.TAVILY_SCOUT_MAX_CREDITS_PER_SEARCH, 6, 1, 30);
    this.brightDataRequestsRemaining = boundedNumber(process.env.BRIGHTDATA_SCOUT_MAX_REQUESTS_PER_SEARCH, 2, 0, 20);
    this.advancedSearchesRemaining = boundedNumber(process.env.TAVILY_SCOUT_MAX_ADVANCED_SEARCHES, 1, 0, 3);
    this.extractionUrlsRemaining = boundedNumber(process.env.TAVILY_SCOUT_EXTRACT_MAX_URLS, 5, 0, 20);
  }

  reserveTavilySearch(depth: 'basic' | 'fast' | 'ultra-fast' | 'advanced') {
    const cost = depth === 'advanced' ? 2 : 1;
    if (depth === 'advanced' && this.advancedSearchesRemaining < 1) return false;
    if (this.tavilyCreditsRemaining < cost) return false;
    this.tavilyCreditsRemaining -= cost;
    this.tavilyCreditsReserved += cost;
    if (depth === 'advanced') this.advancedSearchesRemaining--;
    return true;
  }

  reserveTavilyExtract(urlCount: number) {
    const accepted = Math.min(Math.max(Math.floor(urlCount), 0), this.extractionUrlsRemaining);
    if (accepted < 1) return 0;
    // Tavily basic extract costs one credit per five successful URL extractions.
    const cost = Math.ceil(accepted / 5);
    if (this.tavilyCreditsRemaining < cost) return 0;
    this.tavilyCreditsRemaining -= cost;
    this.tavilyCreditsReserved += cost;
    this.extractionUrlsRemaining -= accepted;
    return accepted;
  }

  reserveBrightDataSearch() {
    if (this.brightDataRequestsRemaining < 1) return false;
    this.brightDataRequestsRemaining--;
    this.brightDataRequestsReserved++;
    return true;
  }

  snapshot(): ScoutBudgetSnapshot {
    return {
      tavilyCreditsReserved: this.tavilyCreditsReserved,
      tavilyCreditsRemaining: this.tavilyCreditsRemaining,
      brightDataRequestsReserved: this.brightDataRequestsReserved,
      brightDataRequestsRemaining: this.brightDataRequestsRemaining,
      advancedSearchesRemaining: this.advancedSearchesRemaining,
      extractionUrlsRemaining: this.extractionUrlsRemaining
    };
  }
}

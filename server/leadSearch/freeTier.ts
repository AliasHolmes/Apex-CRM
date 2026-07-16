export type ScoutProvider = 'tavily' | 'brightdata';

export type FreeTierCapabilities = {
  plan: 'free';
  monthlyLimit: number;
  supported: string[];
  unavailable: string[];
  /** Local credit reservation is disabled; multi-key rotation handles exhaustion. */
  creditReservation: 'disabled' | 'enabled';
};

const boundedNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

/**
 * Credit reservation is off by default. Apex relies on Tavily/Bright Data key
 * pools to rotate when a key is rate-limited or out of credits. Set
 * PROVIDER_CREDIT_RESERVATION=true only if you want local hard caps again.
 */
export function isProviderCreditReservationEnabled() {
  return String(process.env.PROVIDER_CREDIT_RESERVATION || '').trim().toLowerCase() === 'true';
}

export const tavilyFreeTierCapabilities = (): FreeTierCapabilities => ({
  plan: 'free',
  monthlyLimit: boundedNumber(process.env.TAVILY_MONTHLY_CREDIT_BUDGET, 1000, 1, 1_000_000),
  supported: ['search:basic', 'search:fast', 'search:advanced', 'extract:basic'],
  unavailable: ['research', 'crawl', 'map'],
  creditReservation: isProviderCreditReservationEnabled() ? 'enabled' : 'disabled'
});

export const brightDataFreeTierCapabilities = (): FreeTierCapabilities => ({
  plan: 'free',
  monthlyLimit: boundedNumber(process.env.BRIGHTDATA_MONTHLY_REQUEST_BUDGET, 5000, 1, 1_000_000),
  supported: ['search_engine', 'scrape_as_markdown'],
  unavailable: ['scrape_batch', 'structured_linkedin', 'browser_automation'],
  creditReservation: isProviderCreditReservationEnabled() ? 'enabled' : 'disabled'
});

export type ScoutBudgetSnapshot = {
  tavilyCreditsReserved: number;
  tavilyCreditsRemaining: number;
  brightDataRequestsReserved: number;
  brightDataRequestsRemaining: number;
  advancedSearchesRemaining: number;
  extractionUrlsRemaining: number;
  reservationEnabled: boolean;
};

/**
 * Optional per-session guard. When credit reservation is disabled (default),
 * every reserve call succeeds so discovery can exhaust keys via rotation.
 */
export class ScoutFreeTierBudget {
  private tavilyCreditsRemaining: number;
  private brightDataRequestsRemaining: number;
  private advancedSearchesRemaining: number;
  private extractionUrlsRemaining: number;
  private tavilyCreditsReserved = 0;
  private brightDataRequestsReserved = 0;
  private readonly reservationEnabled: boolean;

  constructor() {
    this.reservationEnabled = isProviderCreditReservationEnabled();
    // When reservation is off, use large ceilings only for telemetry snapshots.
    const open = !this.reservationEnabled;
    this.tavilyCreditsRemaining = open
      ? 1_000_000
      : boundedNumber(process.env.TAVILY_SCOUT_MAX_CREDITS_PER_SEARCH, 6, 1, 30);
    this.brightDataRequestsRemaining = open
      ? 1_000_000
      : boundedNumber(process.env.BRIGHTDATA_SCOUT_MAX_REQUESTS_PER_SEARCH, 20, 0, 500);
    this.advancedSearchesRemaining = open
      ? 1_000_000
      : boundedNumber(process.env.TAVILY_SCOUT_MAX_ADVANCED_SEARCHES, 0, 0, 3);
    this.extractionUrlsRemaining = open
      ? 1_000_000
      : boundedNumber(process.env.TAVILY_SCOUT_EXTRACT_MAX_URLS, 5, 0, 20);
  }

  reserveTavilySearch(depth: 'basic' | 'fast' | 'ultra-fast' | 'advanced') {
    if (!this.reservationEnabled) {
      const cost = depth === 'advanced' ? 2 : 1;
      this.tavilyCreditsReserved += cost;
      return true;
    }
    const cost = depth === 'advanced' ? 2 : 1;
    if (depth === 'advanced' && this.advancedSearchesRemaining < 1) return false;
    if (this.tavilyCreditsRemaining < cost) return false;
    this.tavilyCreditsRemaining -= cost;
    this.tavilyCreditsReserved += cost;
    if (depth === 'advanced') this.advancedSearchesRemaining--;
    return true;
  }

  reserveTavilyExtract(urlCount: number) {
    if (!this.reservationEnabled) {
      const accepted = Math.max(0, Math.floor(urlCount));
      this.tavilyCreditsReserved += Math.ceil(accepted / 5);
      return accepted;
    }
    const accepted = Math.min(Math.max(Math.floor(urlCount), 0), this.extractionUrlsRemaining);
    if (accepted < 1) return 0;
    const cost = Math.ceil(accepted / 5);
    if (this.tavilyCreditsRemaining < cost) return 0;
    this.tavilyCreditsRemaining -= cost;
    this.tavilyCreditsReserved += cost;
    this.extractionUrlsRemaining -= accepted;
    return accepted;
  }

  reserveBrightDataSearch() {
    if (!this.reservationEnabled) {
      this.brightDataRequestsReserved += 1;
      return true;
    }
    if (this.brightDataRequestsRemaining < 1) return false;
    this.brightDataRequestsRemaining--;
    this.brightDataRequestsReserved++;
    return true;
  }

  reserveBrightDataScrape(count = 1) {
    const requested = Math.max(0, Math.floor(count));
    if (!this.reservationEnabled) {
      this.brightDataRequestsReserved += requested;
      return requested;
    }
    const accepted = Math.min(requested, this.brightDataRequestsRemaining);
    this.brightDataRequestsRemaining -= accepted;
    this.brightDataRequestsReserved += accepted;
    return accepted;
  }

  snapshot(): ScoutBudgetSnapshot {
    return {
      tavilyCreditsReserved: this.tavilyCreditsReserved,
      tavilyCreditsRemaining: this.tavilyCreditsRemaining,
      brightDataRequestsReserved: this.brightDataRequestsReserved,
      brightDataRequestsRemaining: this.brightDataRequestsRemaining,
      advancedSearchesRemaining: this.advancedSearchesRemaining,
      extractionUrlsRemaining: this.extractionUrlsRemaining,
      reservationEnabled: this.reservationEnabled
    };
  }
}

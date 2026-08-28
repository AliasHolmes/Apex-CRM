import type { SignalBlock } from './observations.js';
import { isFlagEnabled } from './featureFlags.js';

export const MAX_SIGNAL_BLOCKS = 50;
export const MAX_SIGNAL_TEXT_LENGTH = 600;
export const MAX_DISCOVERED_COMPANIES = 25;

export type DiscoveredCompanySignal = {
  companyName: string;
  signalCount: number;
  strongestSignal: string;
  sourceUrls: string[];
  lastSeenRound: number;
  confidence: number;
};

export type SignalStoreData = {
  blocks: SignalBlock[];
  companies: DiscoveredCompanySignal[];
};

/**
 * Normalize a company name for conservative matching.
 * Trailing international legal suffixes are removed; descriptive brand words are retained.
 */
export function normalizeCompanyName(name: string): string {
  let normalized = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const legalSuffix = /\s+(?:llc|inc|incorporated|ltd|limited|co|company|corp|corporation|gmbh|pty|plc|llp|b\s*v|s\s*a|s\s*r\s*l|s\s*a\s*s|s\s*l|ag|pte\s*ltd|sdn\s*bhd|sp\s*z\s*o\s*o|aps|pty\s*ltd|uk|usa|us|emea|apac|global|hq|holdings|group)$/;
  while (legalSuffix.test(normalized)) {
    normalized = normalized.replace(legalSuffix, '').trim();
  }
  return normalized;
}

const genericCompanyTokens = new Set([
  'agency', 'and', 'capital', 'company', 'consultancy', 'consulting', 'digital',
  'global', 'group', 'holdings', 'labs', 'partners', 'services', 'solutions',
  'studio', 'systems', 'technologies', 'technology', 'the', 'ventures', 'media',
  'tech', 'ai', 'red', 'one', 'hub', 'pro', 'net', 'top', 'bot', 'app', 'io',
  'hq', 'hqagency', 'us', 'uk', 'global', 'online', 'web', 'site', 'crm', 'saas',
  'growth', 'automation', 'software', 'development'
]);

const INDUSTRY_QUALIFIERS = new Set([
  'solutions', 'growth', 'consultancy', 'consulting', 'digital', 'media',
  'systems', 'services', 'partners', 'capital', 'ventures', 'labs', 'studio',
  'agency', 'technologies', 'technology', 'automation', 'software'
]);

const WHITELISTED_3CHAR_BRANDS = new Set([
  'n8n', 'aws', 'ibm', 'box', 'sap', 'amd', 'arm', 'wix', 'gcp', 'sfdc'
]);

export const distinctiveTokens = (name: string): string[] => {
  const normalized = normalizeCompanyName(name);
  return normalized
    .split(' ')
    .filter(token => {
      if (genericCompanyTokens.has(token)) return false;
      if (WHITELISTED_3CHAR_BRANDS.has(token)) return true;
      return token.length >= 4;
    });
};

export type CompanyEntity = {
  rawName: string;
  normalizedName: string;
  domainStem?: string;
  distinctiveTokens: string[];
  isShortBrand: boolean;
};

export class CompanyRegistry {
  private static extractDomainStem(urlOrDomain: string): string | undefined {
    if (!urlOrDomain) return undefined;
    const clean = urlOrDomain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    const parts = clean.split('.');
    if (parts.length >= 2) {
      return parts[0].toLowerCase();
    }
    return undefined;
  }

  static resolve(nameOrUrl: string): CompanyEntity {
    const raw = String(nameOrUrl || '').trim();
    const isUrl = /^https?:\/\/|\.com|\.io|\.ai|\.co|\.org|\.net/i.test(raw);
    const domainStem = isUrl ? this.extractDomainStem(raw) : undefined;
    const normalizedName = normalizeCompanyName(domainStem || raw);
    const tokens = distinctiveTokens(normalizedName);
    const isShortBrand = normalizedName.length <= 4 && !genericCompanyTokens.has(normalizedName);

    return {
      rawName: raw,
      normalizedName,
      domainStem,
      distinctiveTokens: tokens,
      isShortBrand
    };
  }

  static areEquivalent(a: string, b: string): boolean {
    const entityA = this.resolve(a);
    const entityB = this.resolve(b);

    if (!entityA.normalizedName || !entityB.normalizedName) return false;
    if (entityA.normalizedName === entityB.normalizedName) return true;

    const compactA = entityA.normalizedName.replace(/\s+/g, '');
    const compactB = entityB.normalizedName.replace(/\s+/g, '');
    if (compactA.length >= 6 && compactA === compactB) return true;

    if (entityA.domainStem && entityB.domainStem && entityA.domainStem === entityB.domainStem) {
      return true;
    }

    if (entityA.isShortBrand || entityB.isShortBrand) {
      return entityA.normalizedName === entityB.normalizedName;
    }

    const setB = new Set(entityB.distinctiveTokens);
    const hasSharedDistinctive = entityA.distinctiveTokens.some(token => setB.has(token));
    if (!hasSharedDistinctive) return false;

    const wordsA = entityA.normalizedName.split(' ').filter(Boolean);
    const wordsB = entityB.normalizedName.split(' ').filter(Boolean);
    if (wordsA.length >= 2 && wordsB.length >= 2) {
      const diffA = wordsA.filter(w => !wordsB.includes(w));
      const diffB = wordsB.filter(w => !wordsA.includes(w));
      if (diffA.some(w => INDUSTRY_QUALIFIERS.has(w)) && diffB.some(w => INDUSTRY_QUALIFIERS.has(w))) {
        return false;
      }
    }

    return true;
  }
}

/**
 * 4-Tier Safe Company Match:
 * Tier 1: Exact normalized name match
 * Tier 2: Compact string match for length >= 6
 * Tier 3: Distinctive tokens of length >= 4 (excluding generic dictionary)
 * Tier 4: Whitelisted 3-character tech brands (e.g. n8n)
 */
export function companiesMatch(a: string, b: string): boolean {
  if (isFlagEnabled.companyEntityRegistry()) {
    return CompanyRegistry.areEquivalent(a, b);
  }

  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const compactA = na.replace(/\s+/g, '');
  const compactB = nb.replace(/\s+/g, '');
  if (compactA.length >= 6 && compactA === compactB) return true;

  const tokensA = distinctiveTokens(na);
  const tokensB = distinctiveTokens(nb);
  if (!tokensA.length || !tokensB.length) return false;

  const setB = new Set(tokensB);
  const hasSharedDistinctive = tokensA.some(token => setB.has(token));
  if (!hasSharedDistinctive) return false;

  // Collision prevention: If both names have distinct conflicting industry qualifiers (e.g. "Apex Solutions" vs "Apex Growth")
  const wordsA = na.split(' ').filter(Boolean);
  const wordsB = nb.split(' ').filter(Boolean);
  if (wordsA.length >= 2 && wordsB.length >= 2) {
    const diffA = wordsA.filter(w => !wordsB.includes(w));
    const diffB = wordsB.filter(w => !wordsA.includes(w));
    if (diffA.some(w => INDUSTRY_QUALIFIERS.has(w)) && diffB.some(w => INDUSTRY_QUALIFIERS.has(w))) {
      return false;
    }
  }

  return true;
}

export class SignalStore {
  private blocks: SignalBlock[] = [];
  private blockKeys = new Set<string>();
  private companyMap = new Map<string, DiscoveredCompanySignal>();

  add(block: SignalBlock): void {
    const rawCompany = String(block.companyName || '').trim();
    const normalizedCompany = normalizeCompanyName(rawCompany);
    if (!normalizedCompany) return;

    const truncatedText = String(block.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SIGNAL_TEXT_LENGTH);

    const key = [
      normalizedCompany,
      String(block.url || '').toLowerCase().replace(/\/$/, ''),
      truncatedText.toLowerCase()
    ].join('|');

    if (this.blockKeys.has(key)) return;

    // FIFO eviction if store exceeds capacity
    if (this.blocks.length >= MAX_SIGNAL_BLOCKS) {
      const evicted = this.blocks.shift();
      if (evicted) {
        const evictedKey = [
          normalizeCompanyName(evicted.companyName),
          String(evicted.url || '').toLowerCase().replace(/\/$/, ''),
          String(evicted.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNAL_TEXT_LENGTH).toLowerCase()
        ].join('|');
        this.blockKeys.delete(evictedKey);

        // Update companyMap so evicted blocks do not leave stale provenance
        const evictedComp = normalizeCompanyName(evicted.companyName);
        const compSignal = this.companyMap.get(evictedComp);
        if (compSignal) {
          compSignal.signalCount = Math.max(0, compSignal.signalCount - 1);
          if (compSignal.signalCount === 0) {
            this.companyMap.delete(evictedComp);
          }
        }
      }
    }

    this.blockKeys.add(key);
    this.blocks.push({
      ...block,
      companyName: rawCompany,
      text: truncatedText
    });

    this.registerDiscoveredCompany(
      rawCompany,
      truncatedText,
      block.url,
      block.round || 1,
      block.confidence || 0.7
    );
  }

  registerDiscoveredCompany(
    companyName: string,
    signalText: string,
    url?: string,
    round = 1,
    confidence = 0.7
  ): void {
    const cleanName = String(companyName || '').trim();
    const normalized = normalizeCompanyName(cleanName);
    if (!normalized || normalized.length < 2 || genericCompanyTokens.has(normalized)) return;

    const existing = this.companyMap.get(normalized);
    const safeUrl = String(url || '').trim();
    if (existing) {
      existing.signalCount++;
      if (signalText && signalText.length > existing.strongestSignal.length) {
        existing.strongestSignal = signalText.slice(0, 300);
      }
      if (safeUrl && !existing.sourceUrls.includes(safeUrl) && existing.sourceUrls.length < 5) {
        existing.sourceUrls.push(safeUrl);
      }
      existing.lastSeenRound = Math.max(existing.lastSeenRound, round);
      existing.confidence = Math.min(1.0, Math.max(existing.confidence, confidence));
    } else {
      if (this.companyMap.size >= MAX_DISCOVERED_COMPANIES) {
        // Evict company with lowest signalCount
        let lowestKey = '';
        let lowestCount = Infinity;
        for (const [k, v] of this.companyMap.entries()) {
          if (v.signalCount < lowestCount) {
            lowestCount = v.signalCount;
            lowestKey = k;
          }
        }
        if (lowestKey) this.companyMap.delete(lowestKey);
      }

      this.companyMap.set(normalized, {
        companyName: cleanName,
        signalCount: 1,
        strongestSignal: String(signalText || '').slice(0, 300),
        sourceUrls: safeUrl ? [safeUrl] : [],
        lastSeenRound: round,
        confidence
      });
    }
  }

  /** Return all signal texts whose company name matches `candidateCompany`. */
  getForCandidate(candidateCompany: string): SignalBlock[] {
    if (!candidateCompany) return [];
    return this.blocks.filter(b => companiesMatch(b.companyName, candidateCompany));
  }

  getForCandidates(candidateCompanies: string[]): { companyName: string; blocks: SignalBlock[] } {
    const uniqueCandidates = Array.from(new Set(
      candidateCompanies.map(value => String(value || '').trim()).filter(Boolean)
    ));
    for (const companyName of uniqueCandidates) {
      const blocks = this.getForCandidate(companyName);
      if (blocks.length > 0) return { companyName, blocks };
    }
    return { companyName: uniqueCandidates[0] || '', blocks: [] };
  }

  /** Return top high-conviction discovered companies ranked by signalCount and confidence. */
  getTopDiscoveredCompanies(limit = 5): DiscoveredCompanySignal[] {
    return Array.from(this.companyMap.values())
      .filter(c => c.signalCount > 0 && c.companyName.length >= 2)
      .sort((a, b) => (b.signalCount * b.confidence) - (a.signalCount * a.confidence))
      .slice(0, limit);
  }

  /** Return list of unique company names discovered with signal evidence. */
  getUniqueCompanyNames(): string[] {
    return this.getTopDiscoveredCompanies(MAX_DISCOVERED_COMPANIES).map(c => c.companyName);
  }

  /**
   * Return query terms for a discovered company, anchoring with geographic or
   * domain qualifiers when anchoredFlywheel is enabled.
   */
  getAnchoredQueryTerms(companyName: string): string[] {
    const norm = normalizeCompanyName(companyName);
    const discovered = this.companyMap.get(norm);
    if (!discovered) return [companyName];

    if (isFlagEnabled.anchoredFlywheel()) {
      const signal = discovered.strongestSignal || '';
      const locMatch = signal.match(/\b(?:in|based in|at|near)\s+([A-Z][a-zA-Z\s,]+?)(?:\.|\sand\s|\swith\b|\sfor\b|\s-|--|\n|$)/);
      const location = locMatch ? locMatch[1].trim().slice(0, 30) : undefined;
      
      const domainUrl = discovered.sourceUrls[0];
      const domainStem = domainUrl ? CompanyRegistry.resolve(domainUrl).domainStem : undefined;

      const terms = [companyName];
      if (location && location.length >= 3 && !genericCompanyTokens.has(location.toLowerCase())) {
        terms.push(location);
      } else if (domainStem && domainStem.length >= 3 && domainStem !== norm) {
        terms.push(domainStem);
      }
      return terms;
    }

    return [companyName];
  }

  toJSON(): SignalStoreData {
    return {
      blocks: [...this.blocks],
      companies: Array.from(this.companyMap.values())
    };
  }

  restore(data?: Partial<SignalStoreData>): void {
    if (!data) return;
    this.blocks = [];
    this.blockKeys.clear();
    this.companyMap.clear();

    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    for (const block of blocks.slice(0, MAX_SIGNAL_BLOCKS)) {
      this.add(block);
    }

    const companies = Array.isArray(data.companies) ? data.companies : [];
    for (const comp of companies.slice(0, MAX_DISCOVERED_COMPANIES)) {
      const normalized = normalizeCompanyName(comp.companyName);
      if (normalized && !this.companyMap.has(normalized)) {
        this.companyMap.set(normalized, {
          companyName: comp.companyName,
          signalCount: Number(comp.signalCount || 1),
          strongestSignal: String(comp.strongestSignal || '').slice(0, 300),
          sourceUrls: Array.isArray(comp.sourceUrls) ? comp.sourceUrls.slice(0, 5) : [],
          lastSeenRound: Number(comp.lastSeenRound || 1),
          confidence: Number(comp.confidence || 0.7)
        });
      }
    }
  }

  static fromJSON(data?: Partial<SignalStoreData>): SignalStore {
    const store = new SignalStore();
    store.restore(data);
    return store;
  }

  get size(): number {
    return this.blocks.length;
  }
}

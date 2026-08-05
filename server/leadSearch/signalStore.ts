import type { SignalBlock } from './observations.js';

/**
 * Normalize a company name for conservative matching.
 * Only trailing legal suffixes are removed; descriptive brand words are retained.
 */
export function normalizeCompanyName(name: string): string {
  let normalized = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const legalSuffix = /\s+(?:llc|inc|incorporated|ltd|limited|co|company|corp|corporation|gmbh|pty|plc|llp)$/;
  while (legalSuffix.test(normalized)) {
    normalized = normalized.replace(legalSuffix, '').trim();
  }
  return normalized;
}

const genericCompanyTokens = new Set([
  'agency', 'and', 'capital', 'company', 'consultancy', 'consulting', 'digital',
  'global', 'group', 'holdings', 'labs', 'partners', 'services', 'solutions',
  'studio', 'systems', 'technologies', 'technology', 'the', 'ventures'
]);

const distinctiveTokens = (name: string) => normalizeCompanyName(name)
  .split(' ')
  .filter(token => token.length >= 6 && !genericCompanyTokens.has(token));

/**
 * Returns true when two company names are likely the same organisation.
 */
export function companiesMatch(a: string, b: string): boolean {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const compactA = na.replace(/\s+/g, '');
  const compactB = nb.replace(/\s+/g, '');
  if (compactA.length >= 8 && compactA === compactB) return true;

  const tokensA = distinctiveTokens(na);
  const tokensB = new Set(distinctiveTokens(nb));
  return tokensA.some(token => tokensB.has(token));
}

export class SignalStore {
  private blocks: SignalBlock[] = [];
  private blockKeys = new Set<string>();

  add(block: SignalBlock): void {
    const key = [
      normalizeCompanyName(block.companyName),
      String(block.url || '').toLowerCase().replace(/\/$/, ''),
      String(block.text || '').toLowerCase().replace(/\s+/g, ' ').trim()
    ].join('|');
    if (!normalizeCompanyName(block.companyName) || this.blockKeys.has(key)) return;
    this.blockKeys.add(key);
    this.blocks.push(block);
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

  get size(): number {
    return this.blocks.length;
  }
}

/**
 * Phase 2a: Centralized alias normalization map.
 * Zero-network, synchronous O(1) lookups for hot loops
 * (fuseStage, evidenceSelection, finalistJudge, strategist).
 *
 * Covers roles, geographies (ISO-3166 + regions), company types,
 * and tooling keywords. All lookups are case-insensitive.
 */

const clean = (v: unknown) => String(v || '').replace(/\s+/g, ' ').trim();
const lower = (v: unknown) => clean(v).toLowerCase();

const ROLE_ALIASES: Record<string, string> = {
  'md': 'managing director',
  'managing directors': 'managing director',
  'vp': 'vice president',
  'vps': 'vice president',
  'vice presidents': 'vice president',
  'ceo': 'ceo',
  'chief executive': 'ceo',
  'chief executive officer': 'ceo',
  'cto': 'cto',
  'chief technology officer': 'cto',
  'cmo': 'cmo',
  'chief marketing officer': 'cmo',
  'cfo': 'cfo',
  'chief financial officer': 'cfo',
  'coo': 'coo',
  'chief operating officer': 'coo',
  'cro': 'cro',
  'chief revenue officer': 'cro',
  'cio': 'cio',
  'cpo': 'cpo',
  'co-founder': 'founder',
  'cofounder': 'founder',
  'cofounders': 'founder',
  'founders': 'founder',
  'owners': 'owner',
  'proprietors': 'owner',
  'directors': 'director',
  'partners': 'partner',
  'principals': 'principal',
  'dev': 'developer',
  'devs': 'developer',
  'developers': 'developer',
  'engineers': 'engineer',
  'swe': 'software engineer',
};

const GEO_ALIASES: Record<string, string> = {
  'us': 'united states',
  'u.s.': 'united states',
  'u.s.a.': 'united states',
  'usa': 'united states',
  'america': 'united states',
  'united states of america': 'united states',
  'uk': 'united kingdom',
  'u.k.': 'united kingdom',
  'britain': 'united kingdom',
  'great britain': 'united kingdom',
  'england': 'united kingdom',
  'uae': 'united arab emirates',
  'u.a.e.': 'united arab emirates',
  'emirates': 'united arab emirates',
  'dubai': 'united arab emirates',
  'in': 'india',
  'br': 'brazil',
  'brasil': 'brazil',
  'ae': 'united arab emirates',
  'sg': 'singapore',
  'de': 'germany',
  'fr': 'france',
  'es': 'spain',
  'it': 'italy',
  'nl': 'netherlands',
  'se': 'sweden',
  'ch': 'switzerland',
  'au': 'australia',
  'nz': 'new zealand',
  'ca': 'canada',
  'latam': 'latin america',
  'emea': 'emea',
  'apac': 'apac',
  'dach': 'dach',
  'nordics': 'nordics',
};

const COMPANY_ALIASES: Record<string, string> = {
  'agencies': 'agency',
  'studios': 'studio',
  'firms': 'firm',
  'consultancies': 'consultancy',
  'consulting firms': 'consultancy',
  'dtc brands': 'dtc brand',
  'dtc': 'dtc brand',
  'online stores': 'online store',
  'shopify stores': 'shopify store',
  'clinics': 'clinic',
  'practices': 'practice',
  'law firms': 'law firm',
};

const ALL_ALIASES: Record<string, string> = {
  ...ROLE_ALIASES,
  ...GEO_ALIASES,
  ...COMPANY_ALIASES,
};

/** Normalize a single term to its canonical alias (lowercased). */
export function normalizeAliasTerm(term: unknown): string {
  const l = lower(term);
  if (!l) return '';
  return ALL_ALIASES[l] || l;
}

/** Normalize free text token-by-token for hot-loop matching. */
export function normalizeAliasText(text: unknown): string {
  const t = lower(text);
  if (!t) return '';
  // Fast path: whole-string alias
  if (ALL_ALIASES[t]) return ALL_ALIASES[t];
  return t;
}

/** True if haystack contains needle under alias normalization. */
export function aliasIncludes(haystack: unknown, needle: unknown): boolean {
  const hay = ` ${normalizeAliasText(haystack)} `;
  const ndl = normalizeAliasTerm(needle);
  if (!ndl) return false;
  if (hay.includes(` ${ndl} `)) return true;
  // Also try raw needle for multi-word phrases not in alias table
  const raw = lower(needle);
  if (raw !== ndl && hay.includes(` ${raw} `)) return true;
  // Fallback substring for long phrases (e.g. "manual outbound")
  if (raw.length > 8 && hay.includes(raw)) return true;
  return false;
}

/** Expand a term into [term, ...aliases] for queryable coverage. */
export function expandAliasTerm(term: unknown): string[] {
  const raw = clean(term);
  if (!raw) return [];
  const canon = normalizeAliasTerm(raw);
  const out = new Set<string>([raw]);
  if (canon && canon !== lower(raw)) out.add(canon);
  // Reverse map: canonical -> known surface forms (bounded, max 4)
  let added = 0;
  for (const [k, v] of Object.entries(ALL_ALIASES)) {
    if (v === canon && k !== lower(raw) && added < 3) {
      out.add(k);
      added++;
    }
  }
  return Array.from(out);
}

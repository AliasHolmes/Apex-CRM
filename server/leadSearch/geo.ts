/**
 * Country names come from the runtime's ICU data (Intl.DisplayNames), so every ISO
 * 3166 country is recognized. Legacy labels "USA" and "UK" are kept because stored
 * contracts and tests use them.
 */
const LEGACY_LABELS: Record<string, string> = { US: 'USA', GB: 'UK', UK: 'UK' };
const NON_COUNTRY_CODES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
const ALIASES: Record<string, string> = {
  usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', us: 'US', america: 'US', american: 'US', 'united states of america': 'US',
  uk: 'GB', 'u.k.': 'GB', 'united kingdom': 'GB', britain: 'GB', british: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  uae: 'AE', emirates: 'AE', korea: 'KR', holland: 'NL', newzealand: 'NZ', nz: 'NZ', au: 'AU',
  canadian: 'CA', australian: 'AU', german: 'DE', french: 'FR', dutch: 'NL', irish: 'IE', spanish: 'ES',
  italian: 'IT', swiss: 'CH', swedish: 'SE', japanese: 'JP', indian: 'IN', brazilian: 'BR', mexican: 'MX',
  nigerian: 'NG', kenyan: 'KE', 'south african': 'ZA', emirati: 'AE', saudi: 'SA', singaporean: 'SG',
  turkey: 'TR', 'czech republic': 'CZ', 'ivory coast': 'CI', 'cote d\'ivoire': 'CI', burma: 'MM',
};

const asciiFold = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u2019/g, "'").toLowerCase().trim();

const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
const CODE_BY_KEY = new Map<string, string>();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
for (const first of LETTERS) {
  for (const second of LETTERS) {
    const code = first + second;
    if (NON_COUNTRY_CODES.has(code)) continue;
    let name: string | undefined;
    try {
      name = displayNames.of(code);
    } catch {
      continue;
    }
    if (!name || name === code) continue;
    CODE_BY_KEY.set(name.toLowerCase(), code);
    CODE_BY_KEY.set(asciiFold(name), code);
  }
}
for (const [alias, code] of Object.entries(ALIASES)) CODE_BY_KEY.set(alias, code);

export function resolveCountryCode(term: string): string | null {
  const key = asciiFold(String(term || ''));
  return CODE_BY_KEY.get(key) || null;
}

export function canonicalCountryLabel(term: string): string | undefined {
  const code = resolveCountryCode(term);
  if (!code) return undefined;
  return LEGACY_LABELS[code] || displayNames.of(code) || undefined;
}

export const COUNTRY_CANONICAL_MAP: Record<string, string> = Object.fromEntries(
  Array.from(CODE_BY_KEY.entries()).map(([key, code]) => [key, LEGACY_LABELS[code] || displayNames.of(code) || code]),
);

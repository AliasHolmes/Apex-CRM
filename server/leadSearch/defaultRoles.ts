/**
 * Titles used only when a brief names no role at all. One list for every fallback so
 * the deterministic contract, fallback plan and replenishment queries never disagree.
 */
export const DEFAULT_DECISION_MAKER_ROLES: readonly string[] = ['founder', 'owner', 'CEO', 'managing director'];

/** "Senior software engineers" -> "Senior software engineer"; leaves non-plurals alone. */
export function singularizeRole(phrase: string): string {
  const trimmed = String(phrase || '').trim();
  if (/[^aeiou]ies$/i.test(trimmed)) return trimmed.replace(/ies$/i, 'y');
  if (/(?:ss|us|is)$/i.test(trimmed)) return trimmed;
  return trimmed.replace(/s$/i, '');
}

/** Markdown link scheme the Copilot uses for prospect names, resolved to the lead drawer. */
export const LEAD_LINK_SCHEME = 'apex-lead:';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wraps known prospect names in markdown links (apex-lead:<id>) so the answer can open them.
 * Only plain-text segments are touched; existing links and code spans are left alone.
 */
export function linkProspectNames(content: string, nameToId: ReadonlyMap<string, string>): string {
  if (nameToId.size === 0) return content;
  const present = [...nameToId.keys()].filter((name) => content.includes(name));
  if (present.length === 0) return content;
  present.sort((left, right) => right.length - left.length);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${present.slice(0, 60).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
    'gu',
  );
  return content
    .split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/g)
    .map((segment, index) => (index % 2 === 1
      ? segment
      : segment.replace(pattern, (match) => `[${match}](${LEAD_LINK_SCHEME}${encodeURIComponent(nameToId.get(match) ?? '')})`)))
    .join('');
}

export type ScrapeQuality = 'good' | 'partial' | 'bad';

export type ParsedLinkedInEvidence = {
  quality: ScrapeQuality;
  evidenceBlock: string;
  personName?: string;
  companyName?: string;
  headline?: string;
  location?: string;
  rejectionReason?: string;
};

const BAD_MARKERS = [
  'sign in to view',
  'join linkedin',
  'authwall',
  'captcha',
  'security verification',
  'please verify you are a human',
  'login to linkedin',
  'linkedin login'
];

const NOISE_SECTION_MARKERS = [
  'activity',
  'posts',
  'reactions',
  'comments',
  'featured',
  'recommendations',
  'interests',
  'groups',
  'people also viewed',
  'people you may know',
  'similar profiles',
  'licenses & certifications',
  'volunteering',
  'footer',
  'more profiles'
];

const IMPORTANT_SECTION_MARKERS = [
  'about',
  'summary',
  'experience',
  'education',
  'skills'
];

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

export function normalizeLinkedInUrl(url?: string) {
  if (!url) return '';
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/i);
    if (!match?.[1]) return url.toLowerCase().replace(/\/$/, '').trim();
    return `linkedin.com/in/${match[1].toLowerCase()}`;
  } catch {
    const lowered = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
    const match = lowered.match(/linkedin\.com\/in\/([^/?#]+)/i);
    return match?.[1] ? `linkedin.com/in/${match[1].toLowerCase()}` : lowered;
  }
}

export function extractLinkedInUsername(url?: string) {
  const normalized = normalizeLinkedInUrl(url);
  const match = normalized.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match?.[1]?.toLowerCase() || '';
}

const cleanMarkdownLine = (line: string) => normalizeWhitespace(
  line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
);

const isHeadingLike = (line: string) => {
  const cleaned = cleanMarkdownLine(line).toLowerCase();
  return IMPORTANT_SECTION_MARKERS.includes(cleaned) || NOISE_SECTION_MARKERS.some(marker => cleaned === marker || cleaned.startsWith(`${marker} `));
};

const collectSection = (lines: string[], markers: string[], maxLines: number) => {
  const out: string[] = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = cleanMarkdownLine(rawLine);
    if (!line) continue;
    const lower = line.toLowerCase();

    if (markers.some(marker => lower === marker || lower.startsWith(`${marker} `))) {
      collecting = true;
      continue;
    }

    if (collecting && isHeadingLike(line)) {
      break;
    }

    if (collecting) {
      if (NOISE_SECTION_MARKERS.some(marker => lower === marker || lower.startsWith(`${marker} `))) break;
      out.push(line);
      if (out.length >= maxLines) break;
    }
  }

  return out;
};

const firstUsefulLines = (lines: string[], maxLines: number) => {
  const rejected = new Set([...NOISE_SECTION_MARKERS, ...IMPORTANT_SECTION_MARKERS]);
  return lines
    .map(cleanMarkdownLine)
    .filter(line => {
      const lower = line.toLowerCase();
      return line.length > 1
        && !rejected.has(lower)
        && !lower.includes('linkedin')
        && !lower.includes('cookie')
        && !lower.includes('privacy policy');
    })
    .slice(0, maxLines);
};

const inferName = (headerLines: string[], fallbackTitle?: string) => {
  const fromHeader = headerLines.find(line => {
    const words = line.split(' ').filter(Boolean);
    return words.length >= 2 && words.length <= 5 && !line.includes('|') && !line.includes('@');
  });
  if (fromHeader) return fromHeader;

  const title = cleanMarkdownLine(fallbackTitle || '');
  const linkedInSuffix = /\s+[-|]\s+linkedin.*$/i;
  return title.replace(linkedInSuffix, '').trim() || undefined;
};

const inferHeadline = (headerLines: string[], personName?: string, fallbackSnippet?: string) => {
  const headline = headerLines.find(line => line !== personName && line.length > 15 && line.length < 180);
  if (headline) return headline;
  const snippet = normalizeWhitespace(fallbackSnippet || '');
  return snippet ? snippet.slice(0, 220) : undefined;
};

const inferCompanyFromHeadline = (headline?: string) => {
  if (!headline) return undefined;
  const atMatch = headline.match(/\bat\s+([^|,;]+)/i);
  if (atMatch?.[1]) return cleanMarkdownLine(atMatch[1]).slice(0, 100);
  const founderMatch = headline.match(/(?:founder|owner|ceo|co-founder|partner)\s*(?:&\s*\w+)?\s*(?:of|at)\s+([^|,;]+)/i);
  return founderMatch?.[1] ? cleanMarkdownLine(founderMatch[1]).slice(0, 100) : undefined;
};

export function parseLinkedInEvidence(markdown: string, fallback?: { title?: string; url?: string; snippet?: string }): ParsedLinkedInEvidence {
  const sourceText = markdown || '';
  const compactSource = normalizeWhitespace(sourceText);
  const lowered = compactSource.toLowerCase();

  if (BAD_MARKERS.some(marker => lowered.includes(marker))) {
    const hasProfileContent = lowered.includes('experience') || lowered.includes('education') || lowered.includes('about') || lowered.includes('summary');
    if (!hasProfileContent) {
      return { quality: 'bad', evidenceBlock: '', rejectionReason: 'blocked_or_login_wall' };
    }
  }

  if (!compactSource || compactSource.length < 80) {
    return { quality: 'bad', evidenceBlock: '', rejectionReason: 'empty_or_too_short' };
  }

  const lines = sourceText.split(/\r?\n/).map(cleanMarkdownLine).filter(Boolean);
  const headerLines = firstUsefulLines(lines, 8);
  const about = collectSection(lines, ['about', 'summary'], 6);
  const experience = collectSection(lines, ['experience'], 12);
  const education = collectSection(lines, ['education'], 4);
  const skills = collectSection(lines, ['skills'], 10);

  const personName = inferName(headerLines, fallback?.title);
  const headline = inferHeadline(headerLines, personName, fallback?.snippet);
  const companyName = inferCompanyFromHeadline(headline) || inferCompanyFromHeadline(experience.join(' '));
  const location = headerLines.find(line => /,\s*[A-Z]{2}\b|United States|Canada|United Kingdom|Australia|UAE|Remote/i.test(line));

  const evidenceParts = [
    fallback?.url ? `LINK: ${fallback.url}` : '',
    personName ? `NAME: ${personName}` : '',
    headline ? `HEADLINE: ${headline}` : '',
    location ? `LOCATION: ${location}` : '',
    about.length ? `SUMMARY: ${about.join(' ')}` : '',
    experience.length ? `EXPERIENCE: ${experience.slice(0, 8).join(' | ')}` : '',
    education.length ? `EDUCATION: ${education.slice(0, 3).join(' | ')}` : '',
    skills.length ? `SKILLS: ${skills.slice(0, 10).join(', ')}` : '',
    !about.length && fallback?.snippet ? `TAVILY CONTEXT: ${normalizeWhitespace(fallback.snippet).slice(0, 500)}` : ''
  ].filter(Boolean);

  let evidenceBlock = evidenceParts.join('\n');
  if (evidenceBlock.length > 1800) {
    evidenceBlock = evidenceBlock.slice(0, 1800).replace(/\s+\S*$/, '').trim();
  }

  const hasCoreIdentity = Boolean(personName && (headline || companyName || experience.length));
  const hasRichProfile = about.length > 0 || experience.length >= 3 || skills.length >= 3;
  const quality: ScrapeQuality = hasCoreIdentity && hasRichProfile ? 'good' : hasCoreIdentity ? 'partial' : 'bad';

  return {
    quality,
    evidenceBlock: quality === 'bad' ? '' : evidenceBlock,
    personName,
    companyName,
    headline,
    location,
    rejectionReason: quality === 'bad' ? 'missing_core_identity' : undefined
  };
}

export function buildTavilyEvidence(item: any) {
  const url = item?.url || '';
  const title = item?.title || 'Untitled result';
  const snippet = item?.content || item?.raw_content || '';
  return [
    `LINK: ${url}`,
    `TITLE: ${title}`,
    `[TAVILY SNIPPET]`,
    normalizeWhitespace(snippet).slice(0, 900)
  ].filter(Boolean).join('\n');
}
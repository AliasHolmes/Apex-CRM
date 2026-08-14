import { extractLinkedInUsername, normalizeLinkedInUrl } from '../services/linkedinEvidence.js';

export type ScoutObservation = {
  title: string;
  url: string;
  content: string;
  provider: 'tavily' | 'brightdata';
  query: string;
  round: number;
  family?: string;
  lane?: string;
  intent?: string;
  expectedSignal?: string;
  raw: Record<string, any>;
};

export type FusedObservation = ScoutObservation & {
  identityKey: string;
  sourceCount: number;
  sourceProviders: Array<'tavily' | 'brightdata'>;
  sourceQueries: string[];
  lanes: string[];
  corroborated: boolean;
};

const normalize = (value: unknown) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function observationIdentity(observation: Pick<ScoutObservation, 'url' | 'title' | 'content'>) {
  const username = extractLinkedInUsername(observation.url);
  if (username) return `linkedin:${username}`;
  const normalizedUrl = normalizeLinkedInUrl(observation.url) || normalize(observation.url).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (normalizedUrl) return `url:${normalizedUrl}`;
  return `text:${normalize(`${observation.title} ${observation.content}`).slice(0, 220)}`;
}

/** Merge providers' observations before LLM extraction, keeping provenance. */
export function fuseObservations(observations: ScoutObservation[]): FusedObservation[] {
  const byIdentity = new Map<string, FusedObservation>();
  for (const observation of observations) {
    const identityKey = observationIdentity(observation);
    if (!identityKey || identityKey === 'text:') continue;
    const existing = byIdentity.get(identityKey);
    if (!existing) {
      byIdentity.set(identityKey, {
        ...observation,
        identityKey,
        sourceCount: 1,
        sourceProviders: [observation.provider],
        sourceQueries: [observation.query],
        lanes: observation.lane ? [observation.lane] : [],
        corroborated: false
      });
      continue;
    }
    existing.sourceCount += 1;
    if (!existing.sourceProviders.includes(observation.provider)) existing.sourceProviders.push(observation.provider);
    if (!existing.sourceQueries.includes(observation.query)) existing.sourceQueries.push(observation.query);
    if (observation.lane && !existing.lanes.includes(observation.lane)) existing.lanes.push(observation.lane);
    if (observation.content.length > existing.content.length) {
      existing.content = observation.content;
      existing.title = observation.title || existing.title;
      existing.url = observation.url || existing.url;
      existing.raw = observation.raw;
    }
    existing.corroborated = existing.sourceProviders.length > 1 || existing.sourceCount > 1;
  }
  return Array.from(byIdentity.values());
}

export type SignalBlock = {
  companyName: string;
  text: string;
  url: string;
  query: string;
  lane: string;
  round: number;
  provider: 'tavily' | 'brightdata';
};

const cleanCompanyHint = (value: unknown) => String(value || '')
  .replace(/\s+/g, ' ')
  .replace(/^[#@]+/, '')
  .trim()
  .slice(0, 80);

const COMPANY_HINT_BLOCKLIST = new Set([
  'short notice', 'home', 'large', 'will', 'present', 'remote', 'available',
  'your service', 'your company', 'clients', 'request', 'application',
  'stealth', 'freelance', 'self employed', 'confidential', 'various'
]);

const looksLikeCompanyHint = (value: string) => {
  const candidate = cleanCompanyHint(value);
  if (candidate.length < 3 || candidate.length > 80) return false;
  if (!/[a-z0-9]/i.test(candidate)) return false;
  const lower = candidate.toLowerCase();
  if (COMPANY_HINT_BLOCKLIST.has(lower)) return false;
  if (/\b(hiring|job|jobs|careers|work|apply|vacancy|position|role)\b/i.test(candidate)) return false;
  if (/\b(connections?|followers?|people also viewed|about|experience|education)\b/i.test(candidate)) return false;
  if (/\b(available at|open to|looking for|seeking|working at)\b/i.test(lower)) return false;
  if (/^[\d\s,.-]+$/.test(candidate)) return false;
  return true;
};

const companyFromHostedJobUrl = (url: URL) => {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'jobs.lever.co' || host === 'boards.greenhouse.io' || host === 'jobs.ashbyhq.com') {
    return cleanCompanyHint(segments[0]);
  }
  if (host === 'apply.workable.com') {
    return cleanCompanyHint(segments[0]);
  }
  return '';
};

const companyFromDomain = (url: URL) => {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const blockedDomains = [
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'angellist.com',
    'wellfound.com', 'lever.co', 'greenhouse.io', 'ashbyhq.com', 'workable.com'
  ];
  if (blockedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return '';

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const compoundSuffix = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/i.test(labels.slice(-2).join('.'));
  const companyLabel = compoundSuffix ? labels.at(-3) : labels.at(-2);
  return cleanCompanyHint(String(companyLabel || '').replace(/[-_]+/g, ' '));
};

/** Returns true for open-web observations produced by an explicit signal lane. */
export function isSignalObservation(obs: FusedObservation): boolean {
  if (extractLinkedInUsername(obs.url)) return false;
  return obs.lane === 'signal'
    || obs.lanes.includes('signal')
    || obs.intent === 'find_buying_signal';
}

/**
 * Best-effort company name extraction from a non-LinkedIn observation using deterministic heuristics.
 * Returns empty string when heuristics are inconclusive (triggers LLM fallback).
 */
export function extractCompanyHintDeterministic(obs: FusedObservation): string {
  const rawCompany = cleanCompanyHint(
    obs.raw?.currentCompany
    || obs.raw?.company
    || obs.raw?.companyName
    || obs.raw?.organization
  );
  if (looksLikeCompanyHint(rawCompany)) return rawCompany;

  // Strategy 1: multi-part page title, such as "n8n Developer | TechFlow AI".
  const titleParts = obs.title.split(/\s+(?:\||-|:|\u2013|\u2014)\s+/);
  if (titleParts.length > 1) {
    const lastPart = cleanCompanyHint(titleParts.at(-1));
    if (looksLikeCompanyHint(lastPart)) return lastPart;
  }

  // Strategy 2: "TechFlow AI is hiring..." in the title or opening content.
  const hiringMatch = `${obs.title}\n${obs.content.slice(0, 240)}`.match(
    /(?:^|\n)([A-Z][A-Za-z0-9&.' -]{2,60})\s+(?:is\s+)?(?:hiring|looking for|seeking)\b/i
  );
  const hiringCompany = cleanCompanyHint(hiringMatch?.[1]);
  if (looksLikeCompanyHint(hiringCompany)) return hiringCompany;

  // Strategy 3: hosted-job path or registrable domain.
  try {
    const url = new URL(obs.url);
    const hostedJobCompany = companyFromHostedJobUrl(url);
    if (looksLikeCompanyHint(hostedJobCompany)) return hostedJobCompany;
    const domainCompany = companyFromDomain(url);
    if (looksLikeCompanyHint(domainCompany)) return domainCompany;
  } catch {}

  return '';
}

/** Extract a company hint from a LinkedIn profile observation without spending an LLM call. */
export function extractCompanyHintFromProfile(obs: FusedObservation): string {
  const rawCompany = cleanCompanyHint(
    obs.raw?.currentCompany
    || obs.raw?.company
    || obs.raw?.companyName
    || obs.raw?.organization
  );
  if (looksLikeCompanyHint(rawCompany)) return rawCompany;

  const text = `${obs.title}\n${obs.content.slice(0, 800)}`;
  const atCompany = text.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.' -]{2,80})(?=\s*(?:\||\n|,|\u2013|\u2014|$))/);
  const inlineCompany = cleanCompanyHint(atCompany?.[1]);
  if (looksLikeCompanyHint(inlineCompany)) return inlineCompany;

  const lines = obs.content
    .split(/\r?\n/)
    .map(line => cleanCompanyHint(line.replace(/^#+\s*/, '')))
    .filter(Boolean);
  if (lines.length >= 2 && looksLikeCompanyHint(lines[1])) return lines[1];

  return '';
}

/** Async version: deterministic heuristics first, then an optional bounded LLM fallback. */
export async function extractCompanyHintFromSignal(
  obs: FusedObservation,
  llmCall?: <T>(prompt: string, schema: any, systemInstruction?: string, options?: any) => Promise<T>
): Promise<string> {
  const deterministic = extractCompanyHintDeterministic(obs);
  if (deterministic) return deterministic;

  if (!llmCall || obs.content.length < 120) return '';

  try {
    const result = await llmCall<{ company: string }>(
      `Extract the hiring company name from this web page snippet.\n\nTitle: ${obs.title}\nURL: ${obs.url}\nContent (first 400 chars): ${obs.content.slice(0, 400)}`,
      {
        type: 'OBJECT',
        properties: { company: { type: 'STRING' } },
        required: ['company']
      },
      'You extract company names. Return only the company name, or an empty string if unknown.',
      { maxTokens: 40, temperature: 0 }
    );
    return (result?.company || '').trim().slice(0, 80);
  } catch {
    return '';
  }
}

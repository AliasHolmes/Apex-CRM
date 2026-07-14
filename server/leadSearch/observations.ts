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

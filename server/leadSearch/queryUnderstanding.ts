/**
 * Phase 1: Query Understanding Layer.
 * Complexity classifier + unified geo resolver + missing-slot detection.
 *
 * Zero default-invention rule: when a brief specifies no geography,
 * resolveGeo() returns geo=open_global with invented=false and NO
 * countryAnchor/metros. Callers must not inject USA/US hubs.
 */
import { COUNTRY_CANONICAL_MAP, COUNTRY_TO_METROS } from './prospectContract.js';

export type QueryTier = 'vague' | 'standard' | 'rich';
export type MissingSlot = 'role' | 'geo' | 'industry' | 'seniority' | 'signal';

export type QueryComplexity = {
  tier: QueryTier;
  ambiguityScore: number;
  missingSlots: MissingSlot[];
  wordCount: number;
  entityCount: number;
  hasIntentTrigger: boolean;
};

export type GeoResolution = {
  geo: string;
  countryAnchor: string | null;
  metros: string[];
  invented: boolean;
};

const clean = (v: unknown) => String(v || '').replace(/\s+/g, ' ').trim();
const lower = (v: unknown) => clean(v).toLowerCase();

const INTENT_TRIGGER = /\b(hiring|recruiting|looking\s+for|seeking|using|evaluating|migrating|switching|scaling\s+past|manual\s+process|bottleneck|open\s+role|partner\s+program|white\s*label|subcontract|funding|funded|series|expanding|churn|automation|workflows?)\b/i;

const ROLE_HINT = /\b(founder|owner|ceo|cto|cmo|cfo|coo|cro|president|partner|director|vp|vice president|head|chief|manager|coach|doctor|lawyer|owner|managing director|principal|lead)\b/i;
const INDUSTRY_HINT = /\b(saas|agency|agencies|clinic|hospital|shopify|ecommerce|manufacturing|law|coaching|fintech|biotech|consulting|studio|firm|dental|real estate|solar|recruiting)\b/i;
const SENIORITY_HINT = /\b(senior|junior|lead|principal|executive|founder|partner|director|vp|chief|c-level|decision maker)\b/i;
const SIGNAL_HINT = /\b(hiring|using|need|pain|bottleneck|manual|scaling|migrating|funded|expanding|growth|buying)\b/i;

export function resolveGeo(brief: unknown): GeoResolution {
  const text = lower(brief);
  if (!text) return { geo: 'open_global', countryAnchor: null, metros: [], invented: false };
  // Longest-key-first scan so "united states" wins over "us"
  const keys = Object.keys(COUNTRY_CANONICAL_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // Skip 2-letter codes in short-text scan to avoid false positives ("in", "us" inside words);
    // require word-boundary match and for 2-char keys require len>12 chars context or explicit pattern
    const escaped = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!re.test(text)) continue;
    if (key.length <= 2) {
      // Guard: single common words -- demand the brief also mentions a metro or explicit geo cue,
      // or the key is uppercase in the raw brief (e.g. "IN", "BR", "AE").
      const raw = String(brief || '');
      const upperHit = new RegExp(`\\b${escaped.toUpperCase()}\\b`).test(raw);
      const metroHit = (COUNTRY_TO_METROS[key] || []).some(m => text.includes(m.toLowerCase()));
      if (!upperHit && !metroHit && text.length < 24) continue;
    }
    const canonical = COUNTRY_CANONICAL_MAP[key];
    const metros = COUNTRY_TO_METROS[key] || COUNTRY_TO_METROS[canonical.toLowerCase()] || [];
    return { geo: canonical.toLowerCase().replace(/\s+/g, '_'), countryAnchor: canonical, metros: [...metros], invented: false };
  }
  // Explicit region words without country mapping
  if (/\b(remote|worldwide|global|anywhere|emea|apac|latam|dach|nordics)\b/i.test(text)) {
    return { geo: lower(text.match(/\b(remote|worldwide|global|anywhere|emea|apac|latam|dach|nordics)\b/i)?.[1] || 'global'), countryAnchor: null, metros: [], invented: false };
  }
  return { geo: 'open_global', countryAnchor: null, metros: [], invented: false };
}

export function detectMissingSlots(brief: unknown): MissingSlot[] {
  const text = String(brief || '');
  const missing: MissingSlot[] = [];
  if (!ROLE_HINT.test(text)) missing.push('role');
  const geo = resolveGeo(text);
  if (geo.geo === 'open_global') missing.push('geo');
  if (!INDUSTRY_HINT.test(text)) missing.push('industry');
  if (!SENIORITY_HINT.test(text)) missing.push('seniority');
  if (!SIGNAL_HINT.test(text)) missing.push('signal');
  return missing;
}

export function classifyQueryComplexity(brief: unknown): QueryComplexity {
  const text = clean(brief);
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const hasIntentTrigger = INTENT_TRIGGER.test(text);
  // Entity count: distinct role/geo/industry/tooling cues (cheap deterministic proxy)
  let entityCount = 0;
  if (ROLE_HINT.test(text)) entityCount++;
  if (resolveGeo(text).geo !== 'open_global') entityCount++;
  if (INDUSTRY_HINT.test(text)) entityCount++;
  if (/\b(hubspot|salesforce|n8n|zapier|shopify|klaviyo|notion|airtable|supabase|clio|quickbooks|sap|epic|omnisend)\b/i.test(text)) entityCount++;
  if (/\b\d+\s*(-\s*\d+)?\s*(employees|staff|people)\b/i.test(text)) entityCount++;
  if (hasIntentTrigger) entityCount++;

  let tier: QueryTier = 'vague';
  if (wordCount >= 18 || entityCount >= 4) tier = 'rich';
  else if (wordCount >= 5 || entityCount >= 2) tier = 'standard';

  const missingSlots = detectMissingSlots(text);
  // Ambiguity: vague short briefs with many missing slots score high
  const ambiguityScore = Math.min(1, Math.max(0,
    (missingSlots.length / 5) * 0.6 +
    (wordCount <= 2 ? 0.4 : wordCount <= 5 ? 0.2 : 0) +
    (tier === 'rich' ? -0.3 : 0),
  ));

  return { tier, ambiguityScore: Number(ambiguityScore.toFixed(2)), missingSlots, wordCount, entityCount, hasIntentTrigger };
}

/** Salience compression for rich briefs: rank sentences, cap at ~150 tokens. */
export function compressBriefForPrompt(brief: unknown, maxChars = 900): string {
  const text = clean(brief);
  if (text.length <= maxChars) return text;
  const sentences = text.split(/(?<=[.!?;])\s+|\s*\|\s*|,\s*(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
  if (sentences.length <= 1) return text.slice(0, maxChars);
  const scored = sentences.map(s => {
    let score = 0;
    if (ROLE_HINT.test(s)) score += 3;
    if (INDUSTRY_HINT.test(s)) score += 2;
    if (INTENT_TRIGGER.test(s)) score += 2;
    if (resolveGeo(s).geo !== 'open_global') score += 2;
    score += Math.min(2, s.split(/\s+/).length / 10);
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  let out = '';
  for (const { s } of scored) {
    if ((out + ' ' + s).trim().length > maxChars) break;
    out = (out + ' ' + s).trim();
  }
  return out || text.slice(0, maxChars);
}

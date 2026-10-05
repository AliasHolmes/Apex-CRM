import type { Lead, LeadStage, NextAction, ReviewStatus } from '../types';
import { PIPELINE_STAGE_IDS } from './pipeline';
import { NEXT_ACTION_OPTIONS, REVIEW_STATUS_OPTIONS } from './prospectWorkflow';
import { getMatchScore } from './matchScore';

export type ProspectSortKey = 'name' | 'company' | 'added' | 'score';
export type SortDirection = 'asc' | 'desc';

export interface ProspectSort {
  key: ProspectSortKey;
  direction: SortDirection;
}

export type ProspectColumnId =
  | 'contact'
  | 'title'
  | 'company'
  | 'stage'
  | 'nextAction'
  | 'signals'
  | 'authority'
  | 'added'
  | 'score';

export const PROSPECT_COLUMNS: ReadonlyArray<{ id: ProspectColumnId; label: string; required?: boolean }> = [
  { id: 'contact', label: 'Contact', required: true },
  { id: 'title', label: 'Title' },
  { id: 'company', label: 'Company' },
  { id: 'stage', label: 'Stage' },
  { id: 'nextAction', label: 'Next action' },
  { id: 'signals', label: 'Buying signals' },
  { id: 'authority', label: 'Authority and match' },
  { id: 'added', label: 'Added' },
  { id: 'score', label: 'Match score' },
];

export type ProspectDensity = 'comfortable' | 'compact';

export interface ProspectFilters {
  search: string;
  stage: LeadStage | 'All';
  review: ReviewStatus | 'All';
  nextAction: NextAction | 'All';
  location: string;
  industry: string;
  /** 'WHY_NOW' keeps prospects with a recent, evidenced buying signal. */
  signal: 'All' | 'WHY_NOW';
}

export const EMPTY_PROSPECT_FILTERS: ProspectFilters = {
  search: '',
  stage: 'All',
  review: 'All',
  nextAction: 'All',
  location: 'All',
  industry: 'All',
  signal: 'All',
};

export interface ProspectView {
  id: string;
  name: string;
  filters: ProspectFilters;
  sort: ProspectSort | null;
  density: ProspectDensity;
  hiddenColumns: ProspectColumnId[];
}

export const PROSPECT_VIEWS_STORAGE_KEY = 'apex-prospect-views';
const VIEWS_VERSION = 1;
const MAX_VIEWS = 25;

const SORT_KEYS: readonly ProspectSortKey[] = ['name', 'company', 'added', 'score'];
const COLUMN_IDS = PROSPECT_COLUMNS.map((column) => column.id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function sanitizeFilters(raw: unknown): ProspectFilters {
  const source = isRecord(raw) ? raw : {};
  return {
    search: asString(source.search, ''),
    stage: oneOf<LeadStage | 'All'>(source.stage, ['All', ...PIPELINE_STAGE_IDS], 'All'),
    review: oneOf<ReviewStatus | 'All'>(source.review, ['All', ...REVIEW_STATUS_OPTIONS.map((option) => option.value)], 'All'),
    nextAction: oneOf<NextAction | 'All'>(source.nextAction, ['All', ...NEXT_ACTION_OPTIONS.map((option) => option.value)], 'All'),
    location: asString(source.location, 'All') || 'All',
    industry: asString(source.industry, 'All') || 'All',
    signal: source.signal === 'WHY_NOW' ? 'WHY_NOW' : 'All',
  };
}

function sanitizeSort(raw: unknown): ProspectSort | null {
  if (!isRecord(raw)) return null;
  if (!(SORT_KEYS as readonly unknown[]).includes(raw.key)) return null;
  return { key: raw.key as ProspectSortKey, direction: raw.direction === 'desc' ? 'desc' : 'asc' };
}

function sanitizeHiddenColumns(raw: unknown): ProspectColumnId[] {
  if (!Array.isArray(raw)) return [];
  const required = new Set(PROSPECT_COLUMNS.filter((column) => column.required).map((column) => column.id));
  const hidden = raw.filter(
    (id): id is ProspectColumnId => (COLUMN_IDS as readonly unknown[]).includes(id) && !required.has(id as ProspectColumnId),
  );
  return Array.from(new Set(hidden));
}

/** Tolerant parse: unknown shapes, old versions, and corrupt JSON all degrade to "no views". */
export function parseStoredViews(raw: string | null): ProspectView[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== VIEWS_VERSION || !Array.isArray(parsed.views)) return [];

  const views: ProspectView[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed.views) {
    if (!isRecord(item)) continue;
    const id = asString(item.id, '').trim();
    const name = asString(item.name, '').trim();
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    views.push({
      id,
      name: name.slice(0, 60),
      filters: sanitizeFilters(item.filters),
      sort: sanitizeSort(item.sort),
      density: item.density === 'compact' ? 'compact' : 'comfortable',
      hiddenColumns: sanitizeHiddenColumns(item.hiddenColumns),
    });
    if (views.length >= MAX_VIEWS) break;
  }
  return views;
}

export function serializeViews(views: readonly ProspectView[]): string {
  return JSON.stringify({ version: VIEWS_VERSION, views: views.slice(0, MAX_VIEWS) });
}

export function createViewId(): string {
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function countActiveFilters(filters: ProspectFilters): number {
  let count = 0;
  if (filters.search.trim()) count += 1;
  if (filters.stage !== 'All') count += 1;
  if (filters.review !== 'All') count += 1;
  if (filters.nextAction !== 'All') count += 1;
  if (filters.location !== 'All') count += 1;
  if (filters.industry !== 'All') count += 1;
  if (filters.signal !== 'All') count += 1;
  return count;
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? '').localeCompare(right ?? '', undefined, { sensitivity: 'base' });
}

/** Stable sort. Prospects without a value (no score, bad date) always sort last. */
export function sortLeads(leads: readonly Lead[], sort: ProspectSort | null): Lead[] {
  if (!sort) return [...leads];
  const direction = sort.direction === 'asc' ? 1 : -1;
  const decorated = leads.map((lead, index) => ({ lead, index }));

  decorated.sort((left, right) => {
    let result = 0;
    if (sort.key === 'name') {
      result = compareText(left.lead.profile?.fullName, right.lead.profile?.fullName) * direction;
    } else if (sort.key === 'company') {
      result = compareText(left.lead.profile?.currentCompany, right.lead.profile?.currentCompany) * direction;
    } else {
      const leftValue = sort.key === 'score' ? getMatchScore(left.lead) : Date.parse(left.lead.createdAt);
      const rightValue = sort.key === 'score' ? getMatchScore(right.lead) : Date.parse(right.lead.createdAt);
      const leftMissing = leftValue === null || !Number.isFinite(leftValue);
      const rightMissing = rightValue === null || !Number.isFinite(rightValue);
      if (leftMissing && rightMissing) result = 0;
      else if (leftMissing) result = 1;
      else if (rightMissing) result = -1;
      else result = ((leftValue as number) - (rightValue as number)) * direction;
    }
    return result !== 0 ? result : left.index - right.index;
  });

  return decorated.map((entry) => entry.lead);
}

export const PROSPECT_TABLE_PREFS_KEY = 'apex-prospect-table-prefs';

export interface ProspectTablePrefs {
  density: ProspectDensity;
  hiddenColumns: ProspectColumnId[];
}

export function parseTablePrefs(raw: string | null): ProspectTablePrefs {
  const fallback: ProspectTablePrefs = { density: 'comfortable', hiddenColumns: [] };
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    return {
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      hiddenColumns: sanitizeHiddenColumns(parsed.hiddenColumns),
    };
  } catch {
    return fallback;
  }
}

export function serializeTablePrefs(prefs: ProspectTablePrefs): string {
  return JSON.stringify(prefs);
}

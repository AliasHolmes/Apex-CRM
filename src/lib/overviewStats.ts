import type { Lead } from '../types';
import { getMatchScore } from './matchScore';
import { getLeadProvenance, getNextAction, getReviewStatus } from './prospectWorkflow';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-midnight timestamp for the day containing `time`. */
function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Prospects added per calendar day, oldest first, ending today. */
export function bucketAddsByDay(leads: readonly Lead[], days: number, now: number = Date.now()): number[] {
  const today = startOfDay(now);
  const buckets = new Array<number>(days).fill(0);
  for (const lead of leads) {
    const created = Date.parse(lead.createdAt);
    if (!Number.isFinite(created)) continue;
    const dayOffset = Math.round((today - startOfDay(created)) / DAY_MS);
    if (dayOffset >= 0 && dayOffset < days) buckets[days - 1 - dayOffset] += 1;
  }
  return buckets;
}

export interface WeekOverWeek {
  thisWeek: number;
  previousWeek: number;
  /** Percent change versus the previous 7 days, or null when there is no baseline. */
  changePercent: number | null;
}

export function weekOverWeek(leads: readonly Lead[], now: number = Date.now()): WeekOverWeek {
  const daily = bucketAddsByDay(leads, 14, now);
  const previousWeek = daily.slice(0, 7).reduce((sum, count) => sum + count, 0);
  const thisWeek = daily.slice(7).reduce((sum, count) => sum + count, 0);
  const changePercent = previousWeek > 0 ? Math.round(((thisWeek - previousWeek) / previousWeek) * 100) : null;
  return { thisWeek, previousWeek, changePercent };
}

export interface TodayCounts {
  whyNow: number;
  unreviewed: number;
  readyToMessage: number;
  readyToConnect: number;
}

export function countTodayItems(leads: readonly Lead[]): TodayCounts {
  const counts: TodayCounts = { whyNow: 0, unreviewed: 0, readyToMessage: 0, readyToConnect: 0 };
  for (const lead of leads) {
    const evidence = getLeadProvenance(lead).postIntentEvidence;
    if (evidence && evidence.quality !== 'none') counts.whyNow += 1;
    if (getReviewStatus(lead) === 'UNREVIEWED') counts.unreviewed += 1;
    const nextAction = getNextAction(lead);
    if (nextAction === 'MESSAGE') counts.readyToMessage += 1;
    if (nextAction === 'CONNECT') counts.readyToConnect += 1;
  }
  return counts;
}

export function countStrongMatches(leads: readonly Lead[], threshold = 80): number {
  let count = 0;
  for (const lead of leads) {
    const score = getMatchScore(lead);
    if (score !== null && score >= threshold) count += 1;
  }
  return count;
}

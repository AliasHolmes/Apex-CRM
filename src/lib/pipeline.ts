import type { LeadStage } from '@/types';

export interface PipelineStageMeta {
  id: LeadStage;
  label: string;
  shortLabel: string;
  badgeClassName: string;
  dotClassName: string;
}

export const PIPELINE_STAGES: readonly PipelineStageMeta[] = [
  {
    id: 'SCRAPED',
    label: '1. Scraped',
    shortLabel: 'Scraped',
    badgeClassName: 'border-slate-600/60 bg-slate-500/10 text-slate-300',
    dotClassName: 'bg-indigo-400',
  },
  {
    id: 'ENRICHED',
    label: '2. Enriched',
    shortLabel: 'Enriched',
    badgeClassName: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
    dotClassName: 'bg-purple-400',
  },
  {
    id: 'SEQUENCE ACTIVE',
    label: '3. Sequence Active',
    shortLabel: 'Sequence active',
    badgeClassName: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
    dotClassName: 'bg-cyan-400',
  },
  {
    id: 'REPLIED',
    label: '4. Replied',
    shortLabel: 'Replied',
    badgeClassName: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    dotClassName: 'bg-orange-400',
  },
  {
    id: 'MEETING BOOKED',
    label: '5. Meeting Booked',
    shortLabel: 'Meeting booked',
    badgeClassName: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    dotClassName: 'bg-emerald-400',
  },
  {
    id: 'NEGOTIATING',
    label: '6. Negotiating',
    shortLabel: 'Negotiating',
    badgeClassName: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    dotClassName: 'bg-blue-400',
  },
  {
    id: 'CONVERTED',
    label: '7. Converted',
    shortLabel: 'Converted',
    badgeClassName: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    dotClassName: 'bg-emerald-500',
  },
  {
    id: 'NURTURE',
    label: 'Nurture',
    shortLabel: 'Nurture',
    badgeClassName: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    dotClassName: 'bg-amber-400',
  },
  {
    id: 'LOST',
    label: 'Lost',
    shortLabel: 'Lost',
    badgeClassName: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
    dotClassName: 'bg-rose-400',
  },
] as const;

export const PIPELINE_STAGE_IDS = PIPELINE_STAGES.map((stage) => stage.id);

export const NEXT_PIPELINE_STAGE: Partial<Record<LeadStage, LeadStage>> = {
  SCRAPED: 'ENRICHED',
  ENRICHED: 'SEQUENCE ACTIVE',
  'SEQUENCE ACTIVE': 'REPLIED',
  REPLIED: 'MEETING BOOKED',
  'MEETING BOOKED': 'NEGOTIATING',
  NEGOTIATING: 'CONVERTED',
  NURTURE: 'SEQUENCE ACTIVE',
};

// Only the linear sales funnel has a meaningful "move back" action. Nurture
// and Lost are side exits, so deriving this map from display order would create
// misleading transitions between unrelated states.
export const PREVIOUS_PIPELINE_STAGE: Partial<Record<LeadStage, LeadStage>> = {
  ENRICHED: 'SCRAPED',
  'SEQUENCE ACTIVE': 'ENRICHED',
  REPLIED: 'SEQUENCE ACTIVE',
  'MEETING BOOKED': 'REPLIED',
  NEGOTIATING: 'MEETING BOOKED',
  CONVERTED: 'NEGOTIATING',
};

export function getPipelineStageDomId(stage: LeadStage): string {
  return `pipeline-stage-${stage.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

const PIPELINE_STAGE_BY_ID = new Map(
  PIPELINE_STAGES.map((stage) => [stage.id, stage] as const),
);

export function getPipelineStageMeta(stage: LeadStage): PipelineStageMeta {
  return PIPELINE_STAGE_BY_ID.get(stage) ?? PIPELINE_STAGES[0];
}

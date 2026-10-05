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
    badgeClassName: 'border-stage-1/40 bg-stage-1/10 text-foreground',
    dotClassName: 'bg-stage-1',
  },
  {
    id: 'ENRICHED',
    label: '2. Enriched',
    shortLabel: 'Enriched',
    badgeClassName: 'border-stage-2/40 bg-stage-2/10 text-foreground',
    dotClassName: 'bg-stage-2',
  },
  {
    id: 'SEQUENCE ACTIVE',
    label: '3. Sequence Active',
    shortLabel: 'Sequence active',
    badgeClassName: 'border-stage-3/40 bg-stage-3/10 text-foreground',
    dotClassName: 'bg-stage-3',
  },
  {
    id: 'REPLIED',
    label: '4. Replied',
    shortLabel: 'Replied',
    badgeClassName: 'border-stage-4/40 bg-stage-4/10 text-foreground',
    dotClassName: 'bg-stage-4',
  },
  {
    id: 'MEETING BOOKED',
    label: '5. Meeting Booked',
    shortLabel: 'Meeting booked',
    badgeClassName: 'border-stage-5/40 bg-stage-5/10 text-foreground',
    dotClassName: 'bg-stage-5',
  },
  {
    id: 'NEGOTIATING',
    label: '6. Negotiating',
    shortLabel: 'Negotiating',
    badgeClassName: 'border-stage-6/40 bg-stage-6/10 text-foreground',
    dotClassName: 'bg-stage-6',
  },
  {
    id: 'CONVERTED',
    label: '7. Converted',
    shortLabel: 'Converted',
    badgeClassName: 'border-stage-7/40 bg-stage-7/10 text-foreground',
    dotClassName: 'bg-stage-7',
  },
  {
    id: 'NURTURE',
    label: 'Nurture',
    shortLabel: 'Nurture',
    badgeClassName: 'border-stage-8/40 bg-stage-8/10 text-foreground',
    dotClassName: 'bg-stage-8',
  },
  {
    id: 'LOST',
    label: 'Lost',
    shortLabel: 'Lost',
    badgeClassName: 'border-stage-9/40 bg-stage-9/10 text-foreground',
    dotClassName: 'bg-stage-9',
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

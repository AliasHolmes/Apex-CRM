// @license Apache-2.0

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Compass,
  Flame,
  GripVertical,
  MapPin,
  Search,
  SquareArrowRight,
} from 'lucide-react';
import type { Lead, LeadStage } from '../types';
import {
  getPipelineStageDomId,
  NEXT_PIPELINE_STAGE,
  PIPELINE_STAGES,
  PREVIOUS_PIPELINE_STAGE,
} from '@/lib/pipeline';
import { useToast } from '@/context/ToastContext';
import { useLeads } from '@/context/LeadContext';
import { getNextAction, getNextActionLabel, getReviewStatus, getReviewStatusLabel } from '@/lib/prospectWorkflow';
import { getMatchScore } from '@/lib/matchScore';
import { formatRelativeTime } from '@/lib/relativeTime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CrmPipelineProps {
  leads: Lead[];
  onUpdateLeadStage: (leadId: string, stage: Lead['stage']) => void | Promise<void>;
  onOpenLead: (leadId: string) => void;
  onSelectLeadForOutreach: (lead: Lead) => void;
}

const COLUMN_PAGE_SIZE = 30;

function getIndustry(lead: Lead): string {
  return lead.profile?.industry?.trim() || 'Tech';
}

function getStageLabel(stage: LeadStage): string {
  return PIPELINE_STAGES.find((candidate) => candidate.id === stage)?.shortLabel ?? stage;
}

const REVIEW_BADGE_VARIANT = {
  KEEP: 'success',
  MAYBE: 'warning',
  REJECT: 'danger',
  UNREVIEWED: 'outline',
} as const;

/** Arrow left/right jump a dragged card to the neighbouring stage column. */
const columnKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { droppableRects, droppableContainers, collisionRect } },
) => {
  if (!collisionRect) return undefined;
  if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') return undefined;
  event.preventDefault();

  const columns = droppableContainers
    .getEnabled()
    .map((container) => ({ rect: droppableRects.get(container.id) }))
    .filter((column): column is { rect: NonNullable<typeof column.rect> } => Boolean(column.rect))
    .sort((left, right) => left.rect.left - right.rect.left);
  if (columns.length === 0) return undefined;

  const centerX = collisionRect.left + collisionRect.width / 2;
  let currentIndex = columns.findIndex(({ rect }) => centerX >= rect.left && centerX <= rect.right);
  if (currentIndex === -1) currentIndex = 0;
  const step = event.code === 'ArrowRight' ? 1 : -1;
  const target = columns[Math.min(columns.length - 1, Math.max(0, currentIndex + step))].rect;
  return { x: target.left + 12, y: target.top + 72 };
};

interface LeadCardBodyProps {
  lead: Lead;
  onOpen?: () => void;
  openProps?: Record<string, unknown>;
}

/** Visual content of a card. Shared by the draggable card and the drag overlay. */
function LeadCardBody({ lead, onOpen, openProps }: LeadCardBodyProps) {
  const score = getMatchScore(lead);
  const nextAction = getNextAction(lead);
  const reviewStatus = getReviewStatus(lead);
  const hasWhyNow = Boolean(lead.postIntentEvidence && lead.postIntentEvidence.quality !== 'none');
  const added = formatRelativeTime(lead.createdAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      {...openProps}
      className="block w-full touch-manipulation p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={`Open details for ${lead.profile.fullName}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm font-extrabold text-foreground">{lead.profile.fullName}</h3>
        {score !== null && (
          <Badge variant={score >= 80 ? 'success' : score >= 60 ? 'brand' : 'outline'} className="shrink-0 px-1.5 py-0.5">
            {score}
          </Badge>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs font-bold text-muted-foreground">
        {lead.profile.currentTitle || 'Professional'}
      </p>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Briefcase aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{lead.profile.currentCompany || 'Independent'}</span>
      </div>
      {lead.profile.location && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate">{lead.profile.location}</span>
        </div>
      )}
      {Boolean(lead.companyAccount?.buyingSignals?.length) && (
        <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-success">
          <Compass aria-hidden="true" className="h-3.5 w-3.5" />
          <span>
            {lead.companyAccount!.buyingSignals.length} company signals, pain{' '}
            {lead.companyAccount!.operationalPainScore ?? 0}
          </span>
        </div>
      )}
      {(hasWhyNow || nextAction !== 'NONE' || reviewStatus !== 'UNREVIEWED') && (
        <div className="mt-3 flex flex-wrap gap-1">
          {hasWhyNow && (
            <Badge variant="warning" className="gap-1 px-1.5 py-0.5">
              <Flame aria-hidden="true" className="h-3 w-3" />
              Why now
            </Badge>
          )}
          {nextAction !== 'NONE' && (
            <Badge variant="info" className="gap-1 px-1.5 py-0.5">
              <SquareArrowRight aria-hidden="true" className="h-3 w-3" />
              {getNextActionLabel(nextAction)}
            </Badge>
          )}
          {reviewStatus !== 'UNREVIEWED' && (
            <Badge variant={REVIEW_BADGE_VARIANT[reviewStatus]} className="px-1.5 py-0.5">
              {getReviewStatusLabel(reviewStatus)}
            </Badge>
          )}
        </div>
      )}
      {Boolean(lead.tags?.length) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {lead.tags?.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="px-1.5 py-0.5 text-xs font-bold">{tag}</Badge>
          ))}
          {(lead.tags?.length || 0) > 2 && (
            <span className="self-center text-xs font-bold text-muted-foreground">+{(lead.tags?.length || 0) - 2} more</span>
          )}
        </div>
      )}
      {added && <p className="mt-3 text-xs text-muted-foreground">Added {added}</p>}
    </button>
  );
}

interface PipelineCardProps {
  lead: Lead;
  previousStage: LeadStage | undefined;
  nextStage: LeadStage | undefined;
  isMutating: boolean;
  onOpenLead: (leadId: string) => void;
  onSelectLeadForOutreach: (lead: Lead) => void;
  onMove: (leadId: string, stage: LeadStage) => void;
}

const PipelineCard = memo(function PipelineCard({
  lead,
  previousStage,
  nextStage,
  isMutating,
  onOpenLead,
  onSelectLeadForOutreach,
  onMove,
}: PipelineCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
    data: { stage: lead.stage },
    disabled: isMutating,
  });

  return (
    <article ref={setNodeRef} className={isDragging ? 'opacity-40' : undefined}>
      <Card className="group relative overflow-hidden shadow-sm transition-colors hover:border-primary/40 motion-reduce:transition-none">
        <button
          type="button"
          {...attributes}
          {...listeners}
          disabled={isMutating}
          aria-label={`Drag ${lead.profile.fullName} to another stage`}
          title="Drag to another stage. With the keyboard, press Space, then the left or right arrow."
          className="absolute right-1.5 top-1.5 z-10 hidden cursor-grab rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 active:cursor-grabbing md:block"
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
        <LeadCardBody
          lead={lead}
          onOpen={() => onOpenLead(lead.id)}
          openProps={listeners ? { onPointerDown: listeners.onPointerDown } : undefined}
        />
        <div className="mx-4 flex items-center justify-between border-t pb-4 pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSelectLeadForOutreach(lead)}
            className="h-7 px-2 text-xs"
            aria-label={`Create pitch for ${lead.profile.fullName}`}
          >
            Create pitch
            <ChevronRight aria-hidden="true" className="ml-1 h-3 w-3" />
          </Button>
          <div className="flex items-center gap-1" role="group" aria-label="Move lead between stages">
            {previousStage && (
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => onMove(lead.id, previousStage)}
                disabled={isMutating}
                title="Move to previous stage"
                aria-label={`Move ${lead.profile.fullName} to the previous stage`}
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
              </Button>
            )}
            {nextStage && (
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => onMove(lead.id, nextStage)}
                disabled={isMutating}
                title="Advance stage"
                aria-label={`Advance ${lead.profile.fullName} to the next stage`}
              >
                <ChevronRight aria-hidden="true" className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </Card>
    </article>
  );
});

interface StageColumnProps {
  stageId: LeadStage;
  isMobileActive: boolean;
  totalLeads: number;
  stageLeads: Lead[];
  visibleLeads: Lead[];
  stageMutationIds: Set<string>;
  onShowMore: () => void;
  onShowAll: () => void;
  onOpenLead: (leadId: string) => void;
  onSelectLeadForOutreach: (lead: Lead) => void;
  onMove: (leadId: string, stage: LeadStage) => void;
}

function StageColumn({
  stageId,
  isMobileActive,
  totalLeads,
  stageLeads,
  visibleLeads,
  stageMutationIds,
  onShowMore,
  onShowAll,
  onOpenLead,
  onSelectLeadForOutreach,
  onMove,
}: StageColumnProps) {
  const stage = PIPELINE_STAGES.find((candidate) => candidate.id === stageId)!;
  const { setNodeRef, isOver } = useDroppable({ id: stageId });
  const previousStage = PREVIOUS_PIPELINE_STAGE[stageId];
  const nextStage = NEXT_PIPELINE_STAGE[stageId];
  const stageHeadingId = getPipelineStageDomId(stageId);
  const remainingCount = stageLeads.length - visibleLeads.length;

  const scored = stageLeads.map(getMatchScore).filter((score): score is number => score !== null);
  const averageScore = scored.length > 0 ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null;
  const share = totalLeads > 0 ? (stageLeads.length / totalLeads) * 100 : 0;

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={stageHeadingId}
      className={`${isMobileActive ? 'flex' : 'hidden md:flex'} h-full w-full min-w-0 shrink-0 snap-start flex-col rounded-2xl border bg-card/40 p-3 transition-colors motion-reduce:transition-none md:w-80 md:min-w-[280px] ${
        isOver ? 'border-primary bg-primary/5 ring-2 ring-primary/40' : 'border-border/70'
      }`}
    >
      <div className="mb-3 border-b border-border/60 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${stage.dotClassName}`} />
            <h2 id={stageHeadingId} className="whitespace-nowrap text-sm font-extrabold text-foreground">
              {stage.label}
            </h2>
          </div>
          <span
            className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-bold text-muted-foreground"
            aria-label={`${stageLeads.length} leads`}
          >
            {stageLeads.length}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${Math.round(share)} percent of visible prospects`}
          >
            <div className={`h-full rounded-full ${stage.dotClassName}`} style={{ width: `${Math.max(share, stageLeads.length > 0 ? 2 : 0)}%` }} />
          </div>
          <span className="shrink-0">{averageScore !== null ? `Avg ${averageScore}` : 'No scores'}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {visibleLeads.length === 0 ? (
          <p className="my-4 rounded-xl border border-dashed border-border/80 p-6 text-center text-xs font-medium text-muted-foreground">
            {isOver ? 'Drop to move here' : 'No leads in this stage'}
          </p>
        ) : (
          visibleLeads.map((lead) => (
            <PipelineCard
              key={lead.id}
              lead={lead}
              previousStage={previousStage}
              nextStage={nextStage}
              isMutating={stageMutationIds.has(lead.id)}
              onOpenLead={onOpenLead}
              onSelectLeadForOutreach={onSelectLeadForOutreach}
              onMove={onMove}
            />
          ))
        )}
        {remainingCount > 0 && (
          <div className="flex flex-col gap-1.5 pb-1 pt-2">
            <Button variant="outline" size="sm" className="w-full text-xs font-semibold" onClick={onShowMore}>
              Show more (+{remainingCount} remaining)
            </Button>
            {remainingCount > COLUMN_PAGE_SIZE && (
              <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground hover:text-foreground" onClick={onShowAll}>
                Show all
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default function CrmPipeline({
  leads,
  onUpdateLeadStage,
  onOpenLead,
  onSelectLeadForOutreach,
}: CrmPipelineProps) {
  const { triggerToast } = useToast();
  const { rehydrateLeads } = useLeads();

  useEffect(() => {
    void rehydrateLeads(true);
  }, [rehydrateLeads]);

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedIndustry, setSelectedIndustry] = useState('All');
  const [mobileStage, setMobileStage] = useState<LeadStage>('SCRAPED');
  const [columnLimits, setColumnLimits] = useState<Record<string, number>>({});
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [stageMutationIds, setStageMutationIds] = useState<Set<string>>(() => new Set());
  const stageMutationIdsRef = useRef<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates }),
  );

  const industries = useMemo(() => {
    const values = new Set<string>();
    for (const lead of leads) values.add(getIndustry(lead));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [leads]);

  const leadsByStage = useMemo(() => {
    const grouped = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage.id, [] as Lead[]]),
    ) as Record<Lead['stage'], Lead[]>;
    const query = deferredSearchQuery.trim().toLocaleLowerCase();

    for (const lead of leads) {
      const profile = lead.profile;
      const matchesIndustry =
        selectedIndustry === 'All' || getIndustry(lead) === selectedIndustry;
      const matchesSearch =
        query.length === 0 ||
        [profile?.fullName, profile?.currentTitle, profile?.currentCompany]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase().includes(query));
      if (matchesIndustry && matchesSearch) {
        const stageGroup = grouped[lead.stage] ?? grouped['SCRAPED'];
        stageGroup?.push(lead);
      }
    }

    return grouped;
  }, [deferredSearchQuery, leads, selectedIndustry]);

  const totalVisible = useMemo(
    () => PIPELINE_STAGES.reduce((sum, stage) => sum + leadsByStage[stage.id].length, 0),
    [leadsByStage],
  );

  const leadsRef = useRef(leads);
  useEffect(() => {
    leadsRef.current = leads;
  }, [leads]);

  const handleStageChange = useCallback(async (leadId: string, stage: Lead['stage']) => {
    const lead = leadsRef.current.find((candidate) => candidate.id === leadId);
    if (!lead || stageMutationIdsRef.current.has(leadId) || lead.stage === stage) return;
    const previousStage = lead.stage;
    const pendingIds = new Set(stageMutationIdsRef.current);
    pendingIds.add(leadId);
    stageMutationIdsRef.current = pendingIds;
    setStageMutationIds(pendingIds);
    try {
      await onUpdateLeadStage(leadId, stage);
      triggerToast(`Moved ${lead.profile.fullName} to ${getStageLabel(stage)}.`, 'success', {
        action: {
          label: 'Undo',
          onClick: () => {
            void Promise.resolve(onUpdateLeadStage(leadId, previousStage)).catch(() => {
              triggerToast('Could not undo the stage change.', 'error');
            });
          },
        },
      });
    } catch (error) {
      triggerToast(
        error instanceof Error ? error.message : 'The pipeline stage could not be saved.',
        'error',
      );
    } finally {
      const nextIds = new Set(stageMutationIdsRef.current);
      nextIds.delete(leadId);
      stageMutationIdsRef.current = nextIds;
      setStageMutationIds(nextIds);
    }
  }, [onUpdateLeadStage, triggerToast]);

  const activeLead = useMemo(
    () => (activeLeadId ? leads.find((lead) => lead.id === activeLeadId) ?? null : null),
    [activeLeadId, leads],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveLeadId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveLeadId(null);
    const targetStage = event.over?.id;
    if (!targetStage) return;
    const stage = PIPELINE_STAGES.find((candidate) => candidate.id === targetStage)?.id;
    if (!stage) return;
    void handleStageChange(String(event.active.id), stage);
  };

  const nameOf = (id: string | number) =>
    leadsRef.current.find((lead) => lead.id === String(id))?.profile.fullName ?? 'Prospect';
  const stageNameOf = (id: string | number | undefined) =>
    id === undefined ? 'no stage' : getStageLabel(String(id) as LeadStage);

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}. Use the left and right arrow keys to choose a stage, then press Space to drop.`,
    onDragOver: ({ active, over }) => `${nameOf(active.id)} is over the ${stageNameOf(over?.id)} stage.`,
    onDragEnd: ({ active, over }) => over
      ? `${nameOf(active.id)} was dropped in the ${stageNameOf(over.id)} stage.`
      : `${nameOf(active.id)} was dropped outside any stage and did not move.`,
    onDragCancel: ({ active }) => `Move cancelled. ${nameOf(active.id)} stays in the same stage.`,
  };

  return (
    <div className="space-y-4">
      <Card className="shadow-sm">
        <CardContent className="flex flex-col items-stretch justify-between gap-3 p-4 md:flex-row md:items-center">
          <div className="relative w-full md:w-96">
            <label htmlFor="pipeline-search" className="sr-only">
              Search pipeline leads
            </label>
            <Search
              aria-hidden="true"
              className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground"
            />
            <Input
              id="pipeline-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by name, title, or employer"
              className="pl-10"
              aria-busy={searchQuery !== deferredSearchQuery}
            />
          </div>

          <div className="flex w-full flex-col gap-3 sm:flex-row md:w-auto">
            <div className="md:hidden">
              <label htmlFor="pipeline-stage-switcher" className="sr-only">Show stage</label>
              <Select value={mobileStage} onValueChange={(value) => setMobileStage(value as LeadStage)}>
                <SelectTrigger id="pipeline-stage-switcher" className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PIPELINE_STAGES.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.label} ({leadsByStage[stage.id].length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="pipeline-industry" className="sr-only">Filter pipeline by industry</label>
              <Select value={selectedIndustry} onValueChange={setSelectedIndustry}>
                <SelectTrigger id="pipeline-industry" className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All industries</SelectItem>
                  {industries.map((industry) => (
                    <SelectItem key={industry} value={industry}>{industry}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveLeadId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: 'To move a prospect to another stage, focus its drag handle and press Space. Use the left and right arrow keys to choose a stage, then press Space to drop or Escape to cancel.',
          },
        }}
      >
        <div
          className="flex h-[calc(100dvh-19rem)] min-h-[30rem] w-full snap-x gap-4 overflow-x-auto pb-2"
          role="group"
          aria-label="Sales pipeline board"
          aria-busy={searchQuery !== deferredSearchQuery}
        >
          {PIPELINE_STAGES.map((stage) => {
            const stageLeads = leadsByStage[stage.id];
            const limit = columnLimits[stage.id] ?? COLUMN_PAGE_SIZE;
            return (
              <StageColumn
                key={stage.id}
                stageId={stage.id}
                isMobileActive={mobileStage === stage.id}
                totalLeads={totalVisible}
                stageLeads={stageLeads}
                visibleLeads={stageLeads.slice(0, limit)}
                stageMutationIds={stageMutationIds}
                onShowMore={() =>
                  setColumnLimits((previous) => ({
                    ...previous,
                    [stage.id]: (previous[stage.id] ?? COLUMN_PAGE_SIZE) + COLUMN_PAGE_SIZE,
                  }))
                }
                onShowAll={() =>
                  setColumnLimits((previous) => ({ ...previous, [stage.id]: stageLeads.length }))
                }
                onOpenLead={onOpenLead}
                onSelectLeadForOutreach={onSelectLeadForOutreach}
                onMove={handleStageChange}
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeLead && (
            <Card className="w-72 rotate-1 cursor-grabbing border-primary/50 shadow-2xl">
              <LeadCardBody lead={activeLead} />
            </Card>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// @license Apache-2.0

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Briefcase,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  ExternalLink,
  FileText,
  Filter,
  GraduationCap,
  Link2,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import type { Lead, LinkedInProfile, NextAction, ReviewStatus } from '../types';
import {
  getPipelineStageDomId,
  NEXT_PIPELINE_STAGE,
  PIPELINE_STAGES,
  PREVIOUS_PIPELINE_STAGE,
} from '@/lib/pipeline';
import { useToast } from '@/context/ToastContext';
import { useLeads } from '@/context/LeadContext';
import {
  getLeadProvenance,
  getNextAction,
  getReviewStatus,
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '@/lib/prospectWorkflow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface CrmPipelineProps {
  leads: Lead[];
  onUpdateLeadStage: (leadId: string, stage: Lead['stage']) => void | Promise<void>;
  onUpdateLeadNotes: (leadId: string, notes: string) => void | Promise<void>;
  onUpdateLeadTags: (leadId: string, tags: string[]) => void | Promise<void>;
  onDeleteLead: (leadId: string) => void | Promise<void>;
  onSelectLeadForOutreach: (lead: Lead) => void;
}

type NotesSaveState = 'saved' | 'dirty' | 'saving' | 'error';

const NOTES_SAVE_LABELS: Record<NotesSaveState, string> = {
  saved: 'Saved',
  dirty: 'Waiting to save...',
  saving: 'Saving...',
  error: 'Could not save. Keep typing to retry.',
};

const PIPELINE_NOTE_DRAFT_PREFIX = 'apex_crm_pipeline_note_draft:';

function readRecoveredNote(leadId: string): string | null {
  try {
    return sessionStorage.getItem(`${PIPELINE_NOTE_DRAFT_PREFIX}${leadId}`);
  } catch {
    return null;
  }
}

function cacheRecoveredNote(leadId: string, notes: string) {
  try {
    sessionStorage.setItem(`${PIPELINE_NOTE_DRAFT_PREFIX}${leadId}`, notes);
  } catch {
    // The in-memory draft remains available while this workspace is open.
  }
}

function clearRecoveredNote(leadId: string) {
  try {
    sessionStorage.removeItem(`${PIPELINE_NOTE_DRAFT_PREFIX}${leadId}`);
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

function getIndustry(lead: Lead): string {
  return lead.profile?.industry?.trim() || 'Tech';
}

export default function CrmPipeline({
  leads,
  onUpdateLeadStage,
  onUpdateLeadNotes,
  onUpdateLeadTags,
  onDeleteLead,
  onSelectLeadForOutreach,
}: CrmPipelineProps) {
  const { triggerToast } = useToast();
  const { handleUpdateLeadFields } = useLeads();
  const reduceMotion = useReducedMotion() ?? false;
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedIndustry, setSelectedIndustry] = useState('All');
  const [icebreaker, setIcebreaker] = useState('');
  const [loadingIcebreaker, setLoadingIcebreaker] = useState(false);
  const [icebreakerError, setIcebreakerError] = useState('');
  const [copiedIcebreaker, setCopiedIcebreaker] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaveState, setNotesSaveState] =
    useState<NotesSaveState>('saved');
  const [deletingLeadId, setDeletingLeadId] = useState<string | null>(null);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [stageMutationIds, setStageMutationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [tagMutationPending, setTagMutationPending] = useState(false);
  const [tagMutationError, setTagMutationError] = useState('');
  const [workflowMutationPending, setWorkflowMutationPending] = useState(false);

  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesLeadIdRef = useRef<string | null>(null);
  const notesDraftRef = useRef('');
  const notesSavedValueRef = useRef('');
  const notesSaveInFlightRef = useRef<Promise<boolean> | null>(null);
  const notesPendingKeyRef = useRef('');
  const notesTransitionPendingRef = useRef(false);
  const lastOpenedLeadIdRef = useRef<string | null>(null);
  const updateNotesRef = useRef(onUpdateLeadNotes);
  const icebreakerRequestRef = useRef<AbortController | null>(null);
  const stageMutationIdsRef = useRef<Set<string>>(new Set());
  const tagMutationInFlightRef = useRef(false);
  const tagMutationRequestIdRef = useRef(0);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId),
    [leads, selectedLeadId],
  );
  const selectedLeadProvenance = useMemo(
    () => selectedLead ? getLeadProvenance(selectedLead) : null,
    [selectedLead],
  );

  const handleWorkflowChange = useCallback(async (
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    if (!selectedLead || workflowMutationPending) return;
    setWorkflowMutationPending(true);
    try {
      await handleUpdateLeadFields(selectedLead.id, updates);
      triggerToast('Prospect workflow saved.', 'success');
    } catch (error) {
      triggerToast(error instanceof Error ? error.message : 'Could not save prospect workflow.', 'error');
    } finally {
      setWorkflowMutationPending(false);
    }
  }, [handleUpdateLeadFields, selectedLead, triggerToast, workflowMutationPending]);

  const industries = useMemo(() => {
    const values = new Set<string>();
    for (const lead of leads) values.add(getIndustry(lead));
    return ['All', ...Array.from(values).sort((a, b) => a.localeCompare(b))];
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
      if (matchesIndustry && matchesSearch) grouped[lead.stage].push(lead);
    }

    return grouped;
  }, [deferredSearchQuery, leads, selectedIndustry]);

  const clearNotesTimer = useCallback(() => {
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
  }, []);

  const persistNotes = useCallback(
    (leadId: string, value: string): Promise<boolean> => {
      clearNotesTimer();
      const pendingKey = `${leadId}\u0000${value}`;
      if (
        notesSaveInFlightRef.current &&
        notesPendingKeyRef.current === pendingKey
      ) {
        return notesSaveInFlightRef.current;
      }
      if (
        leadId === notesLeadIdRef.current &&
        value === notesSavedValueRef.current
      ) {
        setNotesSaveState('saved');
        return Promise.resolve(true);
      }
      if (leadId === notesLeadIdRef.current) setNotesSaveState('saving');

      // Mark this exact value as pending before awaiting so drawer teardown does
      // not submit the same note a second time while the first PATCH is in flight.
      const previousSavedValue = notesSavedValueRef.current;
      if (leadId === notesLeadIdRef.current) notesSavedValueRef.current = value;

      let operation!: Promise<boolean>;
      operation = (async () => {
        try {
          await onUpdateLeadNotes(leadId, value);
          if (leadId === notesLeadIdRef.current) {
            notesSavedValueRef.current = value;
            if (notesDraftRef.current === value) clearRecoveredNote(leadId);
            setNotesSaveState(
              notesDraftRef.current === value ? 'saved' : 'dirty',
            );
          }
          return true;
        } catch {
          if (leadId === notesLeadIdRef.current) {
            cacheRecoveredNote(leadId, notesDraftRef.current);
          }
          if (
            leadId === notesLeadIdRef.current &&
            notesSavedValueRef.current === value
          ) {
            notesSavedValueRef.current = previousSavedValue;
            setNotesSaveState('error');
          }
          return false;
        } finally {
          if (notesSaveInFlightRef.current === operation) {
            notesSaveInFlightRef.current = null;
            notesPendingKeyRef.current = '';
          }
        }
      })();
      notesPendingKeyRef.current = pendingKey;
      notesSaveInFlightRef.current = operation;
      return operation;
    },
    [clearNotesTimer, onUpdateLeadNotes],
  );

  const flushNotes = useCallback((): Promise<boolean> => {
    clearNotesTimer();
    const leadId = notesLeadIdRef.current;
    if (!leadId) return Promise.resolve(true);
    const pendingKey = `${leadId}\u0000${notesDraftRef.current}`;
    if (
      notesSaveInFlightRef.current &&
      notesPendingKeyRef.current === pendingKey
    ) return notesSaveInFlightRef.current;
    if (notesDraftRef.current === notesSavedValueRef.current) {
      return Promise.resolve(true);
    }
    return persistNotes(leadId, notesDraftRef.current);
  }, [clearNotesTimer, persistNotes]);

  const closeLeadDetails = useCallback(async () => {
    if (notesTransitionPendingRef.current) return;
    notesTransitionPendingRef.current = true;
    const didSave = await flushNotes();
    if (didSave) {
      setSelectedLeadId(null);
    } else {
      triggerToast('Notes were not saved. Your draft is preserved and the details panel remains open.', 'error');
    }
    notesTransitionPendingRef.current = false;
  }, [flushNotes, triggerToast]);

  useEffect(() => {
    updateNotesRef.current = onUpdateLeadNotes;
  }, [onUpdateLeadNotes]);

  useEffect(() => {
    if (!selectedLeadId || !selectedLead) {
      lastOpenedLeadIdRef.current = null;
      return;
    }
    if (lastOpenedLeadIdRef.current === selectedLeadId) return;

    clearNotesTimer();
    const savedNotes = selectedLead.notes || '';
    const recoveredNotes = readRecoveredNote(selectedLeadId);
    const initialNotes = recoveredNotes ?? savedNotes;
    lastOpenedLeadIdRef.current = selectedLeadId;
    notesLeadIdRef.current = selectedLeadId;
    notesDraftRef.current = initialNotes;
    notesSavedValueRef.current = savedNotes;
    setNotesDraft(initialNotes);
    setNotesSaveState(initialNotes === savedNotes ? 'saved' : 'dirty');
    setTagInput('');
    tagMutationRequestIdRef.current += 1;
    tagMutationInFlightRef.current = false;
    setTagMutationPending(false);
    setTagMutationError('');
    icebreakerRequestRef.current?.abort();
    icebreakerRequestRef.current = null;
    setIcebreaker('');
    setIcebreakerError('');
    setLoadingIcebreaker(false);
    setCopiedIcebreaker(false);
  }, [clearNotesTimer, selectedLead, selectedLeadId]);

  useEffect(
    () => () => {
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      icebreakerRequestRef.current?.abort();
      const leadId = notesLeadIdRef.current;
      const notes = notesDraftRef.current;
      if (leadId && notes !== notesSavedValueRef.current) {
        cacheRecoveredNote(leadId, notes);
        void Promise.resolve(updateNotesRef.current(leadId, notes))
          .then(() => clearRecoveredNote(leadId))
          .catch(() => {
            triggerToast('An unsaved note draft was preserved in this browser session.', 'error');
          });
      }
    },
    [triggerToast],
  );

  const handleGenerateIcebreaker = async (profile: LinkedInProfile) => {
    const leadId = selectedLeadId;
    if (!leadId) return;
    icebreakerRequestRef.current?.abort();
    const controller = new AbortController();
    icebreakerRequestRef.current = controller;
    setLoadingIcebreaker(true);
    setIcebreakerError('');
    setIcebreaker('');
    try {
      const response = await fetch('/api/generate-outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          profile,
          tone: 'High-Value',
          pitchType: 'Short 1-Sentence Intro Hook Icebreaker',
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Personalization service returned status ${response.status}`,
        );
      }
      const data = (await response.json()) as { text?: string };
      if (
        icebreakerRequestRef.current !== controller ||
        lastOpenedLeadIdRef.current !== leadId
      ) return;
      setIcebreaker(data.text || '');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (
        icebreakerRequestRef.current !== controller ||
        lastOpenedLeadIdRef.current !== leadId
      ) return;
      setIcebreakerError(
        error instanceof Error
          ? error.message
          : 'Personalized icebreaker failed.',
      );
    } finally {
      if (icebreakerRequestRef.current === controller) {
        icebreakerRequestRef.current = null;
        setLoadingIcebreaker(false);
      }
    }
  };

  const handleCopy = async (text?: string, onCopied?: () => void) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.();
    } catch {
      setIcebreakerError('Copy failed. Select the text and copy it manually.');
    }
  };

  const handleCopyIcebreaker = () => {
    void handleCopy(icebreaker, () => {
      setCopiedIcebreaker(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(
        () => setCopiedIcebreaker(false),
        2000,
      );
    });
  };

  const handleAddTag = async (leadId: string) => {
    if (!tagInput.trim() || !selectedLead || tagMutationInFlightRef.current) return;
    const tag = tagInput.trim();
    const currentTags = selectedLead.tags || [];
    if (currentTags.includes(tag)) {
      setTagInput('');
      return;
    }
    tagMutationInFlightRef.current = true;
    const requestId = ++tagMutationRequestIdRef.current;
    setTagMutationPending(true);
    setTagMutationError('');
    try {
      await onUpdateLeadTags(leadId, [...currentTags, tag]);
      if (
        tagMutationRequestIdRef.current === requestId &&
        notesLeadIdRef.current === leadId
      ) setTagInput('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The lead tag could not be saved.';
      if (tagMutationRequestIdRef.current === requestId) setTagMutationError(message);
      triggerToast(message, 'error');
    } finally {
      if (tagMutationRequestIdRef.current === requestId) {
        tagMutationInFlightRef.current = false;
        setTagMutationPending(false);
      }
    }
  };

  const handleRemoveTag = async (leadId: string, tagToRemove: string) => {
    if (!selectedLead || tagMutationInFlightRef.current) return;
    tagMutationInFlightRef.current = true;
    const requestId = ++tagMutationRequestIdRef.current;
    setTagMutationPending(true);
    setTagMutationError('');
    try {
      await onUpdateLeadTags(
        leadId,
        (selectedLead.tags || []).filter((tag) => tag !== tagToRemove),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The lead tag could not be removed.';
      if (tagMutationRequestIdRef.current === requestId) setTagMutationError(message);
      triggerToast(message, 'error');
    } finally {
      if (tagMutationRequestIdRef.current === requestId) {
        tagMutationInFlightRef.current = false;
        setTagMutationPending(false);
      }
    }
  };

  const handleNotesChange = (value: string) => {
    const leadId = notesLeadIdRef.current;
    setNotesDraft(value);
    notesDraftRef.current = value;
    setNotesSaveState(
      value === notesSavedValueRef.current ? 'saved' : 'dirty',
    );
    if (leadId) {
      if (value === notesSavedValueRef.current) clearRecoveredNote(leadId);
      else cacheRecoveredNote(leadId, value);
    }
    clearNotesTimer();
    if (!leadId || value === notesSavedValueRef.current) return;
    notesTimerRef.current = setTimeout(() => {
      void persistNotes(leadId, value);
    }, 650);
  };

  const handleOpenOutreach = async () => {
    if (!selectedLead || notesTransitionPendingRef.current) return;
    notesTransitionPendingRef.current = true;
    const didSave = await flushNotes();
    if (didSave) {
      onSelectLeadForOutreach(selectedLead);
      setSelectedLeadId(null);
    } else {
      triggerToast('Notes were not saved. Your draft is preserved; try again before opening Outreach.', 'error');
    }
    notesTransitionPendingRef.current = false;
  };

  const handleDeleteSelectedLead = async () => {
    if (!selectedLead || deletingLeadId) return;
    clearNotesTimer();
    const previousSavedValue = notesSavedValueRef.current;
    notesSavedValueRef.current = notesDraftRef.current;
    setDeletingLeadId(selectedLead.id);
    try {
      await onDeleteLead(selectedLead.id);
      clearRecoveredNote(selectedLead.id);
      setDeleteConfirmationOpen(false);
      setSelectedLeadId(null);
      triggerToast(`${selectedLead.profile.fullName} was removed.`, 'success');
    } catch (error) {
      notesSavedValueRef.current = previousSavedValue;
      setNotesSaveState('dirty');
      void persistNotes(selectedLead.id, notesDraftRef.current);
      triggerToast(
        error instanceof Error ? error.message : 'Could not remove this prospect.',
        'error',
      );
    } finally {
      setDeletingLeadId(null);
    }
  };

  const handleStageChange = async (leadId: string, stage: Lead['stage']) => {
    if (
      stageMutationIdsRef.current.has(leadId) ||
      leads.find((lead) => lead.id === leadId)?.stage === stage
    ) return;
    const pendingIds = new Set(stageMutationIdsRef.current);
    pendingIds.add(leadId);
    stageMutationIdsRef.current = pendingIds;
    setStageMutationIds(pendingIds);
    try {
      await onUpdateLeadStage(leadId, stage);
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
  };

  return (
    <div className="space-y-6">
      <Card className="mb-6 shadow-lg">
        <CardContent className="flex flex-col items-center justify-between gap-4 p-4 md:flex-row">
          <div className="relative w-full md:w-96">
            <label htmlFor="pipeline-search" className="sr-only">
              Search pipeline leads
            </label>
            <Search
              aria-hidden="true"
              className="absolute left-3.5 top-2.5 h-4 w-4 text-muted-foreground"
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

          <div
            className="flex w-full items-center gap-2 overflow-x-auto pb-1 md:w-auto md:pb-0"
            role="group"
            aria-label="Filter pipeline by industry"
          >
            <span className="flex shrink-0 items-center gap-1.5 py-2 text-xs font-bold uppercase text-muted-foreground">
              <Filter aria-hidden="true" className="h-3.5 w-3.5" />
              Industry
            </span>
            {industries.map((industry) => (
              <Button
                key={industry}
                variant={selectedIndustry === industry ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedIndustry(industry)}
                className="h-8 shrink-0 motion-reduce:transition-none"
                aria-pressed={selectedIndustry === industry}
              >
                {industry}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div
        className="flex w-full snap-x gap-6 overflow-x-auto pb-6"
        aria-label="Sales pipeline board"
        aria-busy={searchQuery !== deferredSearchQuery}
      >
        {PIPELINE_STAGES.map((stage) => {
          const stageLeads = leadsByStage[stage.id];
          const previousStage = PREVIOUS_PIPELINE_STAGE[stage.id];
          const nextStage = NEXT_PIPELINE_STAGE[stage.id];
          const stageHeadingId = getPipelineStageDomId(stage.id);

          return (
            <section
              key={stage.id}
              aria-labelledby={stageHeadingId}
              className="flex min-h-[500px] w-80 min-w-[280px] shrink-0 snap-start flex-col rounded-2xl border border-slate-800/70 bg-slate-900/25 p-4"
            >
              <div className="mb-4 flex items-center justify-between border-b border-slate-800/50 pb-2">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${stage.dotClassName}`}
                  />
                  <h2
                    id={stageHeadingId}
                    className="whitespace-nowrap text-sm font-extrabold text-slate-200"
                  >
                    {stage.label}
                  </h2>
                </div>
                <span
                  className="rounded-full border border-slate-800 bg-slate-950 px-2.5 py-0.5 text-xs font-bold text-slate-400"
                  aria-label={`${stageLeads.length} leads`}
                >
                  {stageLeads.length}
                </span>
              </div>

              <div className="max-h-[600px] flex-1 space-y-4 overflow-y-auto pr-1">
                <AnimatePresence initial={!reduceMotion} mode="popLayout">
                  {stageLeads.length === 0 ? (
                    <p className="my-4 rounded-xl border border-dashed border-slate-800/80 p-6 text-center text-xs font-medium text-slate-500">
                      No leads in this stage
                    </p>
                  ) : (
                    stageLeads.map((lead) => (
                      <motion.article
                        key={lead.id}
                        layout={!reduceMotion}
                        initial={
                          reduceMotion ? false : { opacity: 0, scale: 0.98 }
                        }
                        animate={{ opacity: 1, scale: 1 }}
                        exit={
                          reduceMotion ? undefined : { opacity: 0, scale: 0.98 }
                        }
                        whileHover={reduceMotion ? undefined : { y: -2 }}
                      >
                        <Card className="relative overflow-hidden shadow-md transition-colors hover:border-primary/30 motion-reduce:transition-none">
                          <button
                            type="button"
                            onClick={() => setSelectedLeadId(lead.id)}
                            className="block w-full p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                            aria-label={`Open details for ${lead.profile.fullName}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="text-sm font-extrabold text-foreground">
                                {lead.profile.fullName}
                              </h3>
                              {Boolean(lead.compositeScore) && (
                                <div className="flex shrink-0 flex-col items-end gap-1">
                                  <Badge
                                    variant={
                                      lead.compositeScore! >= 80
                                        ? 'default'
                                        : lead.compositeScore! >= 60
                                          ? 'secondary'
                                          : 'outline'
                                    }
                                    className="px-1.5 py-0.5 text-xs"
                                  >
                                    ICP {lead.compositeScore}
                                  </Badge>
                                  {Boolean(
                                    lead.qualificationScore ??
                                      lead.predictiveScore,
                                  ) && (
                                    <Badge
                                      variant="outline"
                                      className="border-indigo-500/30 px-1.5 py-0.5 text-xs text-indigo-400"
                                    >
                                      {lead.qualificationScore ??
                                        lead.predictiveScore}
                                      % qualified
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-xs font-bold text-muted-foreground">
                              {lead.profile.currentTitle || 'Professional'}
                            </p>
                            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Briefcase aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
                              <span className="truncate">
                                {lead.profile.currentCompany || 'Independent'}
                              </span>
                            </div>
                            {lead.companyAccount && (
                              <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                                <Compass aria-hidden="true" className="h-3.5 w-3.5" />
                                <span>
                                  {lead.companyAccount.buyingSignals.length}{' '}
                                  company signals - pain{' '}
                                  {lead.companyAccount.operationalPainScore}
                                </span>
                              </div>
                            )}
                            {lead.profile.location && (
                              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
                                <span className="truncate">{lead.profile.location}</span>
                              </div>
                            )}
                            {Boolean(lead.tags?.length) && (
                              <div className="mt-3 flex flex-wrap gap-1">
                                {lead.tags?.slice(0, 2).map((tag) => (
                                  <Badge key={tag} variant="outline" className="px-1.5 py-0.5 text-xs font-bold">
                                    {tag}
                                  </Badge>
                                ))}
                                {(lead.tags?.length || 0) > 2 && (
                                  <span className="self-center text-xs font-bold text-muted-foreground">
                                    +{(lead.tags?.length || 0) - 2} more
                                  </span>
                                )}
                              </div>
                            )}
                          </button>

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
                            <div className="flex items-center gap-1" aria-label="Move lead between stages">
                              {previousStage && (
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => void handleStageChange(lead.id, previousStage)}
                                  disabled={stageMutationIds.has(lead.id)}
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
                                  onClick={() => void handleStageChange(lead.id, nextStage)}
                                  disabled={stageMutationIds.has(lead.id)}
                                  title="Advance stage"
                                  aria-label={`Advance ${lead.profile.fullName} to the next stage`}
                                >
                                  <ChevronRight aria-hidden="true" className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      </motion.article>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </section>
          );
        })}
      </div>

      <Dialog
        open={Boolean(selectedLead)}
        onOpenChange={(open) => {
          if (!open) void closeLeadDetails();
        }}
      >
        {selectedLead && (
          <DialogContent className="left-auto right-0 top-0 flex h-screen w-full max-w-2xl translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 border-l border-slate-800 bg-slate-950 p-0 shadow-2xl motion-reduce:animate-none sm:max-w-2xl sm:rounded-none">
            <DialogHeader className="border-b border-slate-800 p-6 pr-16 text-left">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <span className="inline-flex rounded border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-indigo-300">
                    {selectedLead.profile.industry || 'Tech sector'} lead
                  </span>
                  <DialogTitle className="mt-2 text-xl font-extrabold text-white">
                    {selectedLead.profile.fullName}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    Review contact intelligence, update pipeline status, and add private notes.
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    onClick={() => void handleOpenOutreach()}
                    disabled={notesSaveState === 'saving'}
                    size="sm"
                  >
                    Open outreach studio
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setDeleteConfirmationOpen(true)}
                    disabled={deletingLeadId === selectedLead.id}
                    title="Remove lead"
                    aria-label={`Remove ${selectedLead.profile.fullName}`}
                    className="text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                  >
                    {deletingLeadId === selectedLead.id
                      ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                      : <Trash2 aria-hidden="true" className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              <section aria-labelledby="pipeline-contact-heading">
                <h3 id="pipeline-contact-heading" className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-200">
                  <Compass aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                  Headline and contact details
                </h3>
                <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-sm font-bold leading-snug text-slate-200">
                    {selectedLead.profile.headline || 'No headline found.'}
                  </p>
                  <p className="text-xs leading-relaxed text-slate-400">
                    {selectedLead.profile.summary || 'Summary profile bio was not captured.'}
                  </p>
                  <div className="grid grid-cols-1 gap-3 border-t border-slate-800 pt-3 text-xs md:grid-cols-2">
                    {selectedLead.profile.contactDetails?.email && (
                      <div className="flex items-center gap-2 text-slate-300">
                        <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="truncate">{selectedLead.profile.contactDetails.email}</span>
                        <button
                          type="button"
                          onClick={() => void handleCopy(selectedLead.profile.contactDetails?.email)}
                          className="ml-auto rounded text-xs text-indigo-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label="Copy email address"
                        >
                          Copy
                        </button>
                      </div>
                    )}
                    {selectedLead.profile.contactDetails?.phone && (
                      <div className="flex items-center gap-2 text-slate-300">
                        <Phone aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="truncate">{selectedLead.profile.contactDetails.phone}</span>
                      </div>
                    )}
                    {selectedLead.profile.contactDetails?.linkedinUrl && (
                      <div className="col-span-1 flex items-center gap-2 text-slate-300 md:col-span-2">
                        <Link2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <a
                          href={selectedLead.profile.contactDetails.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 truncate text-indigo-400 hover:underline"
                          aria-label={`Open ${selectedLead.profile.fullName}'s LinkedIn profile in a new tab`}
                        >
                          {selectedLead.profile.contactDetails.linkedinUrl}
                          <ExternalLink aria-hidden="true" className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section aria-labelledby="pipeline-review-heading" className="space-y-3 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
                <div>
                  <h3 id="pipeline-review-heading" className="text-sm font-bold text-indigo-200">Review and provenance</h3>
                  <p className="mt-1 text-xs text-slate-400">Workflow labels are organizational only; they do not send outreach or change the pipeline stage.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs font-bold text-slate-300">
                    <span>Review status</span>
                    <select
                      value={getReviewStatus(selectedLead)}
                      disabled={workflowMutationPending}
                      onChange={(event) => void handleWorkflowChange({ reviewStatus: event.target.value as ReviewStatus })}
                      className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      {REVIEW_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-bold text-slate-300">
                    <span>Next action</span>
                    <select
                      value={getNextAction(selectedLead)}
                      disabled={workflowMutationPending}
                      onChange={(event) => void handleWorkflowChange({ nextAction: event.target.value as NextAction })}
                      className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      {NEXT_ACTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                </div>
                <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"><span className="text-slate-500">Location</span><p className="mt-1 font-semibold">{selectedLeadProvenance?.location || 'Not provided'}</p></div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"><span className="text-slate-500">Industry</span><p className="mt-1 font-semibold">{selectedLeadProvenance?.industry || 'Not provided'}</p></div>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-300">Discovery query</h4>
                  <p className="mt-1 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs leading-relaxed text-slate-400">{selectedLeadProvenance?.discoveryQuery || 'No discovery query recorded.'}</p>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-300">Matched criteria</h4>
                  {selectedLeadProvenance?.matchedCriteria.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">{selectedLeadProvenance.matchedCriteria.map(criterion => <Badge key={criterion} variant="outline">{criterion}</Badge>)}</div>
                  ) : <p className="mt-1 text-xs text-slate-500">No matched criteria recorded.</p>}
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-300">Uncertainties</h4>
                  {selectedLeadProvenance?.uncertainties.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-200">{selectedLeadProvenance.uncertainties.map(item => <li key={item}>{item}</li>)}</ul>
                  ) : <p className="mt-1 text-xs text-slate-500">No uncertainties recorded.</p>}
                </div>
              </section>

              {selectedLead.companyAccount && (
                <section
                  aria-labelledby="pipeline-company-heading"
                  className="space-y-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="pipeline-company-heading" className="flex items-center gap-2 text-sm font-bold text-emerald-200">
                        <Compass aria-hidden="true" className="h-4 w-4 text-emerald-400" />
                        Company pain qualification
                      </h3>
                      <p className="mt-1 text-xs text-slate-400">{selectedLead.companyAccount.painSummary}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 border-emerald-500/30 text-emerald-300">
                      Pain {selectedLead.companyAccount.operationalPainScore}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {selectedLead.companyAccount.buyingSignals.map((signal, index) => (
                      <div key={`${signal.label}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                        <h4 className="text-xs font-bold text-slate-200">{signal.label}</h4>
                        <p className="mt-1 text-xs leading-relaxed text-slate-400">{signal.evidence}</p>
                      </div>
                    ))}
                  </div>
                  {selectedLead.decisionMakerVerification && (
                    <p className="text-xs font-semibold text-emerald-300">
                      {selectedLead.decisionMakerVerification.reason}
                    </p>
                  )}
                </section>
              )}

              <section
                aria-labelledby="pipeline-personalization-heading"
                className="space-y-3 rounded-2xl border border-indigo-500/25 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 id="pipeline-personalization-heading" className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-widest text-indigo-300">
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-indigo-400 motion-safe:animate-pulse motion-reduce:animate-none" />
                    AI personalization
                  </h3>
                  {icebreaker && (
                    <button
                      type="button"
                      onClick={handleCopyIcebreaker}
                      className="flex items-center gap-1 rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-bold text-indigo-400 transition-colors hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                    >
                      {copiedIcebreaker ? (
                        <>
                          <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" />
                          Copied
                        </>
                      ) : 'Copy hook'}
                    </button>
                  )}
                </div>
                {icebreaker ? (
                  <p className="rounded-xl border border-slate-800/80 bg-slate-950/70 p-3 text-xs italic leading-relaxed text-slate-200">
                    &quot;{icebreaker.replace(/^"|"$/g, '')}&quot;
                  </p>
                ) : icebreakerError ? (
                  <p role="alert" className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-300">
                    {icebreakerError}
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-slate-400">
                    Create a concise opening line grounded in this lead&apos;s public profile.
                  </p>
                )}
                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    disabled={loadingIcebreaker}
                    onClick={() => void handleGenerateIcebreaker(selectedLead.profile)}
                    size="sm"
                    className="gap-1.5"
                  >
                    {loadingIcebreaker ? (
                      <>
                        <RefreshCw aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin motion-reduce:animate-none" />
                        Creating hook...
                      </>
                    ) : (
                      <>
                        <Wand2 aria-hidden="true" className="h-3 w-3" />
                        Create hook
                      </>
                    )}
                  </Button>
                </div>
              </section>

              <section aria-labelledby="pipeline-experience-heading">
                <h3 id="pipeline-experience-heading" className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                  <Briefcase aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                  Professional experience
                </h3>
                {selectedLead.profile.experiences?.length ? (
                  <div className="ml-2 space-y-4 border-l-2 border-slate-800 pl-4">
                    {selectedLead.profile.experiences.map((experience, index) => (
                      <article key={`${experience.company}-${experience.title}-${index}`} className="relative">
                        <span aria-hidden="true" className="absolute -left-[25px] top-1.5 h-3 w-3 rounded-full border-2 border-slate-950 bg-indigo-500" />
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          <h4 className="text-sm font-bold text-slate-200">{experience.title}</h4>
                          <span className="text-xs font-medium text-slate-500">at {experience.company}</span>
                        </div>
                        <span className="mt-1 block w-fit rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-indigo-300">
                          {experience.duration || 'Period undisclosed'}
                        </span>
                        {experience.description && (
                          <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-slate-400">
                            {experience.description}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-500">
                    No matching experience found on this profile.
                  </p>
                )}
              </section>

              <section aria-labelledby="pipeline-education-heading">
                <h3 id="pipeline-education-heading" className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                  <GraduationCap aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                  Education and credentials
                </h3>
                {selectedLead.profile.education?.length ? (
                  <div className="space-y-3">
                    {selectedLead.profile.education.map((education, index) => (
                      <article key={`${education.school}-${index}`} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                        <h4 className="text-xs font-extrabold text-slate-200">{education.school}</h4>
                        {(education.degree || education.fieldOfStudy) && (
                          <p className="mt-0.5 text-xs font-bold text-slate-400">
                            {education.degree}{' '}
                            {education.fieldOfStudy ? `in ${education.fieldOfStudy}` : ''}
                          </p>
                        )}
                        {education.duration && (
                          <span className="mt-1 block text-xs font-semibold text-slate-500">
                            {education.duration}
                          </span>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Academic background not loaded.</p>
                )}
              </section>

              {Boolean(selectedLead.profile.skills?.length) && (
                <section aria-labelledby="pipeline-skills-heading">
                  <h3 id="pipeline-skills-heading" className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-200">
                    <Tag aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                    Skills
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedLead.profile.skills?.map((skill) => (
                      <span key={skill} className="rounded border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-300">
                        {skill}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <section aria-labelledby="pipeline-tags-heading">
                <h3 id="pipeline-tags-heading" className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-200">
                  <Tag aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                  Lead tags
                </h3>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                  {selectedLead.tags?.map((tag) => (
                    <span key={tag} className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 py-1 pl-2.5 pr-1.5 text-xs font-semibold text-slate-300">
                      {tag}
                      <button
                        type="button"
                        onClick={() => void handleRemoveTag(selectedLead.id, tag)}
                        disabled={tagMutationPending}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={`Remove ${tag} tag`}
                      >
                        <X aria-hidden="true" className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <div className="flex items-center gap-1 rounded border bg-muted px-2 py-1">
                    <label htmlFor="pipeline-add-tag" className="sr-only">Add a lead tag</label>
                    <Input
                      id="pipeline-add-tag"
                      type="text"
                      placeholder="Add tag"
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      disabled={tagMutationPending}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleAddTag(selectedLead.id);
                        }
                      }}
                      className="h-6 w-24 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddTag(selectedLead.id)}
                      disabled={tagMutationPending || !tagInput.trim()}
                      className="rounded text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label="Add tag"
                    >
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p
                  role="status"
                  aria-live="polite"
                  className={`mt-2 text-xs ${tagMutationError ? 'text-rose-300' : 'text-slate-500'}`}
                >
                  {tagMutationPending ? 'Saving tags...' : tagMutationError}
                </p>
              </section>

              <section aria-labelledby="pipeline-notes-heading">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="pipeline-notes-heading" className="flex items-center gap-2 text-sm font-bold text-slate-200">
                    <FileText aria-hidden="true" className="h-4 w-4 text-indigo-400" />
                    Internal CRM notes
                  </h3>
                  <span
                    role="status"
                    aria-live="polite"
                    className={notesSaveState === 'error' ? 'text-xs text-rose-300' : 'text-xs text-slate-400'}
                  >
                    {NOTES_SAVE_LABELS[notesSaveState]}
                  </span>
                </div>
                <Textarea
                  value={notesDraft}
                  onChange={(event) => handleNotesChange(event.target.value)}
                  onBlur={flushNotes}
                  aria-label={`Internal notes for ${selectedLead.profile.fullName}`}
                  placeholder="Log interactions, pricing notes, or key takeaways"
                  rows={4}
                  className="mt-2 w-full resize-y"
                />
              </section>
            </div>

            <footer className="flex flex-col gap-3 border-t border-slate-800 bg-slate-950 p-4 text-xs">
              <span className="text-slate-500">
                Created: {new Date(selectedLead.createdAt).toLocaleDateString()}
              </span>
              <div className="flex items-center gap-1 overflow-x-auto pb-1" role="group" aria-label="Lead status">
                <span className="mr-2 shrink-0 font-bold text-slate-400">Status</span>
                {PIPELINE_STAGES.map((stage) => (
                  <button
                    key={stage.id}
                    type="button"
                    onClick={() => void handleStageChange(selectedLead.id, stage.id)}
                    disabled={
                      stageMutationIds.has(selectedLead.id) ||
                      selectedLead.stage === stage.id
                    }
                    className={`shrink-0 rounded border px-2 py-1.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none ${
                      selectedLead.stage === stage.id
                        ? 'border-indigo-500 bg-indigo-600 text-white shadow-sm'
                        : 'border-slate-800 bg-slate-900 text-slate-400 hover:bg-slate-800'
                    }`}
                    aria-pressed={selectedLead.stage === stage.id}
                  >
                    {stage.shortLabel}
                  </button>
                ))}
              </div>
            </footer>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!deletingLeadId) setDeleteConfirmationOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this prospect?</DialogTitle>
            <DialogDescription>
              {selectedLead
                ? `${selectedLead.profile.fullName} will be permanently removed from the CRM.`
                : 'This prospect is no longer available.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteConfirmationOpen(false)}
              disabled={Boolean(deletingLeadId)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteSelectedLead()}
              disabled={!selectedLead || Boolean(deletingLeadId)}
            >
              {deletingLeadId ? 'Removing...' : 'Remove prospect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

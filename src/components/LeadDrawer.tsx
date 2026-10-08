// @license Apache-2.0
//
// The one lead detail view. Opened from the Pipeline board, the Prospects table, the
// Overview and header search, and addressable by URL (#prospects/<leadId>).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Briefcase,
  Check,
  CircleHelp,
  Compass,
  Cpu,
  ExternalLink,
  FileText,
  Flame,
  GraduationCap,
  History,
  Link2,
  LoaderCircle,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Tag,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import type { Lead, LeadActivityRecord, LinkedInProfile, NextAction, ReviewStatus } from '@/types';
import { PIPELINE_STAGES } from '@/lib/pipeline';
import { useLeads } from '@/context/LeadContext';
import { useToast } from '@/context/ToastContext';
import {
  getLeadProvenance,
  getNextAction,
  getNextActionLabel,
  getReviewStatus,
  getReviewStatusLabel,
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '@/lib/prospectWorkflow';
import { describeMatchScore, explainMatchScore, getMatchScore } from '@/lib/matchScore';
import { useLockedLeadIds } from '@/lib/leadLocks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface LeadDrawerProps {
  leadId: string | null;
  onClose: () => void;
  onOpenOutreach: (lead: Lead) => void;
}

type NotesSaveState = 'saved' | 'dirty' | 'saving' | 'error';

const NOTES_SAVE_LABELS: Record<NotesSaveState, string> = {
  saved: 'Saved',
  dirty: 'Waiting to save...',
  saving: 'Saving...',
  error: 'Could not save. Keep typing to retry.',
};

const NOTE_DRAFT_PREFIX = 'apex_crm_pipeline_note_draft:';

function readRecoveredNote(leadId: string): string | null {
  try {
    return sessionStorage.getItem(`${NOTE_DRAFT_PREFIX}${leadId}`);
  } catch {
    return null;
  }
}

function cacheRecoveredNote(leadId: string, notes: string) {
  try {
    sessionStorage.setItem(`${NOTE_DRAFT_PREFIX}${leadId}`, notes);
  } catch {
    // The in-memory draft remains available while the drawer is open.
  }
}

function clearRecoveredNote(leadId: string) {
  try {
    sessionStorage.removeItem(`${NOTE_DRAFT_PREFIX}${leadId}`);
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

function SectionHeading({ icon: Glyph, children, tone = 'text-primary' }: {
  icon: typeof Compass;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
      <Glyph aria-hidden="true" className={`h-4 w-4 ${tone}`} />
      {children}
    </h3>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="mt-1 break-words text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

const SCORE_TONE_CLASS = {
  success: 'bg-success',
  brand: 'bg-primary',
  warning: 'bg-warning',
  neutral: 'bg-muted-foreground',
} as const;

export default function LeadDrawer({ leadId, onClose, onOpenOutreach }: LeadDrawerProps) {
  const { leads, isHydrated } = useLeads();
  const lead = useMemo(
    () => (leadId ? leads.find((candidate) => candidate.id === leadId) ?? null : null),
    [leadId, leads],
  );

  // Close the drawer when a deep link points at a lead that does not exist (anymore).
  useEffect(() => {
    if (leadId && isHydrated && !lead) onClose();
  }, [isHydrated, lead, leadId, onClose]);

  if (!lead) return null;
  return <LeadDrawerBody key={lead.id} lead={lead} onClose={onClose} onOpenOutreach={onOpenOutreach} />;
}

function LeadDrawerBody({
  lead,
  onClose,
  onOpenOutreach,
}: {
  lead: Lead;
  onClose: () => void;
  onOpenOutreach: (lead: Lead) => void;
}) {
  const { triggerToast } = useToast();
  const {
    handleUpdateLeadStage,
    handleUpdateLeadNotes,
    handleUpdateLeadTags,
    handleUpdateLeadFields,
    handleUpdateLeadProfile,
    handleDeleteLead,
  } = useLeads();
  const lockedLeadIds = useLockedLeadIds();
  const isLocked = lockedLeadIds.has(lead.id);

  const provenance = useMemo(() => getLeadProvenance(lead), [lead]);
  const matchScore = getMatchScore(lead);
  const matchSummary = describeMatchScore(matchScore);

  const [activeTab, setActiveTab] = useState('overview');
  const [tagInput, setTagInput] = useState('');
  const [tagPending, setTagPending] = useState(false);
  const [tagError, setTagError] = useState('');
  const [stagePending, setStagePending] = useState(false);
  const [workflowPending, setWorkflowPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [icebreaker, setIcebreaker] = useState('');
  const [icebreakerError, setIcebreakerError] = useState('');
  const [loadingIcebreaker, setLoadingIcebreaker] = useState(false);
  const [copied, setCopied] = useState<'email' | 'hook' | null>(null);

  // Contact profile editing states
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [contactDraft, setContactDraft] = useState({
    fullName: lead.profile.fullName || '',
    currentTitle: lead.profile.currentTitle || '',
    currentCompany: lead.profile.currentCompany || '',
    email: lead.profile.contactDetails?.email || '',
    phone: lead.profile.contactDetails?.phone || '',
    linkedinUrl: lead.profile.contactDetails?.linkedinUrl || '',
  });
  const [savingContact, setSavingContact] = useState(false);

  useEffect(() => {
    setContactDraft({
      fullName: lead.profile.fullName || '',
      currentTitle: lead.profile.currentTitle || '',
      currentCompany: lead.profile.currentCompany || '',
      email: lead.profile.contactDetails?.email || '',
      phone: lead.profile.contactDetails?.phone || '',
      linkedinUrl: lead.profile.contactDetails?.linkedinUrl || '',
    });
    setIsEditingContact(false);
  }, [lead.id, lead.profile]);

  // Lead activity history states
  const [activities, setActivities] = useState<LeadActivityRecord[]>([]);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);

  const fetchActivities = useCallback(async () => {
    setLoadingActivities(true);
    setActivitiesError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/activities?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActivities(Array.isArray(data.activities) ? data.activities : []);
    } catch (err: any) {
      setActivitiesError(err.message || 'Could not load activities.');
    } finally {
      setLoadingActivities(false);
    }
  }, [lead.id]);

  useEffect(() => {
    if (activeTab === 'activity') {
      void fetchActivities();
    }
  }, [activeTab, fetchActivities]);

  const handleSaveContactDetails = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isLocked || savingContact) return;
    const trimmedName = contactDraft.fullName.trim();
    if (!trimmedName) {
      triggerToast('Full name is required.', 'info');
      return;
    }
    setSavingContact(true);
    try {
      const success = await handleUpdateLeadProfile(lead.id, {
        fullName: trimmedName,
        currentTitle: contactDraft.currentTitle.trim(),
        currentCompany: contactDraft.currentCompany.trim(),
        contactDetails: {
          ...lead.profile.contactDetails,
          email: contactDraft.email.trim(),
          phone: contactDraft.phone.trim(),
          linkedinUrl: contactDraft.linkedinUrl.trim(),
        },
      });
      if (success) {
        triggerToast(`Updated contact details for ${trimmedName}.`, 'success');
        setIsEditingContact(false);
      } else {
        triggerToast('Could not save contact details.', 'error');
      }
    } catch (err: any) {
      triggerToast(err.message || 'Error saving contact details.', 'error');
    } finally {
      setSavingContact(false);
    }
  };

  // Only the first render of this lead decides the starting draft.
  const [initialNotes] = useState(() => readRecoveredNote(lead.id) ?? lead.notes ?? '');
  const [notesDraft, setNotesDraft] = useState(initialNotes);
  const [notesSaveState, setNotesSaveState] = useState<NotesSaveState>(
    initialNotes === (lead.notes ?? '') ? 'saved' : 'dirty',
  );

  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDraftRef = useRef(initialNotes);
  const notesSavedValueRef = useRef(lead.notes ?? '');
  const notesSaveInFlightRef = useRef<Promise<boolean> | null>(null);
  const notesPendingKeyRef = useRef('');
  const transitionPendingRef = useRef(false);
  const updateNotesRef = useRef(handleUpdateLeadNotes);
  const icebreakerRequestRef = useRef<AbortController | null>(null);
  const tagInFlightRef = useRef(false);
  const stageInFlightRef = useRef(false);

  const leadId = lead.id;

  useEffect(() => {
    updateNotesRef.current = handleUpdateLeadNotes;
  }, [handleUpdateLeadNotes]);

  const clearNotesTimer = useCallback(() => {
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
  }, []);

  const persistNotes = useCallback(
    (value: string): Promise<boolean> => {
      clearNotesTimer();
      const pendingKey = `${leadId}\u0000${value}`;
      if (notesSaveInFlightRef.current && notesPendingKeyRef.current === pendingKey) {
        return notesSaveInFlightRef.current;
      }
      if (value === notesSavedValueRef.current) {
        setNotesSaveState('saved');
        return Promise.resolve(true);
      }
      setNotesSaveState('saving');

      // Mark this exact value as pending before awaiting so teardown does not submit the
      // same note a second time while the first request is in flight.
      const previousSavedValue = notesSavedValueRef.current;
      notesSavedValueRef.current = value;

      let operation!: Promise<boolean>;
      operation = (async () => {
        try {
          await handleUpdateLeadNotes(leadId, value);
          notesSavedValueRef.current = value;
          if (notesDraftRef.current === value) clearRecoveredNote(leadId);
          setNotesSaveState(notesDraftRef.current === value ? 'saved' : 'dirty');
          return true;
        } catch {
          cacheRecoveredNote(leadId, notesDraftRef.current);
          if (notesSavedValueRef.current === value) {
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
    [clearNotesTimer, handleUpdateLeadNotes, leadId],
  );

  const flushNotes = useCallback((): Promise<boolean> => {
    clearNotesTimer();
    const pendingKey = `${leadId}\u0000${notesDraftRef.current}`;
    if (notesSaveInFlightRef.current && notesPendingKeyRef.current === pendingKey) {
      return notesSaveInFlightRef.current;
    }
    if (notesDraftRef.current === notesSavedValueRef.current) return Promise.resolve(true);
    return persistNotes(notesDraftRef.current);
  }, [clearNotesTimer, leadId, persistNotes]);

  // On teardown (drawer closed, lead switched) keep any unsaved draft rather than losing it.
  useEffect(
    () => () => {
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      icebreakerRequestRef.current?.abort();
      const notes = notesDraftRef.current;
      if (notes !== notesSavedValueRef.current) {
        cacheRecoveredNote(leadId, notes);
        void Promise.resolve(updateNotesRef.current(leadId, notes))
          .then(() => clearRecoveredNote(leadId))
          .catch(() => {
            triggerToast('An unsaved note draft was preserved in this browser session.', 'error');
          });
      }
    },
    [leadId, triggerToast],
  );

  const requestClose = useCallback(async () => {
    if (transitionPendingRef.current) return;
    transitionPendingRef.current = true;
    const didSave = await flushNotes();
    transitionPendingRef.current = false;
    if (didSave) onClose();
    else triggerToast('Notes were not saved. Your draft is preserved and the details panel remains open.', 'error');
  }, [flushNotes, onClose, triggerToast]);

  const handleOpenOutreach = async () => {
    if (transitionPendingRef.current) return;
    transitionPendingRef.current = true;
    const didSave = await flushNotes();
    transitionPendingRef.current = false;
    if (didSave) {
      onOpenOutreach(lead);
    } else {
      triggerToast('Notes were not saved. Your draft is preserved; try again before opening Outreach.', 'error');
    }
  };

  const handleNotesChange = (value: string) => {
    setNotesDraft(value);
    notesDraftRef.current = value;
    setNotesSaveState(value === notesSavedValueRef.current ? 'saved' : 'dirty');
    if (value === notesSavedValueRef.current) clearRecoveredNote(leadId);
    else cacheRecoveredNote(leadId, value);
    clearNotesTimer();
    if (value === notesSavedValueRef.current) return;
    notesTimerRef.current = setTimeout(() => {
      void persistNotes(value);
    }, 650);
  };

  const flashCopied = (kind: 'email' | 'hook') => {
    setCopied(kind);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(null), 2000);
  };

  const copyText = async (text: string | undefined, kind: 'email' | 'hook') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(kind);
    } catch {
      triggerToast('Copy failed. Select the text and copy it manually.', 'error');
    }
  };

  const handleStageChange = async (stage: Lead['stage']) => {
    if (stageInFlightRef.current || lead.stage === stage) return;
    const previousStage = lead.stage;
    stageInFlightRef.current = true;
    setStagePending(true);
    try {
      await handleUpdateLeadStage(leadId, stage);
      const label = PIPELINE_STAGES.find((candidate) => candidate.id === stage)?.shortLabel ?? stage;
      triggerToast(`Moved ${lead.profile.fullName} to ${label}.`, 'success', {
        action: {
          label: 'Undo',
          onClick: () => {
            void handleUpdateLeadStage(leadId, previousStage).catch(() => {
              triggerToast('Could not undo the stage change.', 'error');
            });
          },
        },
      });
    } catch (error) {
      triggerToast(error instanceof Error ? error.message : 'The pipeline stage could not be saved.', 'error');
    } finally {
      stageInFlightRef.current = false;
      setStagePending(false);
    }
  };

  const handleWorkflowChange = async (updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction }) => {
    if (workflowPending) return;
    const previous = {
      reviewStatus: getReviewStatus(lead),
      nextAction: getNextAction(lead),
    };
    setWorkflowPending(true);
    try {
      await handleUpdateLeadFields(leadId, updates);
      triggerToast('Prospect workflow saved.', 'success', {
        action: {
          label: 'Undo',
          onClick: () => {
            const revert: { reviewStatus?: ReviewStatus; nextAction?: NextAction } = {};
            if (updates.reviewStatus !== undefined) revert.reviewStatus = previous.reviewStatus;
            if (updates.nextAction !== undefined) revert.nextAction = previous.nextAction;
            void handleUpdateLeadFields(leadId, revert).catch(() => {
              triggerToast('Could not undo the workflow change.', 'error');
            });
          },
        },
      });
    } catch (error) {
      triggerToast(error instanceof Error ? error.message : 'Could not save prospect workflow.', 'error');
    } finally {
      setWorkflowPending(false);
    }
  };

  const handleAddTag = async () => {
    const tag = tagInput.trim();
    if (!tag || tagInFlightRef.current) return;
    const currentTags = lead.tags || [];
    if (currentTags.includes(tag)) {
      setTagInput('');
      return;
    }
    tagInFlightRef.current = true;
    setTagPending(true);
    setTagError('');
    try {
      await handleUpdateLeadTags(leadId, [...currentTags, tag]);
      setTagInput('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The lead tag could not be saved.';
      setTagError(message);
      triggerToast(message, 'error');
    } finally {
      tagInFlightRef.current = false;
      setTagPending(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (tagInFlightRef.current) return;
    tagInFlightRef.current = true;
    setTagPending(true);
    setTagError('');
    try {
      await handleUpdateLeadTags(leadId, (lead.tags || []).filter((tag) => tag !== tagToRemove));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The lead tag could not be removed.';
      setTagError(message);
      triggerToast(message, 'error');
    } finally {
      tagInFlightRef.current = false;
      setTagPending(false);
    }
  };

  const handleGenerateIcebreaker = async (profile: LinkedInProfile) => {
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
          leadId,
          profile,
          companyAccount: lead.companyAccount,
          buyingSignalsDetected: lead.buyingSignalsDetected,
          tone: 'High-Value',
          pitchType: 'Short 1-Sentence Intro Hook Icebreaker',
        }),
      });
      if (!response.ok) {
        throw new Error(`Personalization service returned status ${response.status}`);
      }
      const data = (await response.json()) as { text?: string };
      if (icebreakerRequestRef.current !== controller) return;
      setIcebreaker(data.text || '');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (icebreakerRequestRef.current !== controller) return;
      setIcebreakerError(error instanceof Error ? error.message : 'Personalized icebreaker failed.');
    } finally {
      if (icebreakerRequestRef.current === controller) {
        icebreakerRequestRef.current = null;
        setLoadingIcebreaker(false);
      }
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    clearNotesTimer();
    const previousSavedValue = notesSavedValueRef.current;
    notesSavedValueRef.current = notesDraftRef.current;
    setDeleting(true);
    try {
      await handleDeleteLead(leadId);
      clearRecoveredNote(leadId);
      setDeleteOpen(false);
      triggerToast(`${lead.profile.fullName} was removed.`, 'success');
      onClose();
    } catch (error) {
      notesSavedValueRef.current = previousSavedValue;
      setNotesSaveState('dirty');
      void persistNotes(notesDraftRef.current);
      triggerToast(error instanceof Error ? error.message : 'Could not remove this prospect.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const profile = lead.profile;
  const email = profile.contactDetails?.email;
  const linkedinUrl = profile.contactDetails?.linkedinUrl;
  const reasons = explainMatchScore(lead, provenance.matchedCriteria.length, provenance.uncertainties.length);
  const postIntent = provenance.postIntentEvidence && provenance.postIntentEvidence.quality !== 'none'
    ? provenance.postIntentEvidence
    : null;
  const workflowDisabled = workflowPending || isLocked;
  const stageLabel = PIPELINE_STAGES.find((candidate) => candidate.id === lead.stage)?.label ?? lead.stage;

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) void requestClose();
        }}
      >
        <SheetContent>
          <SheetHeader>
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="brand" className="uppercase tracking-wide">
                    {profile.industry || 'Tech sector'} lead
                  </Badge>
                  {profile.seniorityLevel && (
                    <Badge variant="outline" className="text-xs font-semibold">
                      {profile.seniorityLevel}
                    </Badge>
                  )}
                  {profile.companySizeEst && (
                    <Badge variant="secondary" className="text-xs font-semibold">
                      {profile.companySizeEst} staff
                    </Badge>
                  )}
                </div>
                <SheetTitle className="mt-2 truncate">{profile.fullName}</SheetTitle>
                <SheetDescription className="mt-1">
                  {[profile.currentTitle, profile.currentCompany].filter(Boolean).join(' at ') || 'Review contact intelligence, update status, and add private notes.'}
                </SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button onClick={() => void handleOpenOutreach()} disabled={notesSaveState === 'saving'} size="sm">
                  Open outreach studio
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setDeleteOpen(true)}
                  disabled={deleting || isLocked}
                  title="Remove lead"
                  aria-label={`Remove ${profile.fullName}`}
                  className="text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-danger"
                >
                  {deleting
                    ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    : <Trash2 aria-hidden="true" className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {isLocked && (
              <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
                <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Profile enrichment is running for this prospect. Editing is paused until it finishes.
              </p>
            )}
          </SheetHeader>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-6 py-3">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="notes">
                  Notes
                  {notesSaveState !== 'saved' && (
                    <span aria-hidden="true" className="ml-1.5 h-1.5 w-1.5 rounded-full bg-warning" />
                  )}
                </TabsTrigger>
                <TabsTrigger value="activity">Activities</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="mt-0 flex-1 space-y-6 overflow-y-auto p-6">
              <section aria-labelledby="drawer-score-heading" className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 id="drawer-score-heading" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Match score</h3>
                    <p className="mt-1 flex items-baseline gap-2">
                      <span className="text-3xl font-extrabold text-foreground">{matchScore ?? '--'}</span>
                      <span className="text-sm font-semibold text-muted-foreground">{matchSummary.label}</span>
                    </p>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                        <CircleHelp aria-hidden="true" className="h-4 w-4" />
                        Why?
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-80">
                      <p className="text-sm font-bold text-foreground">How this score is built</p>
                      <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs text-muted-foreground">
                        {reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    </PopoverContent>
                  </Popover>
                </div>
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Match score"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={matchScore ?? 0}
                >
                  <div
                    className={`h-full rounded-full ${SCORE_TONE_CLASS[matchSummary.tone]} transition-[width] motion-reduce:transition-none`}
                    style={{ width: `${matchScore ?? 0}%` }}
                  />
                </div>
              </section>

              <section aria-labelledby="drawer-workflow-heading" className="space-y-3">
                <h3 id="drawer-workflow-heading" className="text-sm font-bold text-foreground">Workflow</h3>
                <p className="text-xs text-muted-foreground">
                  Review status and next action are organizational labels; they do not send outreach.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-stage">Pipeline stage</Label>
                    <Select
                      value={lead.stage}
                      onValueChange={(value) => void handleStageChange(value as Lead['stage'])}
                      disabled={stagePending || isLocked}
                    >
                      <SelectTrigger id="drawer-stage"><SelectValue>{stageLabel}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {PIPELINE_STAGES.map((stage) => (
                          <SelectItem key={stage.id} value={stage.id}>{stage.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-review">Review status</Label>
                    <Select
                      value={getReviewStatus(lead)}
                      onValueChange={(value) => void handleWorkflowChange({ reviewStatus: value as ReviewStatus })}
                      disabled={workflowDisabled}
                    >
                      <SelectTrigger id="drawer-review"><SelectValue>{getReviewStatusLabel(getReviewStatus(lead))}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {REVIEW_STATUS_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-next-action">Next action</Label>
                    <Select
                      value={getNextAction(lead)}
                      onValueChange={(value) => void handleWorkflowChange({ nextAction: value as NextAction })}
                      disabled={workflowDisabled}
                    >
                      <SelectTrigger id="drawer-next-action"><SelectValue>{getNextActionLabel(getNextAction(lead))}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {NEXT_ACTION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              <section aria-labelledby="drawer-contact-heading">
                <div className="flex items-center justify-between mb-2">
                  <SectionHeading icon={Compass}>
                    <span id="drawer-contact-heading">Contact details</span>
                  </SectionHeading>
                  {!isEditingContact && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditingContact(true)}
                      disabled={isLocked}
                      className="h-7 text-xs text-primary hover:text-primary/80"
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit contact
                    </Button>
                  )}
                </div>

                {isEditingContact ? (
                  <form onSubmit={handleSaveContactDetails} className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-name" className="text-xs">Full Name</Label>
                        <Input
                          id="contact-edit-name"
                          value={contactDraft.fullName}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, fullName: e.target.value }))}
                          placeholder="Full Name"
                          className="h-8 text-xs bg-background"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-title" className="text-xs">Job Title</Label>
                        <Input
                          id="contact-edit-title"
                          value={contactDraft.currentTitle}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, currentTitle: e.target.value }))}
                          placeholder="Job Title"
                          className="h-8 text-xs bg-background"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-company" className="text-xs">Company</Label>
                        <Input
                          id="contact-edit-company"
                          value={contactDraft.currentCompany}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, currentCompany: e.target.value }))}
                          placeholder="Company"
                          className="h-8 text-xs bg-background"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-email" className="text-xs">Email</Label>
                        <Input
                          id="contact-edit-email"
                          type="email"
                          value={contactDraft.email}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, email: e.target.value }))}
                          placeholder="Email address"
                          className="h-8 text-xs bg-background"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-phone" className="text-xs">Phone</Label>
                        <Input
                          id="contact-edit-phone"
                          value={contactDraft.phone}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, phone: e.target.value }))}
                          placeholder="Phone number"
                          className="h-8 text-xs bg-background"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="contact-edit-linkedin" className="text-xs">LinkedIn URL</Label>
                        <Input
                          id="contact-edit-linkedin"
                          value={contactDraft.linkedinUrl}
                          onChange={(e) => setContactDraft(prev => ({ ...prev, linkedinUrl: e.target.value }))}
                          placeholder="https://linkedin.com/in/..."
                          className="h-8 text-xs bg-background"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setContactDraft({
                            fullName: profile.fullName || '',
                            currentTitle: profile.currentTitle || '',
                            currentCompany: profile.currentCompany || '',
                            email: email || '',
                            phone: profile.contactDetails?.phone || '',
                            linkedinUrl: linkedinUrl || '',
                          });
                          setIsEditingContact(false);
                        }}
                        disabled={savingContact}
                        className="h-7 text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={savingContact || isLocked}
                        className="h-7 gap-1 text-xs"
                      >
                        {savingContact ? (
                          <>
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <Save className="h-3 w-3" />
                            Save changes
                          </>
                        )}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="space-y-3 rounded-xl border border-border bg-card/60 p-4">
                    <p className="text-sm font-bold leading-snug text-foreground">{profile.headline || 'No headline found.'}</p>
                    <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 text-xs md:grid-cols-2">
                      {email ? (
                        <div className="flex items-center gap-2 text-foreground/80">
                          <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{email}</span>
                          <button
                            type="button"
                            onClick={() => void copyText(email, 'email')}
                            className="ml-auto rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Copy email address"
                          >
                            {copied === 'email' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          No email on file
                        </div>
                      )}
                      {profile.contactDetails?.phone ? (
                        <div className="flex items-center gap-2 text-foreground/80">
                          <Phone aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{profile.contactDetails.phone}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Phone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          No phone on file
                        </div>
                      )}
                      {linkedinUrl ? (
                        <div className="col-span-1 flex items-center gap-2 text-foreground/80 md:col-span-2">
                          <Link2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <a
                            href={linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 truncate text-primary hover:underline"
                            aria-label={`Open ${profile.fullName}'s LinkedIn profile in a new tab`}
                          >
                            {linkedinUrl}
                            <ExternalLink aria-hidden="true" className="h-3 w-3" />
                          </a>
                        </div>
                      ) : (
                        <div className="col-span-1 flex items-center gap-2 text-muted-foreground md:col-span-2">
                          <Link2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          No LinkedIn URL on file
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {profile.techStackHints && profile.techStackHints.length > 0 && (
                <section aria-labelledby="drawer-tech-heading">
                  <SectionHeading icon={Cpu}>
                    <span id="drawer-tech-heading">Detected tech stack</span>
                  </SectionHeading>
                  <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card/60 p-3">
                    {profile.techStackHints.map((tech) => (
                      <Badge key={tech} variant="secondary" className="text-xs font-semibold">
                        {tech}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}

              {profile.painIndicators && profile.painIndicators.length > 0 && (
                <section aria-labelledby="drawer-pain-heading" className="space-y-2">
                  <SectionHeading icon={Flame}>
                    <span id="drawer-pain-heading">Observed pain indicators</span>
                  </SectionHeading>
                  <div className="space-y-1.5 rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs text-foreground/90">
                    {profile.painIndicators.map((pain, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                        <span>{pain}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section aria-labelledby="drawer-tags-heading">
                <SectionHeading icon={Tag}>
                  <span id="drawer-tags-heading">Lead tags</span>
                </SectionHeading>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card/60 p-3">
                  {lead.tags?.map((tag) => (
                    <span key={tag} className="flex items-center gap-1 rounded-md border border-border bg-background py-1 pl-2.5 pr-1.5 text-xs font-semibold text-foreground/80">
                      {tag}
                      <button
                        type="button"
                        onClick={() => void handleRemoveTag(tag)}
                        disabled={tagPending}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Remove ${tag} tag`}
                      >
                        <X aria-hidden="true" className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <div className="flex items-center gap-1 rounded border bg-muted px-2 py-1">
                    <label htmlFor="drawer-add-tag" className="sr-only">Add a lead tag</label>
                    <Input
                      id="drawer-add-tag"
                      type="text"
                      placeholder="Add tag"
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      disabled={tagPending}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleAddTag();
                        }
                      }}
                      className="h-6 w-24 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddTag()}
                      disabled={tagPending || !tagInput.trim()}
                      className="rounded text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Add tag"
                    >
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p role="status" aria-live="polite" className={`mt-2 text-xs ${tagError ? 'text-danger' : 'text-muted-foreground'}`}>
                  {tagPending ? 'Saving tags...' : tagError}
                </p>
              </section>

              <section aria-labelledby="drawer-personalization-heading" className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="drawer-personalization-heading" className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-widest text-primary">
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-pulse motion-reduce:animate-none" />
                    AI personalization
                  </h3>
                  {icebreaker && (
                    <button
                      type="button"
                      onClick={() => void copyText(icebreaker.replace(/^"|"$/g, ''), 'hook')}
                      className="flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      {copied === 'hook' ? (
                        <>
                          <Check aria-hidden="true" className="h-3 w-3 text-success" />
                          Copied
                        </>
                      ) : 'Copy hook'}
                    </button>
                  )}
                </div>
                {icebreaker ? (
                  <p className="rounded-xl border border-border/80 bg-background/70 p-3 text-xs italic leading-relaxed text-foreground">
                    &quot;{icebreaker.replace(/^"|"$/g, '')}&quot;
                  </p>
                ) : icebreakerError ? (
                  <p role="alert" className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-xs text-danger">{icebreakerError}</p>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Create a concise opening line grounded in this lead&apos;s public profile.
                  </p>
                )}
                <div className="flex justify-end pt-1">
                  <Button type="button" disabled={loadingIcebreaker} onClick={() => void handleGenerateIcebreaker(profile)} size="sm" className="gap-1.5">
                    {loadingIcebreaker ? (
                      <>
                        <RefreshCw aria-hidden="true" className="h-3 w-3 motion-safe:animate-spin motion-reduce:animate-none" />
                        Creating hook...
                      </>
                    ) : (
                      <>
                        <WandSparkles aria-hidden="true" className="h-3 w-3" />
                        Create hook
                      </>
                    )}
                  </Button>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="evidence" className="mt-0 flex-1 space-y-6 overflow-y-auto p-6">
              {postIntent && (
                <section aria-labelledby="drawer-why-now-heading">
                  <h3 id="drawer-why-now-heading" className="mb-2 flex items-center gap-1.5 text-sm font-bold text-warning">
                    <Flame className="h-4 w-4" aria-hidden="true" />
                    Why now: {(postIntent.intentCategory || 'signal').replace('_', ' ')}
                  </h3>
                  <div className="space-y-2 rounded-lg border border-warning/25 bg-warning/5 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Recent LinkedIn activity</span>
                      <Badge variant="warning">{Math.round((postIntent.confidenceScore || 0) * 100)}% confidence</Badge>
                    </div>
                    {postIntent.llmReason && <p className="text-foreground/80">{postIntent.llmReason}</p>}
                    {postIntent.intentKeywords?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {postIntent.intentKeywords.map((keyword: string) => (
                          <Badge key={keyword} variant="secondary" className="px-1.5 py-0 text-xs">{keyword}</Badge>
                        ))}
                      </div>
                    )}
                    {postIntent.postSnippets?.length > 0 && (
                      <blockquote className="mt-1 border-l-2 border-warning/30 pl-2 italic text-muted-foreground">
                        &quot;{postIntent.postSnippets[0]}&quot;
                      </blockquote>
                    )}
                  </div>
                </section>
              )}

              {Boolean(lead.buyingSignalsDetected?.length) && (
                <section aria-labelledby="drawer-signals-heading">
                  <h3 id="drawer-signals-heading" className="mb-2 flex items-center gap-1.5 text-sm font-bold text-warning">
                    <Flame className="h-4 w-4" aria-hidden="true" />
                    Active job requisitions and live triggers
                  </h3>
                  <div className="space-y-2 rounded-lg border border-warning/25 bg-warning/5 p-3 text-xs">
                    {lead.buyingSignalsDetected!.map((signal, index) => (
                      <div key={`${signal}-${index}`} className="flex items-start justify-between gap-2">
                        <span className="font-semibold text-warning">{signal}</span>
                        {lead.hiringSignalUrl && (
                          <a
                            href={lead.hiringSignalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex shrink-0 items-center gap-1 text-primary underline"
                          >
                            <Link2 className="h-3 w-3" aria-hidden="true" />
                            <span>View job post</span>
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {lead.companyAccount && (lead.companyAccount.painSummary || (Array.isArray(lead.companyAccount.buyingSignals) && lead.companyAccount.buyingSignals.length > 0) || typeof lead.companyAccount.operationalPainScore === 'number') && (
                <section aria-labelledby="drawer-company-heading" className="space-y-3 rounded-2xl border border-success/20 bg-success/5 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="drawer-company-heading" className="flex items-center gap-2 text-sm font-bold text-success">
                        <Compass aria-hidden="true" className="h-4 w-4" />
                        Company pain qualification
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">{lead.companyAccount.painSummary}</p>
                    </div>
                    {typeof lead.companyAccount.operationalPainScore === 'number' && (
                      <Badge variant="success" className="shrink-0">Pain {lead.companyAccount.operationalPainScore}</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {Array.isArray(lead.companyAccount.buyingSignals) && lead.companyAccount.buyingSignals.map((signal, index) => (
                      <div key={`${signal.label}-${index}`} className="rounded-xl border border-border bg-background/50 p-3">
                        <h4 className="text-xs font-bold text-foreground">{signal.label}</h4>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{signal.evidence}</p>
                      </div>
                    ))}
                  </div>
                  {lead.decisionMakerVerification && (
                    <p className="text-xs font-semibold text-success">{lead.decisionMakerVerification.reason}</p>
                  )}
                </section>
              )}

              <section aria-labelledby="drawer-criteria-heading">
                <h3 id="drawer-criteria-heading" className="mb-2 text-sm font-bold text-foreground">Matched criteria</h3>
                {provenance.matchedCriteria.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {provenance.matchedCriteria.map((criterion) => <Badge key={criterion} variant="outline">{criterion}</Badge>)}
                  </div>
                ) : <p className="text-xs text-muted-foreground">No matched criteria recorded.</p>}
              </section>

              <section aria-labelledby="drawer-uncertainty-heading">
                <h3 id="drawer-uncertainty-heading" className="mb-2 text-sm font-bold text-foreground">Uncertainties</h3>
                {provenance.uncertainties.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-warning">
                    {provenance.uncertainties.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">No uncertainties recorded.</p>}
              </section>

              <section aria-labelledby="drawer-provenance-heading" className="space-y-3">
                <h3 id="drawer-provenance-heading" className="text-sm font-bold text-foreground">Where this prospect came from</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Fact label="Location" value={provenance.location || 'Not provided'} />
                  <Fact label="Industry" value={provenance.industry || 'Not provided'} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-foreground/80">Discovery query</h4>
                  <p className="mt-1 rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-muted-foreground">
                    {provenance.discoveryQuery || 'No discovery query was stored for this prospect.'}
                  </p>
                </div>
              </section>

              <details className="group rounded-xl border border-border bg-card/60 p-4">
                <summary className="cursor-pointer text-sm font-bold text-foreground marker:text-muted-foreground">
                  Advanced scoring diagnostics
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Fact label="Fit (out of 10)" value={String(lead.scoreBreakdown?.fitScore ?? lead.fitScore ?? 'N/A')} />
                  <Fact label="Intent (out of 10)" value={String(lead.scoreBreakdown?.intentScore ?? lead.intentScore ?? 'N/A')} />
                  <Fact
                    label="Career momentum"
                    value={lead.decisionMakerVerification?.trajectoryScore ? `${lead.decisionMakerVerification.trajectoryScore}/10` : 'N/A'}
                  />
                  <Fact
                    label="Score range (95%)"
                    value={provenance.confidenceInterval
                      ? `${provenance.confidenceInterval.lower} to ${provenance.confidenceInterval.upper}`
                      : 'N/A'}
                  />
                </div>
                {provenance.paretoSkyline && (
                  <p className="mt-3 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs text-warning">
                    <span className="font-bold">Top-ranked outlier:</span> this prospect is not out-ranked on authority, intent, and evidence specificity.
                  </p>
                )}
              </details>
            </TabsContent>

            <TabsContent value="profile" className="mt-0 flex-1 space-y-6 overflow-y-auto p-6">
              <section aria-labelledby="drawer-bio-heading">
                <SectionHeading icon={Compass}>
                  <span id="drawer-bio-heading">About</span>
                </SectionHeading>
                <p className="rounded-xl border border-border bg-card/60 p-4 text-xs leading-relaxed text-muted-foreground">
                  {profile.summary || 'Summary profile bio was not captured.'}
                </p>
              </section>

              <section aria-labelledby="drawer-experience-heading">
                <SectionHeading icon={Briefcase}>
                  <span id="drawer-experience-heading">Professional experience</span>
                </SectionHeading>
                {profile.experiences?.length ? (
                  <div className="ml-2 space-y-4 border-l-2 border-border pl-4">
                    {profile.experiences.map((experience, index) => (
                      <article key={`${experience.company}-${experience.title}-${index}`} className="relative">
                        <span aria-hidden="true" className="absolute -left-[25px] top-1.5 h-3 w-3 rounded-full border-2 border-border bg-primary" />
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          <h4 className="text-sm font-bold text-foreground">{experience.title}</h4>
                          <span className="text-xs font-medium text-muted-foreground">at {experience.company}</span>
                        </div>
                        <span className="mt-1 block w-fit rounded border border-border bg-card px-1.5 py-0.5 text-xs text-primary">
                          {experience.duration || 'Period undisclosed'}
                        </span>
                        {experience.description && (
                          <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{experience.description}</p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-border bg-card/40 p-4 text-xs text-muted-foreground">
                    No matching experience found on this profile.
                  </p>
                )}
              </section>

              <section aria-labelledby="drawer-education-heading">
                <SectionHeading icon={GraduationCap}>
                  <span id="drawer-education-heading">Education and credentials</span>
                </SectionHeading>
                {profile.education?.length ? (
                  <div className="space-y-3">
                    {profile.education.map((education, index) => (
                      <article key={`${education.school}-${index}`} className="rounded-xl border border-border bg-card p-3">
                        <h4 className="text-xs font-extrabold text-foreground">{education.school}</h4>
                        {(education.degree || education.fieldOfStudy) && (
                          <p className="mt-0.5 text-xs font-bold text-muted-foreground">
                            {education.degree} {education.fieldOfStudy ? `in ${education.fieldOfStudy}` : ''}
                          </p>
                        )}
                        {education.duration && <span className="mt-1 block text-xs font-semibold text-muted-foreground">{education.duration}</span>}
                      </article>
                    ))}
                  </div>
                ) : <p className="text-xs text-muted-foreground">Academic background not loaded.</p>}
              </section>

              {Boolean(profile.skills?.length) && (
                <section aria-labelledby="drawer-skills-heading">
                  <SectionHeading icon={Tag}>
                    <span id="drawer-skills-heading">Skills</span>
                  </SectionHeading>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.skills?.map((skill) => (
                      <Badge key={skill} variant="brand">{skill}</Badge>
                    ))}
                  </div>
                </section>
              )}
            </TabsContent>

            <TabsContent value="notes" className="mt-0 flex-1 space-y-3 overflow-y-auto p-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <FileText aria-hidden="true" className="h-4 w-4 text-primary" />
                  Internal CRM notes
                </h3>
                <span
                  role="status"
                  aria-live="polite"
                  className={`flex items-center gap-1 text-xs ${notesSaveState === 'error' ? 'text-danger' : 'text-muted-foreground'}`}
                >
                  {notesSaveState === 'saved' && <Check aria-hidden="true" className="h-3.5 w-3.5 text-success motion-safe:animate-in motion-safe:zoom-in-50" />}
                  {NOTES_SAVE_LABELS[notesSaveState]}
                </span>
              </div>
              <Textarea
                value={notesDraft}
                onChange={(event) => handleNotesChange(event.target.value)}
                onBlur={() => void flushNotes()}
                aria-label={`Internal notes for ${profile.fullName}`}
                placeholder="Log interactions, pricing notes, or key takeaways"
                rows={10}
                className="w-full resize-y"
              />
            </TabsContent>

            <TabsContent value="activity" className="mt-0 flex-1 space-y-4 overflow-y-auto p-6">
              <div className="flex items-center justify-between">
                <SectionHeading icon={History}>
                  <span>Activity & audit timeline</span>
                </SectionHeading>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void fetchActivities()}
                  disabled={loadingActivities}
                  className="h-7 text-xs text-muted-foreground"
                >
                  <RefreshCw className={`mr-1 h-3 w-3 ${loadingActivities ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>

              {loadingActivities ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <LoaderCircle className="h-6 w-6 animate-spin mr-2" />
                  <span className="text-xs">Loading activity timeline...</span>
                </div>
              ) : activitiesError ? (
                <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs text-danger">
                  {activitiesError}
                </div>
              ) : activities.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
                  <History className="mx-auto h-8 w-8 opacity-40 mb-2" />
                  <p className="font-semibold text-foreground">No activities recorded yet</p>
                  <p className="mt-1">Stage updates, notes, and profile merges will appear here as you work.</p>
                </div>
              ) : (
                <div className="relative pl-6 space-y-4 before:absolute before:bottom-0 before:left-2 before:top-2 before:w-0.5 before:bg-border">
                  {activities.map((act) => {
                    const dateStr = new Date(act.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    return (
                      <div key={act.id} className="relative group">
                        <div className="absolute -left-[23px] top-1 h-3.5 w-3.5 rounded-full border-2 border-background bg-primary ring-2 ring-primary/20" />
                        <div className="rounded-xl border border-border bg-card/60 p-3 shadow-xs space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-foreground">
                              {act.type === 'stage_change' && 'Pipeline stage changed'}
                              {act.type === 'note' && 'Notes updated'}
                              {act.type === 'enrichment' && 'Enrichment updated'}
                              {act.type === 'merge' && 'Duplicate profile merged'}
                              {act.type === 'import' && 'Lead imported'}
                              {!['stage_change', 'note', 'enrichment', 'merge', 'import'].includes(act.type) && act.type}
                            </span>
                            <span className="text-xs text-muted-foreground">{dateStr}</span>
                          </div>
                          {act.type === 'stage_change' && (
                            <p className="text-xs text-muted-foreground">
                              Moved from <span className="font-medium text-foreground">{act.fromValue || 'Initial'}</span> to <span className="font-medium text-primary">{act.toValue}</span>
                            </p>
                          )}
                          {act.type === 'note' && (
                            <p className="text-xs text-muted-foreground italic truncate">
                              &ldquo;{act.toValue}&rdquo;
                            </p>
                          )}
                          {act.type === 'merge' && (
                            <p className="text-xs text-muted-foreground">
                              Consolidated duplicate data and identities into this lead.
                            </p>
                          )}
                          <div className="text-xs text-muted-foreground/80 flex items-center gap-1 pt-1">
                            <span>Actor: {act.actor || 'User'}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>

          <footer className="flex items-center justify-between gap-3 border-t bg-surface-elevated px-6 py-3 text-xs text-muted-foreground">
            <span>Created {new Date(lead.createdAt).toLocaleDateString()}</span>
            <span>{stageLabel}</span>
          </footer>
        </SheetContent>
      </Sheet>

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this prospect?</DialogTitle>
            <DialogDescription>{profile.fullName} will be permanently removed from the CRM.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? 'Removing...' : 'Remove prospect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

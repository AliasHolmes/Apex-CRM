/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Gauge,
  Layers,
  Link2,
  Mail,
  PenTool,
  RefreshCw,
  Save,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  UserCheck,
  Wand2,
} from 'lucide-react';
import { Lead } from '../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface OutreachStudioProps {
  selectedLeadForOutreach: Lead | null;
  leads: Lead[];
}

interface SavedOutreachDraft {
  id: string;
  leadId: string;
  leadName: string;
  companyName?: string;
  tone: string;
  medium: string;
  sequenceStep: string;
  wordCount: number;
  createdAt: string;
  text: string;
}

interface StoredDraftResponse {
  id: string;
  leadId: string;
  leadName: string;
  companyName?: string;
  tone: string;
  medium: string;
  sequenceStep: string;
  wordCount: number;
  createdAt: string;
  body: string;
}

interface DraftOriginConfig {
  tone: string;
  medium: string;
  sequenceStep: string;
}

type DraftSaveState = 'idle' | 'saving' | 'saved' | 'local' | 'error' | 'dirty';

const OUTREACH_DRAFTS_KEY = 'apex_crm_outreach_drafts';

const SEQUENCE_STEPS = [
  { id: 'Step 1: First Touch', label: 'Step 1: Initial pitch', icon: Sparkles },
  { id: 'Step 2: Value Demonstration', label: 'Step 2: Show value', icon: Layers },
  { id: 'Step 3: Friendly Bump', label: 'Step 3: Follow up', icon: Send },
];

const TONE_OPTIONS = [
  { id: 'Professional', description: 'Clear and authoritative' },
  { id: 'High-Value', description: 'Evidence and value focused' },
  { id: 'Conversational', description: 'Warm and peer-to-peer' },
  { id: 'Bold', description: 'Direct and challenging' },
];

const CHANNEL_OPTIONS = [
  { id: 'Cold Email', icon: Mail, label: 'Email' },
  { id: 'LinkedIn Connection Request', icon: Link2, label: 'Connection' },
  { id: 'Detailed InMail Pitch', icon: Settings, label: 'InMail' },
];

const POLISH_MACROS = [
  { label: 'Shorten draft', directive: 'Please make the pitch extremely punchy, energetic, and under 90 words.' },
  { label: 'Soften the CTA', directive: 'Change the CTA portion to be low-friction, interest-based (e.g. open to seeing a 20s video on this?).' },
  { label: 'Emphasize ROI', directive: 'Strengthen the value proposition using only evidence supplied in the prospect profile; do not invent metrics or outcomes.' },
  { label: 'Make it conversational', directive: 'Rewrite using a highly casual, warm tone resembling a peer-to-peer slack chat instead of generic cold outbound.' },
];

const SPAM_KEYWORDS = [
  'guarantee', 'guaranteed', '100% free', 'risk-free', 'miracle', 'make money',
  'make cash', 'earn cash', 'double your sales', 'no obligation', 'winning',
  'secrets', 'act now', 'limited time', 'winner', 'millionaire', 'buy now',
];

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

const isSavedOutreachDraft = (value: unknown): value is SavedOutreachDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<SavedOutreachDraft>;
  return typeof draft.id === 'string'
    && typeof draft.leadId === 'string'
    && typeof draft.leadName === 'string'
    && typeof draft.tone === 'string'
    && typeof draft.medium === 'string'
    && typeof draft.sequenceStep === 'string'
    && typeof draft.wordCount === 'number'
    && typeof draft.createdAt === 'string'
    && typeof draft.text === 'string';
};

const readLocalDrafts = (): SavedOutreachDraft[] => {
  const saved = localStorage.getItem(OUTREACH_DRAFTS_KEY);
  if (!saved) return [];
  const parsed: unknown = JSON.parse(saved);
  return Array.isArray(parsed) ? parsed.filter(isSavedOutreachDraft).slice(0, 12) : [];
};

const cacheDrafts = (drafts: SavedOutreachDraft[]) => {
  localStorage.setItem(OUTREACH_DRAFTS_KEY, JSON.stringify(drafts.slice(0, 12)));
};

const mergeDraftCollections = (
  serverDrafts: SavedOutreachDraft[],
  localDrafts: SavedOutreachDraft[],
) => {
  const serverIds = new Set(serverDrafts.map((draft) => draft.id));
  const newestFirst = (a: SavedOutreachDraft, b: SavedOutreachDraft) =>
    b.createdAt.localeCompare(a.createdAt);
  const localOnlyDrafts = localDrafts
    .filter((draft) => !serverIds.has(draft.id))
    .sort(newestFirst);
  const serverCopies = [...serverDrafts].sort(newestFirst);
  // Keep every unsynced local draft ahead of server copies so the 12-item cache
  // limit can never silently evict the only surviving copy of a failed save.
  return [...localOnlyDrafts, ...serverCopies].slice(0, 12);
};

const formatDraftDate = (createdAt: string) => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Saved draft';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

export default function OutreachStudio({ selectedLeadForOutreach, leads }: OutreachStudioProps) {
  const [currentLeadId, setCurrentLeadId] = useState('');
  const [tone, setTone] = useState('High-Value');
  const [medium, setMedium] = useState('Cold Email');
  const [loading, setLoading] = useState(false);
  const [outreachCopy, setOutreachCopy] = useState('');
  const [draftLeadId, setDraftLeadId] = useState('');
  const [draftOriginConfig, setDraftOriginConfig] = useState<DraftOriginConfig | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [senderName, setSenderName] = useState('Arnob');
  const [senderCompany, setSenderCompany] = useState('Lead-Finder Pro');
  const [valueProposition, setValueProposition] = useState(
    'building customized search-grounded workflows to automate verified prospect routing directly into active CRMs'
  );
  const [sequenceStep, setSequenceStep] = useState('Step 1: First Touch');
  const [customInstruction, setCustomInstruction] = useState('');
  const [showSenderConfig, setShowSenderConfig] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<SavedOutreachDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftLibraryMessage, setDraftLibraryMessage] = useState('Loading saved drafts...');
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>('idle');
  const [draftStatusMessage, setDraftStatusMessage] = useState('Generated drafts are saved automatically.');
  const draftRevisionRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const lastIncomingLeadIdRef = useRef<string | null>(null);
  const savedDraftsRef = useRef<SavedOutreachDraft[]>([]);
  const isMountedRef = useRef(true);
  const generationAbortRef = useRef<AbortController | null>(null);
  const generationRequestIdRef = useRef(0);
  const prefersReducedMotion = useReducedMotion();

  const commitSavedDrafts = useCallback((drafts: SavedOutreachDraft[]) => {
    savedDraftsRef.current = drafts;
    setSavedDrafts(drafts);
  }, []);

  const getLatestDrafts = useCallback(() => {
    let cachedDrafts: SavedOutreachDraft[] = [];
    try {
      cachedDrafts = readLocalDrafts();
    } catch (error) {
      console.warn('Failed to read the latest outreach draft cache:', error);
    }
    return mergeDraftCollections(savedDraftsRef.current, cachedDrafts);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      generationRequestIdRef.current += 1;
      saveRequestIdRef.current += 1;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const canUpdate = () => isMountedRef.current && !controller.signal.aborted;

    const loadDrafts = async () => {
      let initialLocalDrafts: SavedOutreachDraft[] = [];
      try {
        initialLocalDrafts = readLocalDrafts();
        if (initialLocalDrafts.length > 0 && canUpdate()) {
          commitSavedDrafts(initialLocalDrafts);
        }
      } catch (error) {
        console.warn('Failed to read the local outreach draft cache:', error);
        if (canUpdate()) setDraftLibraryMessage('The local draft cache could not be read.');
      }

      try {
        const response = await fetch('/api/outreach-drafts', { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { drafts?: StoredDraftResponse[] };
        if (!canUpdate()) return;

        const serverDrafts = Array.isArray(data.drafts)
          ? data.drafts.map((draft) => ({
            id: draft.id,
            leadId: draft.leadId,
            leadName: draft.leadName,
            companyName: draft.companyName,
            tone: draft.tone,
            medium: draft.medium,
            sequenceStep: draft.sequenceStep,
            wordCount: draft.wordCount,
            createdAt: draft.createdAt,
            text: draft.body,
          })).filter(isSavedOutreachDraft).slice(0, 12)
          : [];
        // Re-read both the ref and localStorage after the GET resolves. A draft
        // created during hydration must be merged, never replaced by the snapshot.
        const latestLocalDrafts = getLatestDrafts();

        if (serverDrafts.length > 0) {
          const serverDraftIds = new Set(serverDrafts.map((draft) => draft.id));
          const localOnlyDrafts = latestLocalDrafts.filter((draft) => !serverDraftIds.has(draft.id));
          const mergedDrafts = mergeDraftCollections(serverDrafts, latestLocalDrafts);
          commitSavedDrafts(mergedDrafts);
          try {
            cacheDrafts(mergedDrafts);
          } catch (error) {
            console.warn('Failed to refresh the local outreach draft cache:', error);
          }

          if (localOnlyDrafts.length > 0) {
            const retryResults = await Promise.allSettled(localOnlyDrafts.map((draft) =>
              fetch('/api/outreach-drafts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                  id: draft.id,
                  leadId: draft.leadId,
                  leadName: draft.leadName,
                  companyName: draft.companyName,
                  tone: draft.tone,
                  medium: draft.medium,
                  sequenceStep: draft.sequenceStep,
                  wordCount: draft.wordCount,
                  body: draft.text,
                }),
              }).then((retryResponse) => {
                if (!retryResponse.ok) throw new Error(`HTTP ${retryResponse.status}`);
              })
            ));
            if (!canUpdate()) return;
            const allRetried = retryResults.every((result) => result.status === 'fulfilled');
            setDraftLibraryMessage(
              allRetried
                ? `${mergedDrafts.length} saved ${mergedDrafts.length === 1 ? 'draft' : 'drafts'} available; local drafts were synced.`
                : `${mergedDrafts.length} drafts available; some remain cached only on this device.`,
            );
          } else {
            setDraftLibraryMessage(`${mergedDrafts.length} saved ${mergedDrafts.length === 1 ? 'draft' : 'drafts'} available.`);
          }
          return;
        }

        if (latestLocalDrafts.length === 0) {
          setDraftLibraryMessage('No saved drafts yet. Generated drafts will appear here.');
          return;
        }

        commitSavedDrafts(latestLocalDrafts);
        const migrationResults = await Promise.allSettled(latestLocalDrafts.map((draft) =>
          fetch('/api/outreach-drafts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              id: draft.id,
              leadId: draft.leadId,
              leadName: draft.leadName,
              companyName: draft.companyName,
              tone: draft.tone,
              medium: draft.medium,
              sequenceStep: draft.sequenceStep,
              wordCount: draft.wordCount,
              body: draft.text,
            }),
          }).then((migrationResponse) => {
            if (!migrationResponse.ok) throw new Error(`HTTP ${migrationResponse.status}`);
          })
        ));
        if (!canUpdate()) return;
        const synced = migrationResults.every((result) => result.status === 'fulfilled');
        setDraftLibraryMessage(
          synced
            ? `${latestLocalDrafts.length} local ${latestLocalDrafts.length === 1 ? 'draft was' : 'drafts were'} synced.`
            : 'Local drafts are available; some could not be synced to the workspace.'
        );
      } catch (error) {
        if (isAbortError(error) || !canUpdate()) return;
        console.warn('Failed to load outreach drafts from server, falling back to localStorage:', error);
        const latestDrafts = getLatestDrafts();
        commitSavedDrafts(latestDrafts);
        setDraftLibraryMessage(
          latestDrafts.length > 0
            ? 'Workspace storage is unavailable. Showing drafts cached on this device.'
            : 'Saved drafts could not be loaded. New drafts will still be cached on this device.'
        );
      } finally {
        if (canUpdate()) setDraftsLoading(false);
      }
    };

    void loadDrafts();
    return () => controller.abort();
  }, [commitSavedDrafts, getLatestDrafts]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    const incomingLeadId = selectedLeadForOutreach?.id ?? null;
    if (incomingLeadId && incomingLeadId !== lastIncomingLeadIdRef.current) {
      setCurrentLeadId(incomingLeadId);
    }
    lastIncomingLeadIdRef.current = incomingLeadId;
  }, [selectedLeadForOutreach?.id]);

  useEffect(() => {
    setCurrentLeadId((current) => {
      if (current && leads.some((lead) => lead.id === current)) return current;
      return leads[0]?.id ?? '';
    });
  }, [leads]);

  const targetLead = useMemo(
    () => leads.find((lead) => lead.id === currentLeadId),
    [currentLeadId, leads]
  );
  const draftLead = useMemo(
    () => leads.find((lead) => lead.id === draftLeadId),
    [draftLeadId, leads]
  );

  const rememberDraft = async (draftText: string, lead: Lead, originConfig: DraftOriginConfig) => {
    if (!draftText.trim() || !isMountedRef.current) return;
    const revisionAtSave = draftRevisionRef.current;
    const requestId = ++saveRequestIdRef.current;
    const nextDraft: SavedOutreachDraft = {
      id: typeof crypto.randomUUID === 'function'
        ? `draft-${crypto.randomUUID()}`
        : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      leadId: lead.id,
      leadName: lead.profile.fullName,
      companyName: lead.profile.currentCompany,
      tone: originConfig.tone,
      medium: originConfig.medium,
      sequenceStep: originConfig.sequenceStep,
      wordCount: draftText.trim().split(/\s+/).filter(Boolean).length,
      createdAt: new Date().toISOString(),
      text: draftText,
    };
    const currentDrafts = getLatestDrafts();
    const nextDrafts = [
      nextDraft,
      ...currentDrafts.filter((draft) => draft.id !== nextDraft.id),
    ].slice(0, 12);
    // Update the ref synchronously so another save in this render tick builds
    // on this draft instead of a stale React-state closure.
    commitSavedDrafts(nextDrafts);
    setDraftSaveState('saving');
    setDraftStatusMessage('Saving draft...');

    let cachedLocally = false;
    try {
      cacheDrafts(nextDrafts);
      cachedLocally = true;
    } catch (error) {
      console.warn('Failed to cache outreach draft locally:', error);
    }

    try {
      const response = await fetch('/api/outreach-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: nextDraft.id,
          leadId: nextDraft.leadId,
          leadName: nextDraft.leadName,
          companyName: nextDraft.companyName,
          tone: nextDraft.tone,
          medium: nextDraft.medium,
          sequenceStep: nextDraft.sequenceStep,
          wordCount: nextDraft.wordCount,
          body: nextDraft.text,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!isMountedRef.current || requestId !== saveRequestIdRef.current) return;
      if (revisionAtSave !== draftRevisionRef.current) {
        setDraftSaveState('dirty');
        setDraftStatusMessage('The saved version is secure, but this draft has newer unsaved changes.');
        return;
      }
      setDraftSaveState('saved');
      setDraftStatusMessage('Draft saved to the workspace and cached on this device.');
      setDraftLibraryMessage(`${nextDrafts.length} saved ${nextDrafts.length === 1 ? 'draft' : 'drafts'} available.`);
    } catch (error) {
      if (!isMountedRef.current || requestId !== saveRequestIdRef.current) return;
      console.warn('Failed to save outreach draft to server:', error);
      if (revisionAtSave !== draftRevisionRef.current) {
        setDraftSaveState('dirty');
        setDraftStatusMessage('This draft has unsaved changes.');
        return;
      }
      setDraftSaveState(cachedLocally ? 'local' : 'error');
      setDraftStatusMessage(
        cachedLocally
          ? 'Workspace save failed. This draft is safely cached on this device.'
          : 'Draft could not be saved. Copy the text before leaving this page.'
      );
    }
  };

  const handleGeneratePitch = async (appliedMacroDirective?: string) => {
    if (!targetLead) {
      setErrorCode('Select a prospect before generating a draft.');
      return;
    }
    if (draftsLoading) {
      setErrorCode('Wait for saved drafts to finish loading before generating a new draft.');
      return;
    }

    generationAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++generationRequestIdRef.current;
    generationAbortRef.current = controller;
    const isCurrentRequest = () => isMountedRef.current
      && !controller.signal.aborted
      && requestId === generationRequestIdRef.current;
    const generationLead = targetLead;

    setLoading(true);
    setErrorCode(null);
    setCopyError(null);
    setOutreachCopy('');
    setDraftOriginConfig(null);
    draftRevisionRef.current += 1;
    saveRequestIdRef.current += 1;
    setDraftSaveState('idle');
    setDraftStatusMessage('Generating a new draft...');

    const activeInstruction = appliedMacroDirective ?? customInstruction;
    const generationConfig: DraftOriginConfig = { tone, medium, sequenceStep };
    if (appliedMacroDirective !== undefined) setCustomInstruction(appliedMacroDirective);

    try {
      const response = await fetch('/api/generate-outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          profile: generationLead.profile,
          companyAccount: generationLead.companyAccount,
          buyingSignals: generationLead.companyAccount?.buyingSignals,
          tone: generationConfig.tone,
          pitchType: generationConfig.medium,
          valueProposition,
          senderName,
          senderCompany,
          sequenceStep: generationConfig.sequenceStep,
          customInstruction: activeInstruction,
        }),
      });

      if (!isCurrentRequest()) return;
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({})) as { error?: string };
        if (!isCurrentRequest()) return;
        throw new Error(errorBody.error || `Outbound engine failed with status ${response.status}`);
      }

      const data = await response.json() as { text?: unknown };
      if (!isCurrentRequest()) return;
      const generatedText = typeof data.text === 'string' ? data.text.trim() : '';
      if (!generatedText) throw new Error('The outbound engine returned an empty draft. Please try again.');
      setOutreachCopy(generatedText);
      setDraftLeadId(generationLead.id);
      setDraftOriginConfig(generationConfig);
      draftRevisionRef.current += 1;
      void rememberDraft(generatedText, generationLead, generationConfig);
    } catch (error) {
      if (isAbortError(error) || !isCurrentRequest()) return;
      console.error(error);
      setErrorCode(getErrorMessage(error, 'Could not generate the outreach draft.'));
      setDraftStatusMessage('No draft was saved because generation failed.');
    } finally {
      if (isCurrentRequest()) {
        generationAbortRef.current = null;
        setLoading(false);
      }
    }
  };

  const handleCopyToClipboard = async () => {
    if (!outreachCopy) return;
    setCopyError(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
      await navigator.clipboard.writeText(outreachCopy);
      setCopied(true);
    } catch (error) {
      setCopied(false);
      setCopyError(getErrorMessage(error, 'Could not copy the draft. Select the text and copy it manually.'));
    }
  };

  const handleLoadDraft = (draft: SavedOutreachDraft) => {
    const originalLeadIsAvailable = leads.some((lead) => lead.id === draft.leadId);
    setOutreachCopy(draft.text);
    setTone(draft.tone);
    setMedium(draft.medium);
    setSequenceStep(draft.sequenceStep);
    setDraftLeadId(draft.leadId);
    setDraftOriginConfig({
      tone: draft.tone,
      medium: draft.medium,
      sequenceStep: draft.sequenceStep,
    });
    if (originalLeadIsAvailable) setCurrentLeadId(draft.leadId);
    draftRevisionRef.current += 1;
    saveRequestIdRef.current += 1;
    setErrorCode(null);
    setCopyError(null);
    setDraftSaveState('saved');
    setDraftStatusMessage(
      originalLeadIsAvailable
        ? `Loaded the saved draft for ${draft.leadName}.`
        : `Loaded the draft for ${draft.leadName}, but that prospect is no longer in this workspace.`
    );
  };

  const getMailToLink = () => {
    if (!draftLead || !outreachCopy) return '#';
    const email = draftLead.profile.contactDetails?.email || '';
    let subject = 'Connecting with you';
    const subjectLine = outreachCopy.split('\n').find((line) => line.toLowerCase().includes('subject:'));
    if (subjectLine) subject = subjectLine.replace(/subject:/i, '').trim();
    const cleanBody = outreachCopy
      .replace(/subject:.*\n/i, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cleanBody)}`;
  };

  const getPersonalizationScore = (text: string) => {
    if (!draftLead || !text) return { score: 'None' as const, matches: [] as string[] };
    const matches: string[] = [];
    const lowerText = text.toLowerCase();
    const firstName = draftLead.profile.fullName.split(' ')[0].toLowerCase();
    if (firstName && lowerText.includes(firstName)) matches.push('First name');
    const organization = (draftLead.profile.currentCompany || '').toLowerCase();
    if (organization && lowerText.includes(organization)) matches.push('Company');
    const title = (draftLead.profile.currentTitle || '').toLowerCase();
    if (title && lowerText.includes(title)) matches.push('Role');
    const score = matches.length === 3 ? 'High' : matches.length === 2 ? 'Medium' : matches.length === 1 ? 'Low' : 'None';
    return { score, matches };
  };

  const wordCount = outreachCopy ? outreachCopy.trim().split(/\s+/).filter(Boolean).length : 0;
  const spamMatches = outreachCopy
    ? SPAM_KEYWORDS.filter((word) => outreachCopy.toLowerCase().includes(word))
    : [];
  const personalizationCheck = outreachCopy
    ? getPersonalizationScore(outreachCopy)
    : { score: 'None' as const, matches: [] as string[] };
  const readingTimeSeconds = Math.ceil((wordCount / 130) * 60);
  const draftTargetsDifferent = Boolean(
    outreachCopy && draftLeadId && currentLeadId && draftLeadId !== currentLeadId
  );
  const draftLeadUnavailable = Boolean(outreachCopy && draftLeadId && !draftLead);
  const draftSettingsDifferent = Boolean(
    outreachCopy
      && draftOriginConfig
      && (draftOriginConfig.tone !== tone
        || draftOriginConfig.medium !== medium
        || draftOriginConfig.sequenceStep !== sequenceStep)
  );
  const draftIsEmail = draftOriginConfig?.medium === 'Cold Email';
  const saveStatusClass = draftSaveState === 'error'
    ? 'text-rose-300'
    : draftSaveState === 'local'
      ? 'text-amber-300'
      : draftSaveState === 'saved'
        ? 'text-emerald-300'
        : 'text-slate-400';

  return (
    <Card className="relative grid grid-cols-1 overflow-hidden border-0 shadow-2xl divide-y divide-slate-800 lg:grid-cols-5 lg:divide-x lg:divide-y-0">
      <section
        aria-labelledby="outreach-settings-title"
        className="space-y-6 bg-slate-950/45 p-4 sm:p-6 lg:col-span-2 lg:max-h-[850px] lg:overflow-y-auto custom-scrollbar"
      >
        <div>
          <h3 id="outreach-settings-title" className="flex items-center gap-2 text-lg font-bold text-white">
            <Wand2 className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            AI Outreach Studio
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            Build a grounded outreach draft from the prospect details already in your workspace.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="lead-selector" className="block text-xs font-bold uppercase tracking-wider text-slate-300">
            Target prospect
          </label>
          <select
            id="lead-selector"
            value={currentLeadId}
            onChange={(event) => setCurrentLeadId(event.target.value)}
            disabled={loading || leads.length === 0}
            aria-describedby={leads.length === 0 ? 'outreach-no-leads' : undefined}
            className="w-full cursor-pointer rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {leads.length === 0 ? (
              <option value="">No prospects available</option>
            ) : (
              leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.profile.fullName} ({lead.profile.currentCompany || 'Independent'})
                </option>
              ))
            )}
          </select>
          {leads.length === 0 && (
            <p id="outreach-no-leads" role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-sm text-sky-200">
              Add or discover a prospect first, then return here to create outreach.
            </p>
          )}
        </div>

        {targetLead?.companyAccount && (
          <aside aria-label="Account context" className="space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="block text-xs font-bold uppercase tracking-wider text-emerald-300">Account context</span>
                <p className="mt-1 text-sm font-semibold text-slate-200">{targetLead.companyAccount.name}</p>
              </div>
              <Badge variant="outline" className="border-emerald-500/30 text-xs text-emerald-300">
                Pain {targetLead.companyAccount.operationalPainScore}
              </Badge>
            </div>
            <div className="space-y-2">
              {targetLead.companyAccount.buyingSignals.slice(0, 3).map((signal, index) => (
                <div key={`${signal.label}-${index}`} className="flex gap-2 text-sm text-slate-300">
                  <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                  <span>{signal.label}</span>
                </div>
              ))}
            </div>
          </aside>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/30">
          <button
            type="button"
            onClick={() => setShowSenderConfig((visible) => !visible)}
            aria-expanded={showSenderConfig}
            aria-controls="sender-settings-panel"
            className="flex w-full cursor-pointer items-center justify-between p-3.5 text-left text-sm font-bold text-slate-300 transition-colors hover:bg-slate-900/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
          >
            <span className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Sender details
            </span>
            {showSenderConfig
              ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
              : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>

          <AnimatePresence initial={false}>
            {showSenderConfig && (
              <motion.div
                id="sender-settings-panel"
                initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
                className="overflow-hidden border-t border-slate-800 bg-slate-950/80"
              >
                <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label htmlFor="sender-name" className="block text-xs font-bold text-slate-300">Your name</label>
                    <Input
                      id="sender-name"
                      type="text"
                      value={senderName}
                      onChange={(event) => setSenderName(event.target.value)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="sender-company" className="block text-xs font-bold text-slate-300">Company or product</label>
                    <Input
                      id="sender-company"
                      type="text"
                      value={senderCompany}
                      onChange={(event) => setSenderCompany(event.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="value-proposition" className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Core offer
            </label>
            <span id="value-proposition-help" className="text-xs text-slate-500">Used to shape the opening hook</span>
          </div>
          <Textarea
            id="value-proposition"
            value={valueProposition}
            onChange={(event) => setValueProposition(event.target.value)}
            disabled={loading}
            rows={3}
            className="resize-y"
            aria-describedby="value-proposition-help"
            placeholder="Describe the outcome or service you can offer."
          />
        </div>

        <fieldset disabled={loading} className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-slate-300">Tone</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TONE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTone(option.id)}
                aria-pressed={tone === option.id}
                className={`cursor-pointer rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 ${
                  tone === option.id
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900'
                }`}
              >
                <span className="block text-sm font-bold">{option.id}</span>
                <span className="mt-1 block text-xs text-slate-400">{option.description}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={loading} className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-slate-300">Delivery channel</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {CHANNEL_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMedium(option.id)}
                  aria-pressed={medium === option.id}
                  className={`flex min-h-20 cursor-pointer flex-row items-center justify-center gap-2 rounded-xl border p-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-col ${
                    medium === option.id
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-200'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="custom-instruction" className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Additional direction
            </label>
            <span id="custom-instruction-help" className="text-xs text-slate-500">Optional</span>
          </div>
          <Input
            id="custom-instruction"
            type="text"
            value={customInstruction}
            onChange={(event) => setCustomInstruction(event.target.value)}
            disabled={loading}
            aria-describedby="custom-instruction-help"
            placeholder="For example: focus on their location or keep it under 90 words."
          />
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            onClick={() => void handleGeneratePitch()}
            disabled={draftsLoading || loading || !targetLead}
            aria-describedby="outreach-save-status"
            className="w-full py-6 text-sm shadow-md shadow-primary/10"
          >
            {draftsLoading || loading
              ? <RefreshCw className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
            {draftsLoading ? 'Preparing draft library...' : loading ? 'Generating draft...' : 'Generate outreach draft'}
          </Button>
          <p id="outreach-save-status" role="status" aria-live="polite" className={`text-sm ${saveStatusClass}`}>
            {draftStatusMessage}
          </p>
        </div>

        <section aria-labelledby="draft-library-title" className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 id="draft-library-title" className="text-xs font-bold uppercase tracking-wider text-slate-300">Saved drafts</h4>
            <Badge variant="outline" className="text-xs">{savedDrafts.length}</Badge>
          </div>
          <p role="status" aria-live="polite" className="text-xs leading-relaxed text-slate-400">
            {draftLibraryMessage}
          </p>
          {draftsLoading ? (
            <div className="space-y-2" aria-hidden="true">
              <div className="h-14 animate-pulse rounded-lg bg-slate-900 motion-reduce:animate-none" />
              <div className="h-14 animate-pulse rounded-lg bg-slate-900 motion-reduce:animate-none" />
            </div>
          ) : savedDrafts.length > 0 ? (
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
              {savedDrafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => handleLoadDraft(draft)}
                  aria-label={`Load draft for ${draft.leadName}, ${draft.wordCount} words, saved ${formatDraftDate(draft.createdAt)}`}
                  className="w-full cursor-pointer rounded-lg border border-slate-800 bg-slate-950 p-3 text-left transition-colors hover:border-slate-700 hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span className="block truncate text-sm font-bold text-slate-200">
                    {draft.leadName} - {draft.companyName || 'Independent'}
                  </span>
                  <span className="mt-1 block text-xs text-slate-400">
                    {draft.sequenceStep} / {draft.medium} / {draft.wordCount} words
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">{formatDraftDate(draft.createdAt)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </section>

      <section
        aria-labelledby="outreach-composer-title"
        className="flex min-h-[560px] flex-col justify-between gap-6 bg-slate-900/5 p-4 sm:p-6 lg:col-span-3"
      >
        <div className="space-y-4">
          <div className="space-y-3 border-b border-slate-800 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Sequence step</h3>
              <span className="text-xs text-slate-500">Choose the purpose of this touch</span>
            </div>
            <div role="group" aria-label="Outreach sequence steps" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-1 custom-scrollbar">
              {SEQUENCE_STEPS.map((step, index) => {
                const Icon = step.icon;
                const isActive = sequenceStep === step.id;
                return (
                  <button
                    key={step.id}
                    id={`sequence-step-${index}`}
                    type="button"
                    aria-pressed={isActive}
                    aria-controls="outreach-composer-panel"
                    onClick={() => setSequenceStep(step.id)}
                    disabled={loading}
                    className={`flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                      isActive
                        ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200'
                        : 'border-transparent text-slate-400 hover:bg-slate-900/50 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                    <span>{step.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <PenTool className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <label id="outreach-composer-title" htmlFor="outreach-copy" className="text-sm font-bold text-slate-300">
                Draft editor
              </label>
            </div>

            {outreachCopy && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (draftLead && draftOriginConfig) {
                      void rememberDraft(outreachCopy, draftLead, draftOriginConfig);
                    }
                  }}
                  disabled={!draftLead || !draftOriginConfig || loading || draftSaveState === 'saving' || draftSaveState === 'saved'}
                  aria-label={draftSaveState === 'saved' ? 'Current outreach draft is already saved' : 'Save the current outreach draft'}
                >
                  {draftSaveState === 'saving'
                    ? <RefreshCw className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : <Save className="mr-1.5 h-4 w-4" aria-hidden="true" />}
                  {draftSaveState === 'saving' ? 'Saving...' : draftSaveState === 'saved' ? 'Saved' : 'Save draft'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopyToClipboard()}
                  aria-label={copied ? 'Draft copied to clipboard' : 'Copy draft to clipboard'}
                >
                  <Clipboard className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                {draftIsEmail && draftLead?.profile.contactDetails?.email && (
                  <Button variant="secondary" size="sm" asChild>
                    <a href={getMailToLink()} aria-label={`Open this draft in your email app for ${draftLead.profile.fullName}`}>
                      <Mail className="mr-1.5 h-4 w-4" aria-hidden="true" />
                      Open email app
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>

          <div aria-live="polite" className="min-h-5 text-sm">
            {copied && <span className="text-emerald-300">Draft copied to the clipboard.</span>}
            {copyError && <span role="alert" className="text-rose-300">{copyError}</span>}
            {draftTargetsDifferent && draftLead && (
              <span className="block text-amber-300">
                This open draft remains linked to {draftLead.profile.fullName}. Generate a new draft for the newly selected prospect.
              </span>
            )}
            {draftLeadUnavailable && (
              <span className="block text-amber-300">
                The prospect linked to this draft is no longer available, so save and email actions are disabled.
              </span>
            )}
            {draftSettingsDifferent && draftOriginConfig && (
              <span className="block text-amber-300">
                The controls have changed since this draft was created. Regenerate to apply them; saving and email actions still use the draft's original settings ({draftOriginConfig.tone}, {draftOriginConfig.medium}, {draftOriginConfig.sequenceStep}).
              </span>
            )}
          </div>

          <div
            id="outreach-composer-panel"
            role="region"
            aria-label="Outreach draft composer"
            className="relative flex min-h-[300px] flex-col rounded-2xl border border-slate-800 bg-slate-950/80 transition-shadow focus-within:ring-2 focus-within:ring-indigo-500/40"
          >
            <AnimatePresence mode="wait">
              {loading && (
                <motion.div
                  key="outreach-loading"
                  role="status"
                  aria-live="polite"
                  initial={prefersReducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0 : 0.15 }}
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 rounded-2xl bg-slate-950/95 p-6 text-center shadow-2xl"
                >
                  <div className="h-9 w-9 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-200">Creating a grounded outreach draft...</p>
                    <p className="text-xs text-slate-400">Using the selected prospect, offer, tone, and sequence step.</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {outreachCopy ? (
              <Textarea
                id="outreach-copy"
                value={outreachCopy}
                onChange={(event) => {
                  setOutreachCopy(event.target.value);
                  draftRevisionRef.current += 1;
                  setDraftSaveState('dirty');
                  setDraftStatusMessage('This draft has unsaved changes.');
                  setCopyError(null);
                }}
                disabled={loading}
                aria-describedby="outreach-save-status composer-quality-summary"
                className="min-h-[320px] w-full flex-1 resize-y whitespace-pre-wrap rounded-t-2xl border-0 text-sm leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 custom-scrollbar"
                placeholder="Write or edit your outreach draft here."
              />
            ) : errorCode ? (
              <div role="alert" className="flex min-h-[300px] flex-col items-start justify-center gap-4 rounded-2xl bg-rose-950/10 p-6 text-sm text-rose-200 sm:p-8">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />
                  <div>
                    <p className="font-bold">The draft could not be generated.</p>
                    <p className="mt-1 leading-relaxed text-rose-200/80">{errorCode}</p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleGeneratePitch()} disabled={!targetLead || draftsLoading || loading}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center px-6 py-16 text-center">
                <Send className="mb-3 h-10 w-10 text-slate-700" aria-hidden="true" />
                <p className="text-sm font-bold text-slate-300">
                  {leads.length === 0 ? 'No prospect selected' : 'No draft yet'}
                </p>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
                  {leads.length === 0
                    ? 'Add a prospect to your workspace before creating outreach.'
                    : 'Generate a new draft from the settings, or load one from Saved drafts.'}
                </p>
              </div>
            )}

            {outreachCopy && (
              <div id="composer-quality-summary" aria-label="Draft quality summary" className="grid grid-cols-2 gap-3 rounded-b-2xl border-t border-slate-900 bg-slate-950/90 p-3 text-slate-400 md:grid-cols-4">
                <div className="space-y-1 border-r border-slate-900 pr-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Word count</div>
                  <div className={`text-sm font-bold ${wordCount > 150 && draftIsEmail ? 'text-amber-400' : 'text-slate-200'}`}>
                    {wordCount} words{wordCount > 150 && draftIsEmail ? ' - long' : ''}
                  </div>
                </div>
                <div className="space-y-1 border-r border-slate-900 px-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Read time</div>
                  <div className="text-sm font-bold text-slate-200">{readingTimeSeconds} seconds</div>
                </div>
                <div className="space-y-1 border-r border-slate-900 px-2">
                  <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-slate-500">
                    <Gauge className="h-3 w-3 text-emerald-400" aria-hidden="true" /> Grounding
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge
                      variant={personalizationCheck.score === 'High' ? 'default' : personalizationCheck.score === 'Medium' ? 'secondary' : 'outline'}
                      className="px-1.5 py-0.5 text-xs"
                    >
                      {personalizationCheck.score}
                    </Badge>
                    <span className="text-xs text-slate-500">{personalizationCheck.matches.length}/3 details</span>
                  </div>
                </div>
                <div className="space-y-1 pl-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Spam check</div>
                  <div className={`text-sm font-bold ${spamMatches.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {spamMatches.length === 0 ? 'No triggers found' : `${spamMatches.length} ${spamMatches.length === 1 ? 'trigger' : 'triggers'}`}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <section aria-labelledby="quick-refine-title" className="space-y-2">
            <h4 id="quick-refine-title" className="text-xs font-bold uppercase tracking-wider text-slate-300">Quick refinements</h4>
            <p className="text-xs text-slate-500">Each option regenerates the draft with that instruction.</p>
            <div className="flex flex-wrap gap-2">
              {POLISH_MACROS.map((macro) => (
                <Button
                  key={macro.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draftsLoading || loading || !targetLead}
                  onClick={() => void handleGeneratePitch(macro.directive)}
                  className="text-xs"
                >
                  {macro.label}
                </Button>
              ))}
            </div>
          </section>

          <AnimatePresence initial={false}>
            {outreachCopy && spamMatches.length > 0 && (
              <motion.div
                role="status"
                initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
                className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-100"
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                <div>
                  <p className="font-bold text-amber-300">Review possible spam triggers</p>
                  <p className="mt-1 leading-relaxed text-slate-400">
                    Consider replacing: <span className="font-semibold text-amber-300">{spamMatches.join(', ')}</span>.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {draftLead && (
            <aside aria-label="Selected prospect details" className="flex flex-col gap-3 rounded-xl border border-indigo-500/10 bg-indigo-500/5 p-3.5 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span className="mb-1 block font-bold text-indigo-300">Draft context</span>
                <span className="leading-relaxed text-slate-300">
                  <span className="font-bold text-slate-200">{draftLead.profile.fullName}</span>
                  {' - '}{draftLead.profile.industry || 'B2B'}
                  {' - '}{draftLead.profile.contactDetails?.email || 'Email not available'}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <Badge variant="outline" className="text-xs font-bold">
                  {(draftLead.profile.experiences || []).length} experiences
                </Badge>
                <Badge variant="outline" className="text-xs font-bold">
                  {(draftLead.profile.skills || []).length} skills
                </Badge>
              </div>
            </aside>
          )}
        </div>
      </section>
    </Card>
  );
}

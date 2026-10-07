/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { useLeads } from '../context/LeadContext';
import { buildProfileDedupeKeys } from '../utils/leadDedupe';
import { createCsvFieldReader, CSV_FIELD_ALIASES } from '../utils/csvFieldMapping';
import Papa from 'papaparse';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Ellipsis,
  FileDown,
  Flame,
  Layers,
  Link2,
  LoaderCircle,
  Mail,
  Radio,
  Rows3,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UploadCloud,
  UserCheck,
  UserPlus2,
  X,
  Zap
} from 'lucide-react';
import {
  ColumnDef,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Lead, NextAction, ReviewStatus } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProspectFilterBar } from '@/components/prospects/ProspectFilterBar';
import { SavedViewsMenu } from '@/components/prospects/SavedViewsMenu';
import { PIPELINE_STAGES, getPipelineStageMeta } from '@/lib/pipeline';
import { PROSPECTS_PAGE_SIZE } from '@/lib/ui';
import {
  EMPTY_PROSPECT_FILTERS,
  PROSPECT_COLUMNS,
  PROSPECT_TABLE_PREFS_KEY,
  PROSPECT_VIEWS_STORAGE_KEY,
  createViewId,
  parseStoredViews,
  parseTablePrefs,
  serializeTablePrefs,
  serializeViews,
  sortLeads,
  type ProspectColumnId,
  type ProspectDensity,
  type ProspectFilters,
  type ProspectSort,
  type ProspectSortKey,
  type ProspectView,
} from '@/lib/prospectViews';
import { setLockedLeadIds } from '@/lib/leadLocks';
import {
  getLeadProvenance,
  getNextAction,
  getNextActionLabel,
  getReviewStatus,
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '@/lib/prospectWorkflow';

/** One-shot filter preset pushed in from elsewhere (for example Overview shortcuts). */
export interface ProspectPreset {
  /** Changes on every request so the same preset can be applied twice. */
  nonce: number;
  filters: Partial<ProspectFilters>;
}

interface LeadTableRowProps {
  lead: Lead;
  dataIndex?: number;
  visibleColumns: ReadonlySet<ProspectColumnId>;
  isSelected: boolean;
  isDuplicate: boolean;
  isAsyncLocked: boolean;
  isMutationLocked: boolean;
  onSelect: (leadId: string, checked: boolean) => void;
  onOpenDetails: (lead: Lead) => void;
  onRequestDelete: (lead: Lead) => void;
  onStageChange: (lead: Lead, stage: Lead['stage']) => void;
  onNextActionChange: (lead: Lead, nextAction: NextAction) => void;
}

const LeadTableRow = React.memo(
  React.forwardRef<HTMLTableRowElement, LeadTableRowProps>(function LeadTableRow(
    {
      lead,
      dataIndex,
      visibleColumns,
      isSelected,
      isDuplicate,
      isAsyncLocked,
      isMutationLocked,
      onSelect,
      onOpenDetails,
      onRequestDelete,
      onStageChange,
      onNextActionChange,
    },
    ref,
  ) {
    const addedAt = lead.createdAt ? new Date(lead.createdAt) : null;
    const hasValidAddedAt = !!addedAt && !Number.isNaN(addedAt.getTime());
    const addedDate = hasValidAddedAt
      ? addedAt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Unknown';
    const addedTime = hasValidAddedAt
      ? addedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    const provenance = getLeadProvenance(lead);
    const stageMeta = getPipelineStageMeta(lead.stage);
    const scout = provenance.scout;
    const linkedInProfileUrl = lead.profile.contactDetails?.linkedinUrl;
    const linkedInSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      [lead.profile.fullName, lead.profile.currentCompany].filter(Boolean).join(' '),
    )}`;

    return (
      <TableRow
        ref={ref}
        data-index={dataIndex}
        className={`${isSelected ? 'bg-muted/50' : ''} ${
          isDuplicate ? 'border-l-2 border-l-warning bg-warning/5' : ''
        }`}
      >
      <TableCell className="text-center">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect(lead.id, checked === true)}
          disabled={isAsyncLocked || isMutationLocked}
          aria-label={isAsyncLocked
            ? `${lead.profile.fullName} is locked while enrichment is running`
            : `Select ${lead.profile.fullName}`}
        />
      </TableCell>
      {visibleColumns.has('contact') && (
        <TableCell className="font-bold">
          <div className="flex items-center gap-2">
            {isDuplicate && (
              <div title="Potential duplicate profile" className="text-warning">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Potential duplicate</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => onOpenDetails(lead)}
              className="rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lead.profile.fullName}
            </button>
            {lead.lastEnrichedAt && (
              <div
                title={`Enriched by AI on ${new Date(lead.lastEnrichedAt).toLocaleDateString()}`}
                className="text-primary"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">AI enriched</span>
              </div>
            )}
            <a
              href={linkedInProfileUrl || linkedInSearchUrl}
              target="_blank"
              rel="noreferrer"
              title={linkedInProfileUrl ? 'Open LinkedIn profile' : 'Find this person on LinkedIn'}
              aria-label={linkedInProfileUrl ? `Open ${lead.profile.fullName}'s LinkedIn profile` : `Find ${lead.profile.fullName} on LinkedIn`}
              className="rounded-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
          {provenance.matchedCriteria.length > 0 && (
            <div
              className="mt-1 flex flex-wrap gap-1"
              title={`Evidence sources: ${scout?.sourceProviders?.join(', ') || 'public web'}. ${provenance.uncertainties.join(' ')}`}
            >
              {provenance.matchedCriteria.slice(0, 2).map((reason: string) => (
                <Badge
                  key={reason}
                  variant="outline"
                  className="h-5 px-1.5 text-xs font-medium text-success border-success/25"
                >
                  {reason}
                </Badge>
              ))}
              {provenance.paretoSkyline && (
                <Badge variant="outline" className="h-5 px-1.5 text-xs font-semibold text-warning border-warning/30 bg-warning/10" title="Pareto Skyline: Non-dominated candidate across Authority, Intent, and Evidence Specificity">
                  Skyline
                </Badge>
              )}
              {Number(scout?.corroborationScore || 0) >= 7 && (
                <Badge variant="outline" className="h-5 px-1.5 text-xs text-primary border-primary/25">
                  corroborated
                </Badge>
              )}
              {provenance.postIntentEvidence && provenance.postIntentEvidence.quality === 'strong' && (
                <Badge
                  variant="outline"
                  className="h-5 px-1.5 text-xs font-semibold text-warning border-warning/40 bg-warning/10 flex items-center gap-1"
                  title={`Why Now: ${(provenance.postIntentEvidence.intentCategory || 'signal').replace('_', ' ')} (${Math.round((provenance.postIntentEvidence.confidenceScore || 0) * 100)}% confidence)${provenance.postIntentEvidence.llmReason ? ` - ${provenance.postIntentEvidence.llmReason}` : ''}`}
                >
                  <Flame className="h-3 w-3 text-warning" aria-hidden="true" />
                  {(provenance.postIntentEvidence.intentCategory || 'signal').replace('_', ' ')}
                </Badge>
              )}
              {provenance.postIntentEvidence && provenance.postIntentEvidence.quality === 'moderate' && (
                <Badge
                  variant="outline"
                  className="h-5 px-1.5 text-xs text-info border-info/30 bg-info/10 flex items-center gap-1"
                  title={`Why Now: ${(provenance.postIntentEvidence.intentCategory || 'signal').replace('_', ' ')} (${Math.round((provenance.postIntentEvidence.confidenceScore || 0) * 100)}% confidence)${provenance.postIntentEvidence.llmReason ? ` - ${provenance.postIntentEvidence.llmReason}` : ''}`}
                >
                  <Radio className="h-3 w-3 text-info" aria-hidden="true" />
                  {(provenance.postIntentEvidence.intentCategory || 'signal').replace('_', ' ')}
                </Badge>
              )}
            </div>
          )}
        </TableCell>
      )}
      {visibleColumns.has('title') && (
        <TableCell className="max-w-[200px] truncate text-muted-foreground" title={lead.profile.currentTitle}>
          {lead.profile.currentTitle || 'Professional'}
        </TableCell>
      )}
      {visibleColumns.has('company') && (
        <TableCell className="max-w-[190px] text-muted-foreground">
          <div className="truncate">{lead.profile.currentCompany || 'Independent'}</div>
          {(provenance.location || provenance.industry) && (
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {[provenance.location, provenance.industry].filter(Boolean).join(' - ')}
            </div>
          )}
          {Boolean(lead.companyAccount?.buyingSignals?.length) && (
            <div className="mt-1 truncate text-xs font-bold text-success">
              {lead.companyAccount!.buyingSignals.length} signals - Pain {lead.companyAccount!.operationalPainScore ?? 0}
            </div>
          )}
        </TableCell>
      )}
      {visibleColumns.has('stage') && (
        <TableCell className="min-w-[160px]">
          <Select
            value={lead.stage}
            onValueChange={(value) => onStageChange(lead, value as Lead['stage'])}
            disabled={isAsyncLocked || isMutationLocked}
          >
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label={`Pipeline stage for ${lead.profile.fullName}`}>
              <SelectValue>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${stageMeta.dotClassName}`} />
                  {stageMeta.shortLabel}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PIPELINE_STAGES.map((stage) => (
                <SelectItem key={stage.id} value={stage.id}>{stage.shortLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
      )}
      {visibleColumns.has('nextAction') && (
        <TableCell className="min-w-[150px]">
          <Select
            value={getNextAction(lead)}
            onValueChange={(value) => onNextActionChange(lead, value as NextAction)}
            disabled={isAsyncLocked || isMutationLocked}
          >
            <SelectTrigger className="h-8 w-[150px] text-xs" aria-label={`Next action for ${lead.profile.fullName}`}>
              <SelectValue>{getNextActionLabel(getNextAction(lead))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {NEXT_ACTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
      )}
      {visibleColumns.has('signals') && (
        <TableCell className="max-w-[220px]">
          <div className="flex flex-col gap-1">
            {provenance.postIntentEvidence && provenance.postIntentEvidence.quality !== 'none' ? (
              <div className="flex items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={`h-5 px-1.5 text-xs font-semibold flex items-center gap-1 ${
                    provenance.postIntentEvidence.quality === 'strong'
                      ? 'text-warning border-warning/40 bg-warning/10'
                      : 'text-info border-info/30 bg-info/10'
                  }`}
                  title={`Why Now: ${(provenance.postIntentEvidence.intentCategory || 'signal').replace(/_/g, ' ')} (${Math.round((provenance.postIntentEvidence.confidenceScore || 0) * 100)}% confidence)${provenance.postIntentEvidence.llmReason ? ` - ${provenance.postIntentEvidence.llmReason}` : ''}`}
                >
                  {provenance.postIntentEvidence.quality === 'strong' ? (
                    <Flame className="h-3 w-3 text-warning" aria-hidden="true" />
                  ) : (
                    <Zap className="h-3 w-3 text-info" aria-hidden="true" />
                  )}
                  <span className="capitalize">{(provenance.postIntentEvidence.intentCategory || 'signal').replace(/_/g, ' ')}</span>
                </Badge>
              </div>
            ) : (() => {
              const hiringTrigger = lead.buyingSignalsDetected?.find(
                (s) => s.toLowerCase().includes("hiring") || s.toLowerCase().includes("job requisition")
              );
              if (hiringTrigger) {
                return (
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="h-5 px-1.5 text-xs text-warning border-warning/30 bg-warning/10 flex items-center gap-1 max-w-[210px] truncate"
                      title={hiringTrigger}
                    >
                      <Flame className="h-3 w-3 text-warning shrink-0" aria-hidden="true" />
                      <span className="truncate">{hiringTrigger}</span>
                    </Badge>
                  </div>
                );
              }
              if (lead.companyAccount?.buyingSignals?.length) {
                return (
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="h-5 px-1.5 text-xs text-success border-success/30 bg-success/10 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-success" aria-hidden="true" />
                      <span>{lead.companyAccount.buyingSignals.length} Signals (Pain {lead.companyAccount.operationalPainScore})</span>
                    </Badge>
                  </div>
                );
              }
              if (Array.isArray(lead.buyingSignalsDetected) && lead.buyingSignalsDetected.length > 0) {
                return (
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="h-5 px-1.5 text-xs text-success border-success/30 bg-success/10 flex items-center gap-1 max-w-[210px] truncate"
                      title={lead.buyingSignalsDetected[0]}
                    >
                      <Zap className="h-3 w-3 text-success shrink-0" aria-hidden="true" />
                      <span className="truncate">{lead.buyingSignalsDetected[0]}</span>
                    </Badge>
                  </div>
                );
              }
              return <span className="text-xs text-muted-foreground italic">No active intent trigger</span>;
            })()}
            {lead.companyAccount?.painSummary ? (
              <div className="text-xs text-muted-foreground truncate max-w-[210px]" title={lead.companyAccount.painSummary}>
                {lead.companyAccount.painSummary}
              </div>
            ) : lead.profile.contactDetails?.email ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground truncate max-w-[210px]" title={lead.profile.contactDetails.email}>
                <Mail className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />
                <span className="truncate">{lead.profile.contactDetails.email}</span>
              </div>
            ) : null}
          </div>
        </TableCell>
      )}
      {visibleColumns.has('authority') && (
        <TableCell className="max-w-[220px]">
          <button
            type="button"
            onClick={() => onOpenDetails(lead)}
            className="flex min-w-[140px] flex-col items-start gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
            aria-label={`View authority and match details for ${lead.profile.fullName}`}
          >
            {(lead.decisionMakerVerification?.titleMatched && !lead.decisionMakerVerification?.ignoredTitle) ? (
              <Badge variant="outline" className="h-5 px-1.5 text-xs font-semibold text-success border-success/40 bg-success/10 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3 text-success" aria-hidden="true" />
                <span>Verified Decision Maker</span>
              </Badge>
            ) : lead.decisionMakerVerification?.trajectoryScore !== undefined ? (
              <Badge variant="outline" className="h-5 px-1.5 text-xs text-primary border-primary/30 bg-primary/10 flex items-center gap-1">
                <UserCheck className="h-3 w-3 text-primary" aria-hidden="true" />
                <span>Authority {lead.decisionMakerVerification.trajectoryScore}/10</span>
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 px-1.5 text-xs text-muted-foreground border-input bg-muted/40">
                {lead.profile.currentTitle && /\b(founder|co-founder|owner|ceo|cto|cmo|cpo|cro|president|partner|vp|director|head)\b/i.test(lead.profile.currentTitle)
                  ? 'Key Decision Maker'
                  : 'Target Match'}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground truncate max-w-[210px]" title={lead.decisionMakerVerification?.reason || lead.evidenceReasons?.[0] || lead.notes || 'Click to view qualification and provenance'}>
              {lead.decisionMakerVerification?.reason || lead.evidenceReasons?.[0] || (lead.notes ? lead.notes.replace(/^LinkedIn-indexed lead with account context\.\s*/, '') : 'View full match details')}
            </span>
          </button>
        </TableCell>
      )}
      {visibleColumns.has('added') && (
        <TableCell className="whitespace-nowrap text-muted-foreground">
          <div className="text-xs font-medium text-foreground/80">{addedDate}</div>
          {addedTime && <div className="mt-0.5 text-xs text-muted-foreground">{addedTime}</div>}
        </TableCell>
      )}
      {visibleColumns.has('score') && (
        <TableCell className="text-center">
          {(lead.qualificationScore ?? lead.predictiveScore) ? (
            <div className="flex flex-col items-center gap-0.5">
              <Badge
                variant="outline"
                className="border-primary/30 text-primary"
                title={provenance.confidenceInterval
                  ? `95% Credible Interval: [${provenance.confidenceInterval.lower} - ${provenance.confidenceInterval.upper}] (uncertainty: +/-${provenance.confidenceInterval.uncertainty})`
                  : undefined}
              >
                {lead.qualificationScore ?? lead.predictiveScore}% Qualified
              </Badge>
              {provenance.confidenceInterval && (
                <span className="text-xs text-muted-foreground font-mono" title="95% Credible Interval bounds">
                  [{provenance.confidenceInterval.lower} - {provenance.confidenceInterval.upper}]
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">--</span>
          )}
        </TableCell>
      )}
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRequestDelete(lead)}
          disabled={isAsyncLocked || isMutationLocked}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={isAsyncLocked
            ? `Cannot delete ${lead.profile.fullName} while enrichment is running`
            : `Delete ${lead.profile.fullName}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  );
}));

function hasWhyNowSignal(lead: Lead): boolean {
  const evidence = getLeadProvenance(lead).postIntentEvidence;
  return Boolean(evidence && evidence.quality !== 'none');
}

function readTablePrefs() {
  try {
    return parseTablePrefs(window.localStorage.getItem(PROSPECT_TABLE_PREFS_KEY));
  } catch {
    return parseTablePrefs(null);
  }
}

function readSavedViews(): ProspectView[] {
  try {
    return parseStoredViews(window.localStorage.getItem(PROSPECT_VIEWS_STORAGE_KEY));
  } catch {
    return [];
  }
}

const DEFAULT_SORT_DIRECTION: Record<ProspectSortKey, ProspectSort['direction']> = {
  name: 'asc',
  company: 'asc',
  added: 'desc',
  score: 'desc',
};

export default function LeadTable({
  onAddManualLead,
  onOpenLead,
  preset,
}: {
  onAddManualLead: () => void;
  onOpenLead: (leadId: string) => void;
  preset?: ProspectPreset | null;
}) {
  const {
    leads,
    rehydrateLeads,
    handleUpdateLeadStage,
    handleUpdateLeadsStage,
    handleDeleteLead,
    handleDeleteLeads,
    handleUpdateLeadFields,
    handleUpdateLeadsFields,
    handleUpdateLeadProfile,
    handleBulkLeadsAdded,
    handleMergeLead,
    handleServerMergeLead,
  } = useLeads();

  useEffect(() => {
    void rehydrateLeads(true);
  }, [rehydrateLeads]);
  const { triggerToast } = useToast();
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set());
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [filters, setFilters] = useState<ProspectFilters>(EMPTY_PROSPECT_FILTERS);
  const {
    search: tableSearch,
    stage: stageFilter,
    review: reviewFilter,
    nextAction: nextActionFilter,
    location: locationFilter,
    industry: industryFilter,
    signal: signalFilter,
  } = filters;
  const updateFilters = useCallback((updates: Partial<ProspectFilters>) => {
    setFilters((previous) => ({ ...previous, ...updates }));
    setActiveViewId(null);
  }, []);
  const [sort, setSort] = useState<ProspectSort | null>(null);
  const [density, setDensity] = useState<ProspectDensity>(() => readTablePrefs().density);
  const [hiddenColumns, setHiddenColumns] = useState<ProspectColumnId[]>(() => readTablePrefs().hiddenColumns);
  const [views, setViews] = useState<ProspectView[]>(() => readSavedViews());
  const [currentPage, setCurrentPage] = useState(1);
  const handleOpenDetails = useCallback((selectedLead: Lead) => {
    onOpenLead(selectedLead.id);
  }, [onOpenLead]);

  const [showConfirmBulkDelete, setShowConfirmBulkDelete] = useState(false);
  const [showConfirmPurgeDuplicates, setShowConfirmPurgeDuplicates] = useState(false);
  const [duplicateIdsToDelete, setDuplicateIdsToDelete] = useState<string[]>([]);
  const [duplicatePairsToMerge, setDuplicatePairsToMerge] = useState<Array<{ winnerId: string; duplicateId: string }>>([]);
  const [leadPendingDelete, setLeadPendingDelete] = useState<Lead | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [bulkMutation, setBulkMutation] = useState<'stage' | 'workflow' | 'delete' | 'purge' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  const [enrichmentQueue, setEnrichmentQueue] = useState<Lead[]>([]);
  const [enrichmentStep, setEnrichmentStep] = useState<string>('');
  const selectedLeadIdArray = useMemo(() => Array.from(selectedLeadIds), [selectedLeadIds]);
  const asyncLockedLeadIds = useMemo(() => {
    const lockedIds = new Set<string>();
    enrichmentQueue.forEach((lead) => lockedIds.add(lead.id));
    return lockedIds;
  }, [enrichmentQueue]);
  const selectedHasAsyncLockedLead = useMemo(
    () => selectedLeadIdArray.some((leadId) => asyncLockedLeadIds.has(leadId)),
    [asyncLockedLeadIds, selectedLeadIdArray],
  );
  const isBulkMutating = bulkMutation !== null;

  // Let the shared lead drawer see which prospects enrichment is currently touching.
  useEffect(() => {
    setLockedLeadIds(asyncLockedLeadIds);
  }, [asyncLockedLeadIds]);
  useEffect(() => () => setLockedLeadIds([]), []);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (enrichmentQueue.length === 0) {
      setEnrichmentStep('');
      return;
    }

    let isCancelled = false;
    const controller = new AbortController();
    const item = enrichmentQueue[0];

    const processItem = async () => {
      setEnrichmentStep(`Verifying ${item.profile.fullName} against the profile cache and public profile evidence...`);
      try {
        const response = await fetch(`/api/leads/${item.id}/enrich-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: controller.signal,
        });

        if (isCancelled || !isMountedRef.current) return;

        if (response.ok) {
          const data = await response.json();
          if (isCancelled || !isMountedRef.current) return;
          if (data.lead && handleMergeLead) {
            handleMergeLead(data.lead);
            const outcome = data.profileEnrichment?.status || 'completed';
            const didEnrich = outcome === 'scraped' || outcome === 'cache_hit' || outcome === 'completed';
            const updatedFields = Array.isArray(data.profileEnrichment?.updatedFields)
              ? data.profileEnrichment.updatedFields.filter((field: unknown) => typeof field === 'string')
              : [];
            const fieldSummary = updatedFields.length > 0 ? ` Updated: ${updatedFields.join(', ')}.` : '';
            triggerToast(
              `Profile verification ${outcome.replace(/_/g, ' ')} for ${item.profile.fullName}.${fieldSummary}`,
              didEnrich ? 'success' : 'info',
            );
          } else if (data.lead && handleUpdateLeadProfile) {
            handleUpdateLeadProfile(item.id, data.lead.profile);
            triggerToast(`Successfully verified & enriched record for ${item.profile.fullName}.`, 'success');
          } else {
            triggerToast(`Enrichment returned no updated record for ${item.profile.fullName}.`, 'error');
          }
        } else {
          const errData = await response.json().catch(() => ({}));
          if (isCancelled || !isMountedRef.current) return;
          if (errData.lead && handleMergeLead) handleMergeLead(errData.lead);
          console.warn(`Enrichment failed for ${item.profile.fullName}:`, errData.error || response.statusText);
          triggerToast(`Failed to enrich ${item.profile.fullName}: ${errData.error || 'Server error'}`, 'error');
        }
      } catch (err: any) {
        if (!isCancelled && isMountedRef.current && err?.name !== 'AbortError') {
          console.error(`Error enriching ${item.profile.fullName}:`, err);
          triggerToast(`Error enriching ${item.profile.fullName}`, 'error');
        }
      } finally {
        if (!isCancelled && isMountedRef.current) {
          setEnrichmentQueue(prev => prev.slice(1));
        }
      }
    };

    processItem();

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [enrichmentQueue, handleMergeLead, handleUpdateLeadProfile, triggerToast]);

  const normalizedSearch = useMemo(
    () => tableSearch.trim().toLocaleLowerCase(),
    [tableSearch],
  );
  const deferredSearch = useDeferredValue(normalizedSearch);
  const locationOptions = useMemo(
    () => Array.from(new Set(leads.map(lead => lead.profile?.location).filter(Boolean) as string[])).sort(),
    [leads],
  );
  const industryOptions = useMemo(
    () => Array.from(new Set(leads.map(lead => lead.profile?.industry).filter(Boolean) as string[])).sort(),
    [leads],
  );
  const searchableLeads = useMemo(
    () => leads.map((lead) => {
      const provenance = getLeadProvenance(lead);
      return {
        lead,
        searchText: [
          lead.profile?.fullName,
          lead.profile?.currentTitle,
          lead.profile?.currentCompany,
          provenance.location,
          provenance.industry,
          provenance.discoveryQuery,
          ...provenance.matchedCriteria,
          ...provenance.uncertainties,
        ]
          .filter(Boolean)
          .join('\u0000')
          .toLocaleLowerCase(),
      };
    }),
    [leads],
  );
  const unsortedFilteredLeads = useMemo(
    () => searchableLeads
      .filter(({ lead, searchText }) => (
        (stageFilter === 'All' || lead.stage === stageFilter)
        && (reviewFilter === 'All' || getReviewStatus(lead) === reviewFilter)
        && (nextActionFilter === 'All' || getNextAction(lead) === nextActionFilter)
        && (locationFilter === 'All' || lead.profile?.location === locationFilter)
        && (industryFilter === 'All' || lead.profile?.industry === industryFilter)
        && (signalFilter === 'All' || hasWhyNowSignal(lead))
        && (!deferredSearch || searchText.includes(deferredSearch))
      ))
      .map(({ lead }) => lead),
    [deferredSearch, industryFilter, locationFilter, nextActionFilter, reviewFilter, searchableLeads, signalFilter, stageFilter],
  );
  const filteredLeads = useMemo(() => sortLeads(unsortedFilteredLeads, sort), [unsortedFilteredLeads, sort]);

  // Consolidated single-pass duplicate analysis on all leads using authoritative dedupe keys
  const duplicateAnalysis = useMemo(() => {
    const duplicateIdSet = new Set<string>();
    const redundantIdsToDelete: string[] = [];
    const duplicatePairs: Array<{ winnerId: string; duplicateId: string }> = [];
    const seenKeyToId = new Map<string, string>();

    for (const lead of leads) {
      const keys = buildProfileDedupeKeys(lead);
      let isRedundant = false;
      let matchedFirstId: string | undefined;

      for (const key of keys) {
        if (seenKeyToId.has(key)) {
          isRedundant = true;
          matchedFirstId = seenKeyToId.get(key);
          break;
        }
      }

      if (isRedundant) {
        if (matchedFirstId) {
          duplicateIdSet.add(matchedFirstId);
          duplicatePairs.push({ winnerId: matchedFirstId, duplicateId: lead.id });
        }
        duplicateIdSet.add(lead.id);
        redundantIdsToDelete.push(lead.id);
      } else {
        for (const key of keys) {
          seenKeyToId.set(key, lead.id);
        }
      }
    }

    return {
      duplicateIdSet,
      redundantIdsToDelete,
      duplicatePairs,
    };
  }, [leads]);

  const duplicateIds = duplicateAnalysis.duplicateIdSet;

  const handleTriggerPurgeDuplicates = () => {
    const toDelete = duplicateAnalysis.redundantIdsToDelete;

    if (toDelete.length > 0) {
      const lockedDuplicateCount = toDelete.reduce(
        (count, leadId) => count + (asyncLockedLeadIds.has(leadId) ? 1 : 0),
        0,
      );
      if (lockedDuplicateCount > 0) {
        triggerToast(
          `Wait for enrichment to finish before merging ${lockedDuplicateCount} locked duplicate record${lockedDuplicateCount === 1 ? '' : 's'}.`,
          'info',
        );
        return;
      }
      setDuplicateIdsToDelete(toDelete);
      setDuplicatePairsToMerge(duplicateAnalysis.duplicatePairs);
      setShowConfirmPurgeDuplicates(true);
    } else {
      triggerToast('No redundant duplicates found.', 'info');
    }
  };

  const handleExecutePurgeDuplicates = async () => {
    if (duplicateIdsToDelete.length === 0 || isBulkMutating) return;
    const targetIds = [...duplicateIdsToDelete];
    if (targetIds.some((leadId) => asyncLockedLeadIds.has(leadId))) {
      triggerToast('Wait for active enrichment before merging these duplicates.', 'info');
      return;
    }
    setBulkMutation('purge');
    try {
      if (handleServerMergeLead && duplicatePairsToMerge.length > 0) {
        for (const pair of duplicatePairsToMerge) {
          await handleServerMergeLead(pair.winnerId, pair.duplicateId);
        }
        if (!isMountedRef.current) return;
        triggerToast(`Successfully consolidated ${duplicatePairsToMerge.length} duplicate leads. Notes and history preserved.`, 'success');
      } else if (handleDeleteLeads) {
        await handleDeleteLeads(targetIds);
        if (!isMountedRef.current) return;
        triggerToast(`Successfully cleaned up ${targetIds.length} duplicate leads.`, 'success');
      } else {
        await Promise.all(targetIds.map((id) => handleDeleteLead(id)));
      }
      setDuplicateIdsToDelete([]);
      setDuplicatePairsToMerge([]);
      setShowConfirmPurgeDuplicates(false);
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not merge duplicate leads.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / PROSPECTS_PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const currentPageStartIndex = (activePage - 1) * PROSPECTS_PAGE_SIZE;
  const paginatedLeads = useMemo(
    () => filteredLeads.slice(currentPageStartIndex, currentPageStartIndex + PROSPECTS_PAGE_SIZE),
    [currentPageStartIndex, filteredLeads],
  );
  const visibleLeadIds = useMemo(() => paginatedLeads.map((lead) => lead.id), [paginatedLeads]);
  const visibleLeadIdSet = useMemo(() => new Set(visibleLeadIds), [visibleLeadIds]);
  const selectableVisibleLeadIds = useMemo(
    () => visibleLeadIds.filter((leadId) => !asyncLockedLeadIds.has(leadId)),
    [asyncLockedLeadIds, visibleLeadIds],
  );
  const selectedVisibleCount = useMemo(
    () => selectableVisibleLeadIds.reduce((count, id) => count + (selectedLeadIds.has(id) ? 1 : 0), 0),
    [selectableVisibleLeadIds, selectedLeadIds],
  );
  const allVisibleSelected = selectableVisibleLeadIds.length > 0 && selectedVisibleCount === selectableVisibleLeadIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const pageStart = filteredLeads.length === 0 ? 0 : currentPageStartIndex + 1;
  const pageEnd = Math.min(currentPageStartIndex + paginatedLeads.length, filteredLeads.length);
  const leadIdSet = useMemo(() => new Set(leads.map((lead) => lead.id)), [leads]);

  const tableContainerRef = useRef<HTMLDivElement>(null);

  const columns = useMemo<ColumnDef<Lead>[]>(
    () => [
      {
        id: 'select',
        header: 'Select',
      },
      {
        accessorKey: 'profile.fullName',
        header: 'Contact Profile Name',
      },
      {
        accessorKey: 'profile.currentTitle',
        header: 'Primary Title',
      },
      {
        accessorKey: 'profile.currentCompany',
        header: 'Employer / Company Name',
      },
      {
        id: 'buyingSignals',
        header: 'Buying Signals & Intent',
      },
      {
        id: 'authority',
        header: 'Authority & Match Reason',
      },
      {
        accessorKey: 'createdAt',
        header: 'Added',
      },
      {
        id: 'qualificationScore',
        header: 'Qualification Score',
      },
      {
        id: 'actions',
        header: 'Delete',
      },
    ],
    [],
  );

  const table = useReactTable({
    data: paginatedLeads,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const { rows } = table.getRowModel();


  React.useEffect(() => {
    setCurrentPage(1);
  }, [industryFilter, locationFilter, nextActionFilter, normalizedSearch, reviewFilter, signalFilter, sort, stageFilter]);

  React.useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages));
  }, [totalPages]);

  React.useEffect(() => {
    setSelectedLeadIds((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(Array.from(previous).filter((id) => leadIdSet.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [leadIdSet]);

  const handleSelectAll = useCallback((checked: boolean) => {
    setSelectedLeadIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        selectableVisibleLeadIds.forEach((id) => next.add(id));
      } else {
        previous.forEach((id) => {
          if (visibleLeadIdSet.has(id)) next.delete(id);
        });
      }
      return next;
    });
  }, [selectableVisibleLeadIds, visibleLeadIdSet]);

  const handleSelectRow = useCallback((leadId: string, checked: boolean) => {
    setSelectedLeadIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(leadId);
      else next.delete(leadId);
      return next;
    });
  }, []);

  const handleSelectDuplicates = () => {
    const toSelect = duplicateAnalysis.redundantIdsToDelete;

    if (toSelect.length > 0) {
      setSelectedLeadIds(new Set(toSelect));
      triggerToast(`Selected ${toSelect.length} redundant duplicate leads.`, 'info');
    } else {
      triggerToast('No redundant duplicates found.', 'info');
    }
  };

  const handleBulkStageChange = async (stage: Lead['stage']) => {
    if (selectedLeadIdArray.length === 0 || isBulkMutating) return;
    const targetIds = [...selectedLeadIdArray];
    if (targetIds.some((leadId) => asyncLockedLeadIds.has(leadId))) {
      triggerToast('Wait for active enrichment before changing these stages.', 'info');
      return;
    }
    const previousStages = leads
      .filter((lead) => targetIds.includes(lead.id))
      .map((lead) => ({ id: lead.id, stage: lead.stage }));
    setBulkMutation('stage');
    try {
      let updatedCount = targetIds.length;
      let removedCount = 0;
      let rebasedCount = 0;
      if (handleUpdateLeadsStage) {
        const result = await handleUpdateLeadsStage(targetIds, stage);
        updatedCount = result.updatedCount;
        removedCount = result.removedCount;
        rebasedCount = result.rebasedCount || 0;
      } else {
        await Promise.all(targetIds.map((id) => Promise.resolve(handleUpdateLeadStage(id, stage))));
      }
      if (!isMountedRef.current) return;
      const details: string[] = [];
      if (rebasedCount > 0) details.push(`${rebasedCount} rebased over server changes`);
      if (removedCount > 0) details.push(`${removedCount} archived remotely`);
      const detailMsg = details.length > 0 ? ` (${details.join(', ')})` : '';

      triggerToast(
        updatedCount > 0
          ? `Updated ${updatedCount} lead stage${updatedCount === 1 ? '' : 's'} to ${getPipelineStageMeta(stage).shortLabel}.${detailMsg}`
          : `No stages were changed.${detailMsg}`,
        updatedCount > 0 ? 'success' : 'info',
        updatedCount > 0 ? { action: { label: 'Undo', onClick: () => undoBulkStage(previousStages) } } : undefined,
      );
      setSelectedLeadIds(new Set());
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not update stages.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  const handleBulkWorkflowChange = async (
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    if (selectedLeadIdArray.length === 0 || isBulkMutating) return;
    const targetIds = [...selectedLeadIdArray];
    if (targetIds.some(leadId => asyncLockedLeadIds.has(leadId))) {
      triggerToast('Wait for active enrichment before changing workflow fields.', 'info');
      return;
    }
    const previousWorkflow = leads
      .filter((lead) => targetIds.includes(lead.id))
      .map((lead) => ({ id: lead.id, reviewStatus: getReviewStatus(lead), nextAction: getNextAction(lead) }));
    setBulkMutation('workflow');
    try {
      await handleUpdateLeadsFields(targetIds, updates);
      if (!isMountedRef.current) return;
      triggerToast(
        `Updated workflow for ${targetIds.length} prospect${targetIds.length === 1 ? '' : 's'}.`,
        'success',
        { action: { label: 'Undo', onClick: () => undoBulkWorkflow(previousWorkflow, updates) } },
      );
      setSelectedLeadIds(new Set());
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not update prospect workflow.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  const undoBulkStage = useCallback((previous: Array<{ id: string; stage: Lead['stage'] }>) => {
    const groups = new Map<Lead['stage'], string[]>();
    for (const item of previous) groups.set(item.stage, [...(groups.get(item.stage) ?? []), item.id]);
    void Promise.all(Array.from(groups, ([stage, ids]) => handleUpdateLeadsStage(ids, stage)))
      .then(() => triggerToast('Stage changes undone.', 'info'))
      .catch(() => triggerToast('Could not undo the stage changes.', 'error'));
  }, [handleUpdateLeadsStage, triggerToast]);

  const undoBulkWorkflow = useCallback((
    previous: Array<{ id: string; reviewStatus: ReviewStatus; nextAction: NextAction }>,
    applied: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    const groups = new Map<string, { ids: string[]; updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction } }>();
    for (const item of previous) {
      const updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction } = {};
      if (applied.reviewStatus !== undefined) updates.reviewStatus = item.reviewStatus;
      if (applied.nextAction !== undefined) updates.nextAction = item.nextAction;
      const key = JSON.stringify(updates);
      const group = groups.get(key) ?? { ids: [], updates };
      group.ids.push(item.id);
      groups.set(key, group);
    }
    void Promise.all(Array.from(groups.values(), (group) => handleUpdateLeadsFields(group.ids, group.updates)))
      .then(() => triggerToast('Workflow changes undone.', 'info'))
      .catch(() => triggerToast('Could not undo the workflow changes.', 'error'));
  }, [handleUpdateLeadsFields, triggerToast]);

  const handleInlineStageChange = useCallback(async (lead: Lead, stage: Lead['stage']) => {
    if (lead.stage === stage) return;
    if (asyncLockedLeadIds.has(lead.id) || isBulkMutating) {
      triggerToast(`Wait for the current update to finish before changing ${lead.profile.fullName}.`, 'info');
      return;
    }
    const previousStage = lead.stage;
    try {
      await handleUpdateLeadStage(lead.id, stage);
      if (!isMountedRef.current) return;
      triggerToast(`Moved ${lead.profile.fullName} to ${getPipelineStageMeta(stage).shortLabel}.`, 'success', {
        action: {
          label: 'Undo',
          onClick: () => {
            void Promise.resolve(handleUpdateLeadStage(lead.id, previousStage)).catch(() => {
              triggerToast('Could not undo the stage change.', 'error');
            });
          },
        },
      });
    } catch (error) {
      if (isMountedRef.current) {
        triggerToast(error instanceof Error ? error.message : 'The pipeline stage could not be saved.', 'error');
      }
    }
  }, [asyncLockedLeadIds, handleUpdateLeadStage, isBulkMutating, triggerToast]);

  const handleInlineNextActionChange = useCallback(async (lead: Lead, nextAction: NextAction) => {
    const previousAction = getNextAction(lead);
    if (previousAction === nextAction) return;
    if (asyncLockedLeadIds.has(lead.id) || isBulkMutating) {
      triggerToast(`Wait for the current update to finish before changing ${lead.profile.fullName}.`, 'info');
      return;
    }
    try {
      await handleUpdateLeadFields(lead.id, { nextAction });
      if (!isMountedRef.current) return;
      triggerToast(`Next action for ${lead.profile.fullName}: ${getNextActionLabel(nextAction)}.`, 'success', {
        action: {
          label: 'Undo',
          onClick: () => {
            void Promise.resolve(handleUpdateLeadFields(lead.id, { nextAction: previousAction })).catch(() => {
              triggerToast('Could not undo the next action change.', 'error');
            });
          },
        },
      });
    } catch (error) {
      if (isMountedRef.current) {
        triggerToast(error instanceof Error ? error.message : 'Could not save the next action.', 'error');
      }
    }
  }, [asyncLockedLeadIds, handleUpdateLeadFields, isBulkMutating, triggerToast]);

  // ----- Table preferences, sorting and saved views ---------------------------------------
  useEffect(() => {
    try {
      window.localStorage.setItem(PROSPECT_TABLE_PREFS_KEY, serializeTablePrefs({ density, hiddenColumns }));
    } catch {
      // Preferences are a convenience; the table still works without storage.
    }
  }, [density, hiddenColumns]);

  const visibleColumns = useMemo(
    () => new Set<ProspectColumnId>(PROSPECT_COLUMNS.filter((column) => !hiddenColumns.includes(column.id)).map((column) => column.id)),
    [hiddenColumns],
  );

  const handleToggleColumn = (columnId: ProspectColumnId, show: boolean) => {
    setHiddenColumns((previous) => (show ? previous.filter((id) => id !== columnId) : [...previous, columnId]));
    setActiveViewId(null);
  };

  const handleDensityChange = (next: ProspectDensity) => {
    setDensity(next);
    setActiveViewId(null);
  };

  const handleSortChange = (key: ProspectSortKey) => {
    setSort((previous) => {
      const defaultDirection = DEFAULT_SORT_DIRECTION[key];
      if (!previous || previous.key !== key) return { key, direction: defaultDirection };
      if (previous.direction === defaultDirection) return { key, direction: defaultDirection === 'asc' ? 'desc' : 'asc' };
      return null;
    });
    setActiveViewId(null);
  };

  const persistViews = useCallback((next: ProspectView[]) => {
    setViews(next);
    try {
      window.localStorage.setItem(PROSPECT_VIEWS_STORAGE_KEY, serializeViews(next));
    } catch {
      triggerToast('This view could not be saved in the browser, so it will be lost on reload.', 'info');
    }
  }, [triggerToast]);

  const handleSaveView = (name: string) => {
    const view: ProspectView = { id: createViewId(), name, filters, sort, density, hiddenColumns };
    persistViews([...views, view]);
    setActiveViewId(view.id);
    triggerToast(`Saved view "${name}".`, 'success');
  };

  const handleApplyView = (view: ProspectView) => {
    setFilters(view.filters);
    setSort(view.sort);
    setDensity(view.density);
    setHiddenColumns(view.hiddenColumns);
    setActiveViewId(view.id);
    setCurrentPage(1);
  };

  const handleDeleteView = (viewId: string) => {
    persistViews(views.filter((view) => view.id !== viewId));
    if (activeViewId === viewId) setActiveViewId(null);
  };

  useEffect(() => {
    if (!preset) return;
    setFilters({ ...EMPTY_PROSPECT_FILTERS, ...preset.filters });
    setActiveViewId(null);
    setCurrentPage(1);
  }, [preset]);

  const renderSortableHead = (key: ProspectSortKey, label: string, className?: string) => {
    const isActive = sort?.key === key;
    const SortIcon = !isActive ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
    return (
      <TableHead
        className={className}
        aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => handleSortChange(key)}
          className="-ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
          <SortIcon aria-hidden="true" className={`h-3.5 w-3.5 ${isActive ? 'text-primary' : 'opacity-60'}`} />
        </button>
      </TableHead>
    );
  };

  const handleStartEnrichment = () => {
    if (selectedLeadIds.size === 0) {
      triggerToast('Please select one or more leads using the checkboxes first.', 'info');
      return;
    }
    if (isBulkMutating) return;
    if (enrichmentQueue.length > 0) {
      triggerToast('The current enrichment queue must finish before another batch can start.', 'info');
      return;
    }
    if (selectedHasAsyncLockedLead) {
      triggerToast('One or more selected leads already have enrichment in progress.', 'info');
      return;
    }
    
    const targetLeads = leads.filter(l => selectedLeadIds.has(l.id));
      
    if (targetLeads.length === 0) {
      triggerToast('No valid leads selected.', 'info');
      return;
    }
    
    setEnrichmentQueue(targetLeads);
    setSelectedLeadIds(new Set());
    triggerToast(`Queued ${targetLeads.length} lead(s) for cache-first profile verification.`, 'info');
  };

  const handleBulkDeleteAction = async () => {
    if (selectedLeadIdArray.length === 0 || isBulkMutating) return;
    const targetIds = [...selectedLeadIdArray];
    if (targetIds.some((leadId) => asyncLockedLeadIds.has(leadId))) {
      triggerToast('Wait for active enrichment before deleting these leads.', 'info');
      return;
    }
    setBulkMutation('delete');
    try {
      if (handleDeleteLeads) {
        await handleDeleteLeads(targetIds);
      } else {
        await Promise.all(targetIds.map((id) => handleDeleteLead(id)));
      }
      if (!isMountedRef.current) return;
      triggerToast(`Successfully purged ${targetIds.length} leads.`, 'success');
      setSelectedLeadIds(new Set());
      setShowConfirmBulkDelete(false);
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not delete leads.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  const handleBulkDelete = () => {
    if (selectedLeadIds.size === 0 || isBulkMutating) return;
    if (selectedHasAsyncLockedLead) {
      triggerToast('Wait for active enrichment before deleting these leads.', 'info');
      return;
    }
    setShowConfirmBulkDelete(true);
  };

  const handleRequestDeleteLead = useCallback((lead: Lead) => {
    if (asyncLockedLeadIds.has(lead.id) || isBulkMutating) {
      triggerToast(`Wait for enrichment to finish before deleting ${lead.profile.fullName}.`, 'info');
      return;
    }
    setLeadPendingDelete(lead);
  }, [asyncLockedLeadIds, isBulkMutating, triggerToast]);

  const handleSingleDeleteAction = async () => {
    if (!leadPendingDelete || isBulkMutating) return;
    const leadToDelete = leadPendingDelete;
    if (asyncLockedLeadIds.has(leadToDelete.id)) {
      triggerToast(`Wait for enrichment to finish before deleting ${leadToDelete.profile.fullName}.`, 'info');
      return;
    }
    setBulkMutation('delete');
    try {
      await Promise.resolve(handleDeleteLead(leadToDelete.id));
      if (!isMountedRef.current) return;
      setSelectedLeadIds((previous) => {
        if (!previous.has(leadToDelete.id)) return previous;
        const next = new Set(previous);
        next.delete(leadToDelete.id);
        return next;
      });
      setLeadPendingDelete(null);
      triggerToast(`Deleted ${leadToDelete.profile.fullName}.`, 'success');
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || `Could not delete ${leadToDelete.profile.fullName}.`, 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  // Compile and format CSV string
  const handleCsvExport = (exportAll: boolean) => {
    const targets = exportAll ? leads : leads.filter(l => selectedLeadIds.has(l.id));
    
    if (targets.length === 0) {
      triggerToast('No leads selected. Check row checkboxes to enable export.', 'info');
      return;
    }

    // Define CSV Headings
    const headings = [
      'ID',
      'First Name',
      'Last Name',
      'Full Name',
      'Pipeline Stage',
      'Review Status',
      'Next Action',
      'Current Title',
      'Current Company',
      'Buying Signals & Intent',
      'Authority & Decision Maker',
      'Corporate Email',
      'Phone Number',
      'LinkedIn Profile URL',
      'Industry Segment',
      'Geographic Location',
      'Skills Keywords',
      'Biography Summary',
      'Discovery Query',
      'Matched Criteria',
      'Uncertainties',
      'Log Internal Notes',
      'Created Date'
    ];

    // Map each lead into a clean row array
    const csvRows = targets.map(lead => {
      const parts = lead.profile.fullName.trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const skillsStr = (lead.profile.skills || []).join('; ');
      const provenance = getLeadProvenance(lead);
      
      const row = [
        lead.id,
        firstName,
        lastName,
        lead.profile.fullName,
        lead.stage,
        getReviewStatus(lead),
        getNextAction(lead),
        lead.profile.currentTitle || '',
        lead.profile.currentCompany || '',
        provenance.postIntentEvidence?.intentCategory
          ? `${provenance.postIntentEvidence.intentCategory} (${provenance.postIntentEvidence.quality})`
          : (lead.companyAccount?.buyingSignals?.map(s => s.label).join('; ') || (lead.buyingSignalsDetected || []).join('; ')),
        (lead.decisionMakerVerification?.titleMatched && !lead.decisionMakerVerification?.ignoredTitle)
          ? `Verified Decision Maker (${lead.decisionMakerVerification.reason || ''})`
          : (lead.decisionMakerVerification?.trajectoryScore !== undefined ? `Authority ${lead.decisionMakerVerification.trajectoryScore}/10` : (lead.profile.currentTitle || '')),
        lead.profile.contactDetails?.email || '',
        lead.profile.contactDetails?.phone || '',
        lead.profile.contactDetails?.linkedinUrl || '',
        lead.profile.industry || 'Tech',
        lead.profile.location || '',
        skillsStr,
        lead.profile.summary || '',
        provenance.discoveryQuery,
        provenance.matchedCriteria.join('; '),
        provenance.uncertainties.join('; '),
        lead.notes || '',
        new Date(lead.createdAt).toLocaleDateString()
      ];

      // Escape quotes and double quotes for clean CSV syntax
      return row.map(v => {
        const value = String(v);
        const formulaSafeValue = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
        const escaped = formulaSafeValue.replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(',');
    });

    const csvContent = [headings.join(','), ...csvRows].join('\n');
    
    // Create Blob URL trigger download in browser safely
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `linkedin_crm_leads_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCsvImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          if (!isMountedRef.current) return;
          const rows = results.data as Record<string, string>[];
          
          const newProfiles = rows.flatMap((row, i): Lead[] => {
            // CSV header matching is shared and unit-tested in `src/utils/csvFieldMapping.ts`.
            // Fields resolve most-specific first, and a resolved field claims its header so a
            // generic alias can never steal a column another field owns.
            const getField = createCsvFieldReader(row);

            const fName = getField(CSV_FIELD_ALIASES.firstName);
            const lName = getField(CSV_FIELD_ALIASES.lastName);

            // Every other field is resolved BEFORE fullName so their headers are claimed;
            // only then is it safe for fullName to use the substring fallback.
            const company = getField(CSV_FIELD_ALIASES.company);
            const title = getField(CSV_FIELD_ALIASES.title);
            const email = getField(CSV_FIELD_ALIASES.email);
            const phone = getField(CSV_FIELD_ALIASES.phone);
            const linkedinUrl = getField(CSV_FIELD_ALIASES.linkedin);

            const industry = getField(CSV_FIELD_ALIASES.industry) || 'Tech';
            const location = getField(CSV_FIELD_ALIASES.location);
            const summary = getField(CSV_FIELD_ALIASES.summary);
            const skillsStr = getField(CSV_FIELD_ALIASES.skills);
            const skills = skillsStr ? skillsStr.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];
            const importedReviewStatus = getField(CSV_FIELD_ALIASES.reviewStatus).toUpperCase();
            const importedNextAction = getField(CSV_FIELD_ALIASES.nextAction).toUpperCase().replace(/\s+/g, '_');
            const rawStage = getField(CSV_FIELD_ALIASES.stage).trim().toUpperCase();
            const matchedStage = PIPELINE_STAGES.find(
              (s) => s.id === rawStage || s.label.toUpperCase() === rawStage || s.shortLabel.toUpperCase() === rawStage
            );
            const stage: Lead['stage'] = matchedStage ? matchedStage.id : 'SCRAPED';

            let fullName = getField(CSV_FIELD_ALIASES.fullName);
            if (!fullName && (fName || lName)) {
              fullName = `${fName} ${lName}`.trim();
            }
            if (!fullName) return [];
            const reviewStatus = REVIEW_STATUS_OPTIONS.some(option => option.value === importedReviewStatus)
              ? importedReviewStatus as ReviewStatus
              : 'UNREVIEWED';
            const nextAction = NEXT_ACTION_OPTIONS.some(option => option.value === importedNextAction)
              ? importedNextAction as NextAction
              : 'NONE';

            return [{
              id: `lead-imported-${crypto.randomUUID()}-${i}`,
              profile: {
                id: `profile-imported-${crypto.randomUUID()}-${i}`,
                fullName,
                headline: title ? `${title} @ ${company}` : 'Professional',
                currentCompany: company || 'Independent',
                currentTitle: title || 'Professional',
                location: location || 'Undisclosed Location',
                industry,
                summary: summary || 'Imported via bulk CSV upload.',
                contactDetails: {
                  email,
                  phone,
                  linkedinUrl
                },
                skills
              },
              stage,
              notes: summary || 'Imported via bulk CSV upload.',
              createdAt: new Date().toISOString(),
              tags: ['CSV Import', industry],
              reviewStatus,
              nextAction,
            }];
          });

          if (newProfiles.length === 0) {
            triggerToast('No valid named contacts found in the CSV. Nothing was imported.', 'info');
          } else {
            const unnamedRowCount = rows.length - newProfiles.length;
            const { addedCount, skippedCount: duplicateCount } = await handleBulkLeadsAdded(newProfiles);
            if (!isMountedRef.current) return;
            const skippedCount = unnamedRowCount + duplicateCount;
            const resultMessage = `Imported ${addedCount} contact${addedCount === 1 ? '' : 's'} and skipped ${skippedCount} row${skippedCount === 1 ? '' : 's'}${duplicateCount > 0 || unnamedRowCount > 0
              ? ` (${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'}, ${unnamedRowCount} unnamed)`
              : ''}.`;
            triggerToast(resultMessage, addedCount > 0 ? 'success' : 'info');
          }
        } catch (err) {
          console.error(err);
          if (isMountedRef.current) {
            triggerToast(err instanceof Error ? err.message : 'Failed to import this CSV.', 'error');
          }
        } finally {
          if (isMountedRef.current) setIsImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      },
      error: (error) => {
        if (isMountedRef.current) {
          setIsImporting(false);
          triggerToast(`CSV Import Error: ${error.message}`, 'error');
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    });
  };

  return (
    <>
      <Dialog open={showConfirmBulkDelete} onOpenChange={(open) => {
        if (!isBulkMutating) setShowConfirmBulkDelete(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedLeadIds.size} selected prospect{selectedLeadIds.size === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>This permanently removes the selected records and cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowConfirmBulkDelete(false)} disabled={isBulkMutating}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={handleBulkDeleteAction} disabled={isBulkMutating || selectedHasAsyncLockedLead}>
              {bulkMutation === 'delete' && <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {bulkMutation === 'delete' ? 'Deleting...' : 'Delete selected'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showConfirmPurgeDuplicates} onOpenChange={(open) => {
        if (!isBulkMutating) setShowConfirmPurgeDuplicates(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Consolidate {duplicateIdsToDelete.length} duplicate record{duplicateIdsToDelete.length === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              This safely unifies primary and duplicate contacts, preserving notes, tags, identities, and activity history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => {
              setShowConfirmPurgeDuplicates(false);
              setDuplicateIdsToDelete([]);
              setDuplicatePairsToMerge([]);
            }} disabled={isBulkMutating}>Cancel</Button>
            <Button type="button" onClick={handleExecutePurgeDuplicates} disabled={isBulkMutating || duplicateIdsToDelete.some((leadId) => asyncLockedLeadIds.has(leadId))}>
              {bulkMutation === 'purge' && <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {bulkMutation === 'purge' ? 'Consolidating...' : 'Consolidate duplicates'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(leadPendingDelete)} onOpenChange={(open) => {
        if (!open && !isBulkMutating) setLeadPendingDelete(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {leadPendingDelete?.profile.fullName ?? 'this prospect'}?</DialogTitle>
            <DialogDescription>This permanently removes the prospect from your CRM.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLeadPendingDelete(null)} disabled={isBulkMutating}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={handleSingleDeleteAction} disabled={isBulkMutating || Boolean(leadPendingDelete && asyncLockedLeadIds.has(leadPendingDelete.id))}>
              {bulkMutation === 'delete' && <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {bulkMutation === 'delete' ? 'Deleting...' : 'Delete prospect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="relative shadow-sm" aria-busy={isBulkMutating}>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground">All Contacts</span>
              <Badge variant="outline" className="text-xs">
                {filteredLeads.length} {filteredLeads.length === 1 ? 'record' : 'records'}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <SavedViewsMenu
                views={views}
                activeViewId={activeViewId}
                onApply={handleApplyView}
                onDelete={handleDeleteView}
                onSave={handleSaveView}
              />
              <Button type="button" size="sm" onClick={onAddManualLead}>
                <UserPlus2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Add prospect
              </Button>
              <input type="file" accept=".csv" ref={fileInputRef} onChange={handleCsvImport} className="sr-only" tabIndex={-1} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="More actions" title="More actions">
                    {isImporting
                      ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <Ellipsis className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Data</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => fileInputRef.current?.click()} disabled={isImporting}>
                    <UploadCloud aria-hidden="true" />
                    {isImporting ? 'Importing...' : 'Import CSV'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleCsvExport(true)} disabled={leads.length === 0}>
                    <FileDown aria-hidden="true" />
                    Export all
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Intelligence & hygiene</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={handleSelectDuplicates} disabled={leads.length === 0 || isBulkMutating}>
                    <Layers aria-hidden="true" />
                    Select duplicates
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleTriggerPurgeDuplicates}
                    disabled={leads.length === 0 || isBulkMutating}
                    className="text-primary focus:text-primary font-medium"
                  >
                    <Sparkles aria-hidden="true" />
                    Merge duplicates
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {selectedLeadIds.size > 0 && (
            <section className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/10 p-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between" aria-label="Selected prospect actions">
              <div className="flex items-center gap-2">
                <Badge>{selectedLeadIds.size}</Badge>
                <span className="text-sm font-semibold text-foreground">selected</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="bulk-stage" className="sr-only">Move selected prospects to stage</label>
                <Select
                  value=""
                  onValueChange={(value) => void handleBulkStageChange(value as Lead['stage'])}
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                >
                  <SelectTrigger id="bulk-stage" className="h-9 w-[170px]"><SelectValue placeholder="Move to stage..." /></SelectTrigger>
                  <SelectContent>
                    {PIPELINE_STAGES.map((stage) => <SelectItem key={stage.id} value={stage.id}>{stage.shortLabel}</SelectItem>)}
                  </SelectContent>
                </Select>
                <label htmlFor="bulk-review" className="sr-only">Set review status for selected prospects</label>
                <Select
                  value=""
                  onValueChange={(value) => void handleBulkWorkflowChange({ reviewStatus: value as ReviewStatus })}
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                >
                  <SelectTrigger id="bulk-review" className="h-9 w-[150px]"><SelectValue placeholder="Set review..." /></SelectTrigger>
                  <SelectContent>
                    {REVIEW_STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <label htmlFor="bulk-next-action" className="sr-only">Set next action for selected prospects</label>
                <Select
                  value=""
                  onValueChange={(value) => void handleBulkWorkflowChange({ nextAction: value as NextAction })}
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                >
                  <SelectTrigger id="bulk-next-action" className="h-9 w-[170px]"><SelectValue placeholder="Set next action..." /></SelectTrigger>
                  <SelectContent>
                    {NEXT_ACTION_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="sm" onClick={handleStartEnrichment} disabled={enrichmentQueue.length > 0 || isBulkMutating || selectedHasAsyncLockedLead}>
                  {enrichmentQueue.length > 0 ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
                  {enrichmentQueue.length > 0 ? `Enriching ${enrichmentQueue.length}` : 'Enrich'}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => handleCsvExport(false)}>
                  <FileDown className="mr-2 h-4 w-4" aria-hidden="true" />
                  Export selected
                </Button>
                <Button type="button" variant="destructive" size="sm" onClick={handleBulkDelete} disabled={isBulkMutating || selectedHasAsyncLockedLead}>
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  Delete
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => setSelectedLeadIds(new Set())} disabled={isBulkMutating} aria-label="Clear selection">
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              {selectedHasAsyncLockedLead && (
                <p className="basis-full text-xs font-medium text-warning" role="status">
                  Workflow, stage, and delete actions unlock when active enrichment finishes.
                </p>
              )}
            </section>
          )}

          {enrichmentStep && (
            <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/10 px-4 py-3" role="status" aria-live="polite">
              <div className="flex items-center gap-3">
                <LoaderCircle className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
                <div className="flex flex-col">
                  <span className="text-sm font-bold text-primary">Enriching {enrichmentQueue.length} record{enrichmentQueue.length === 1 ? '' : 's'}...</span>
                  <span className="text-xs text-primary">{enrichmentStep}</span>
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-border/60 pt-4">
            <ProspectFilterBar
              filters={filters}
              onChange={updateFilters}
              locationOptions={locationOptions}
              industryOptions={industryOptions}
              resultCount={filteredLeads.length}
              totalCount={leads.length}
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <Columns3 aria-hidden="true" className="h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                {PROSPECT_COLUMNS.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={visibleColumns.has(column.id)}
                    disabled={column.required}
                    onCheckedChange={(checked) => handleToggleColumn(column.id, checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <Rows3 aria-hidden="true" className="h-4 w-4" />
                  Density
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Row density</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={density} onValueChange={(value) => handleDensityChange(value as ProspectDensity)}>
                  <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Real Table Grid container */}
          <div
            ref={tableContainerRef}
            className={`mb-4 overflow-hidden rounded-xl border bg-card ${density === 'compact' ? '[&_td]:py-1.5 [&_th]:h-10' : ''}`}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={(checked) => handleSelectAll(checked === true)}
                      disabled={isBulkMutating || selectableVisibleLeadIds.length === 0}
                      aria-label={`Select all ${selectableVisibleLeadIds.length} available prospects on this page`}
                    />
                  </TableHead>
                  {renderSortableHead('name', 'Contact', 'min-w-[180px]')}
                  {visibleColumns.has('title') && <TableHead className="min-w-[160px]">Title</TableHead>}
                  {visibleColumns.has('company') && renderSortableHead('company', 'Company', 'min-w-[160px]')}
                  {visibleColumns.has('stage') && <TableHead className="min-w-[160px]">Stage</TableHead>}
                  {visibleColumns.has('nextAction') && <TableHead className="min-w-[150px]">Next action</TableHead>}
                  {visibleColumns.has('signals') && <TableHead className="min-w-[200px]">Buying signals</TableHead>}
                  {visibleColumns.has('authority') && <TableHead className="min-w-[180px]">Authority and match</TableHead>}
                  {visibleColumns.has('added') && renderSortableHead('added', 'Added', 'min-w-[110px]')}
                  {visibleColumns.has('score') && renderSortableHead('score', 'Match score', 'w-[140px]')}
                  <TableHead className="w-[80px] text-right"><span className="sr-only">Delete</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLeads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={visibleColumns.size + 2} className="py-12 text-center">
                      <p className="font-medium text-foreground">
                        {leads.length === 0 ? 'No prospects yet' : 'No prospects match these filters'}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {leads.length === 0
                          ? 'Add a prospect, import a CSV, or discover new people from the Discover tab.'
                          : 'Try removing a filter or searching for something broader.'}
                      </p>
                      {leads.length > 0 && (
                        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => updateFilters({ ...EMPTY_PROSPECT_FILTERS })}>
                          Clear all filters
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, index) => {
                    const lead = row.original;
                    return (
                      <LeadTableRow
                        key={lead.id}
                        lead={lead}
                        dataIndex={currentPageStartIndex + index}
                        visibleColumns={visibleColumns}
                        isSelected={selectedLeadIds.has(lead.id)}
                        isDuplicate={duplicateIds.has(lead.id)}
                        isAsyncLocked={asyncLockedLeadIds.has(lead.id)}
                        isMutationLocked={isBulkMutating}
                        onSelect={handleSelectRow}
                        onOpenDetails={handleOpenDetails}
                        onRequestDelete={handleRequestDeleteLead}
                        onStageChange={handleInlineStageChange}
                        onNextActionChange={handleInlineNextActionChange}
                      />
                    );
                  })
                )}
              </TableBody>
            </Table>
            {filteredLeads.length > PROSPECTS_PAGE_SIZE && (
              <div className="flex flex-col gap-3 border-t bg-background/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs font-medium text-muted-foreground">
                  Showing <span className="text-foreground">{pageStart}-{pageEnd}</span> of <span className="text-foreground">{filteredLeads.length}</span> matching prospects
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={activePage === 1}
                    className="h-8 px-2"
                    title="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only">Previous page</span>
                  </Button>
                  <span className="min-w-24 text-center text-xs font-bold text-foreground/80">
                    Page {activePage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={activePage === totalPages}
                    className="h-8 px-2"
                    title="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                    <span className="sr-only">Next page</span>
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

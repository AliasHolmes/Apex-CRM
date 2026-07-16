/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { useLeads } from '../context/LeadContext';
import Papa from 'papaparse';
import { 
  FileDown, 
  Trash2, 
  Layers, 
  Mail, 
  Link2,
  Search, 
  Sparkles, 
  UserPlus2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  X,
  UploadCloud,
  Loader2
} from 'lucide-react';
import { Lead, NextAction, ReviewStatus } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PIPELINE_STAGES, getPipelineStageMeta } from '@/lib/pipeline';
import { PROSPECTS_PAGE_SIZE } from '@/lib/ui';
import {
  getLeadProvenance,
  getNextAction,
  getNextActionLabel,
  getReviewStatus,
  getReviewStatusLabel,
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '@/lib/prospectWorkflow';

interface LeadTableRowProps {
  lead: Lead;
  isSelected: boolean;
  isDuplicate: boolean;
  isAsyncLocked: boolean;
  isMutationLocked: boolean;
  onSelect: (leadId: string, checked: boolean) => void;
  onOpenDetails: (lead: Lead) => void;
  onRequestDelete: (lead: Lead) => void;
}

const LeadTableRow = React.memo(function LeadTableRow({
  lead,
  isSelected,
  isDuplicate,
  isAsyncLocked,
  isMutationLocked,
  onSelect,
  onOpenDetails,
  onRequestDelete,
}: LeadTableRowProps) {
  const addedAt = lead.createdAt ? new Date(lead.createdAt) : null;
  const hasValidAddedAt = !!addedAt && !Number.isNaN(addedAt.getTime());
  const addedDate = hasValidAddedAt
    ? addedAt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Unknown';
  const addedTime = hasValidAddedAt
    ? addedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const stageMeta = getPipelineStageMeta(lead.stage);
  const provenance = getLeadProvenance(lead);
  const scout = provenance.scout;
  const linkedInProfileUrl = lead.profile.contactDetails?.linkedinUrl;
  const linkedInSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
    [lead.profile.fullName, lead.profile.currentCompany].filter(Boolean).join(' '),
  )}`;

  return (
    <TableRow
      className={`${isSelected ? 'bg-muted/50' : ''} ${
        isDuplicate ? 'border-l-2 border-l-amber-500 bg-amber-500/5' : ''
      }`}
    >
      <TableCell className="text-center">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(event) => onSelect(lead.id, event.target.checked)}
          disabled={isAsyncLocked || isMutationLocked}
          className="h-4 w-4 cursor-pointer rounded disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={isAsyncLocked
            ? `${lead.profile.fullName} is locked while enrichment is running`
            : `Select ${lead.profile.fullName}`}
        />
      </TableCell>
      <TableCell className="font-bold">
        <div className="flex items-center gap-2">
          {isDuplicate && (
            <div title="Potential duplicate profile" className="text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
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
                className="h-5 px-1.5 text-xs font-medium text-emerald-400 border-emerald-500/25"
              >
                {reason}
              </Badge>
            ))}
            {Number(scout?.corroborationScore || 0) >= 7 && (
              <Badge variant="outline" className="h-5 px-1.5 text-xs text-indigo-300 border-indigo-500/25">
                corroborated
              </Badge>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="max-w-[200px] truncate text-muted-foreground" title={lead.profile.currentTitle}>
        {lead.profile.currentTitle || 'Professional'}
      </TableCell>
      <TableCell className="max-w-[190px] text-muted-foreground">
        <div className="truncate">{lead.profile.currentCompany || 'Independent'}</div>
        {(provenance.location || provenance.industry) && (
          <div className="mt-1 truncate text-xs text-slate-500">
            {[provenance.location, provenance.industry].filter(Boolean).join(' - ')}
          </div>
        )}
        {lead.companyAccount && (
          <div className="mt-1 truncate text-xs font-bold text-emerald-400">
            {lead.companyAccount.buyingSignals.length} signals - Pain {lead.companyAccount.operationalPainScore}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex min-w-[190px] flex-col gap-1.5">
          {lead.profile.contactDetails?.email ? (
            <div className="flex items-center gap-1.5 font-semibold">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="max-w-[190px] truncate" title={lead.profile.contactDetails.email}>
                {lead.profile.contactDetails.email}
              </span>
            </div>
          ) : (
            <span className="italic text-muted-foreground">Not provided</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <button
          type="button"
          onClick={() => onOpenDetails(lead)}
          className="flex min-w-[130px] flex-col items-start gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Review workflow for ${lead.profile.fullName}`}
        >
          <Badge variant="outline" className="text-xs">{getReviewStatusLabel(getReviewStatus(lead))}</Badge>
          <span className="text-xs text-muted-foreground">{getNextActionLabel(getNextAction(lead))}</span>
        </button>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        <div className="text-xs font-medium text-slate-300">{addedDate}</div>
        {addedTime && <div className="mt-0.5 text-xs text-slate-500">{addedTime}</div>}
      </TableCell>
      <TableCell className="text-center">
        {(lead.qualificationScore ?? lead.predictiveScore) ? (
          <Badge variant="outline" className="border-indigo-500/30 text-indigo-400">
            {lead.qualificationScore ?? lead.predictiveScore}% Qualified
          </Badge>
        ) : (
          <span className="text-xs text-slate-600">--</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        <Badge variant="outline" className={`text-xs ${stageMeta.badgeClassName}`}>
          {stageMeta.shortLabel}
        </Badge>
      </TableCell>
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
});

export default function LeadTable({ onAddManualLead }: { onAddManualLead: () => void }) {
  const {
    leads,
    handleUpdateLeadStage,
    handleUpdateLeadsStage,
    handleDeleteLead,
    handleDeleteLeads,
    handleUpdateLeadFields,
    handleUpdateLeadsFields,
    handleUpdateLeadProfile,
    handleBulkLeadsAdded,
    handleMergeLead,
  } = useLeads();
  const { triggerToast } = useToast();
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set());
  const [tableSearch, setTableSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<Lead['stage'] | 'All'>('All');
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | 'All'>('All');
  const [nextActionFilter, setNextActionFilter] = useState<NextAction | 'All'>('All');
  const [locationFilter, setLocationFilter] = useState('All');
  const [industryFilter, setIndustryFilter] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [detailsLeadId, setDetailsLeadId] = useState<string | null>(null);

  const [showConfirmBulkDelete, setShowConfirmBulkDelete] = useState(false);
  const [showConfirmPurgeDuplicates, setShowConfirmPurgeDuplicates] = useState(false);
  const [duplicateIdsToDelete, setDuplicateIdsToDelete] = useState<string[]>([]);
  const [leadPendingDelete, setLeadPendingDelete] = useState<Lead | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [bulkMutation, setBulkMutation] = useState<'stage' | 'workflow' | 'delete' | 'purge' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);
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


  const handleTriggerPurgeDuplicates = () => {
    const toDelete: string[] = [];
    const seenEmails = new Set<string>();
    const seenLinks = new Set<string>();
    const seenNames = new Set<string>();

    filteredLeads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase();
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      let isRedundant = false;

      if (email && seenEmails.has(email)) isRedundant = true;
      else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
      else if (nameKey !== '::' && seenNames.has(nameKey)) isRedundant = true;

      if (isRedundant) {
        toDelete.push(lead.id);
      } else {
        if (email) seenEmails.add(email);
        if (linkedin) seenLinks.add(linkedin);
        if (nameKey !== '::') seenNames.add(nameKey);
      }
    });

    if (toDelete.length > 0) {
      const lockedDuplicateCount = toDelete.reduce(
        (count, leadId) => count + (asyncLockedLeadIds.has(leadId) ? 1 : 0),
        0,
      );
      if (lockedDuplicateCount > 0) {
        triggerToast(
          `Wait for enrichment to finish before removing ${lockedDuplicateCount} locked duplicate record${lockedDuplicateCount === 1 ? '' : 's'}.`,
          'info',
        );
        return;
      }
      setDuplicateIdsToDelete(toDelete);
      setShowConfirmPurgeDuplicates(true);
    } else {
      triggerToast('No redundant duplicates found.', 'info');
    }
  };

  const handleExecutePurgeDuplicates = async () => {
    if (duplicateIdsToDelete.length === 0 || isBulkMutating) return;
    const targetIds = [...duplicateIdsToDelete];
    if (targetIds.some((leadId) => asyncLockedLeadIds.has(leadId))) {
      triggerToast('Wait for active enrichment before removing these duplicates.', 'info');
      return;
    }
    setBulkMutation('purge');
    try {
      if (handleDeleteLeads) {
        await handleDeleteLeads(targetIds);
      } else {
        await Promise.all(targetIds.map((id) => handleDeleteLead(id)));
      }
      if (!isMountedRef.current) return;
      triggerToast(`Successfully purged ${targetIds.length} duplicate leads.`, 'success');
      setDuplicateIdsToDelete([]);
      setShowConfirmPurgeDuplicates(false);
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not delete duplicate leads.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  // Helper to identify potential duplicates in the table
  const duplicateIds = React.useMemo(() => {
    const dupeIds = new Set<string>();
    const emailMap = new Map<string, string[]>();
    const linkMap = new Map<string, string[]>();
    const nameMap = new Map<string, string[]>();

    leads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase() || '';
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase() || '';
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      if (email) {
        if (!emailMap.has(email)) emailMap.set(email, []);
        emailMap.get(email)!.push(lead.id);
      }
      if (linkedin) {
        if (!linkMap.has(linkedin)) linkMap.set(linkedin, []);
        linkMap.get(linkedin)!.push(lead.id);
      }
      if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
      nameMap.get(nameKey)!.push(lead.id);
    });

    for (const ids of emailMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }
    for (const ids of linkMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }
    for (const ids of nameMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }

    return dupeIds;
  }, [leads]);

  const normalizedSearch = useMemo(
    () => tableSearch.trim().toLocaleLowerCase(),
    [tableSearch],
  );
  const deferredSearch = useDeferredValue(normalizedSearch);
  const locationOptions = useMemo(
    () => Array.from(new Set(leads.map(lead => lead.profile.location).filter(Boolean) as string[])).sort(),
    [leads],
  );
  const industryOptions = useMemo(
    () => Array.from(new Set(leads.map(lead => lead.profile.industry).filter(Boolean) as string[])).sort(),
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
  const filteredLeads = useMemo(
    () => searchableLeads
      .filter(({ lead, searchText }) => (
        (stageFilter === 'All' || lead.stage === stageFilter)
        && (reviewFilter === 'All' || getReviewStatus(lead) === reviewFilter)
        && (nextActionFilter === 'All' || getNextAction(lead) === nextActionFilter)
        && (locationFilter === 'All' || lead.profile.location === locationFilter)
        && (industryFilter === 'All' || lead.profile.industry === industryFilter)
        && (!deferredSearch || searchText.includes(deferredSearch))
      ))
      .map(({ lead }) => lead),
    [deferredSearch, industryFilter, locationFilter, nextActionFilter, reviewFilter, searchableLeads, stageFilter],
  );

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
  const detailsLead = useMemo(
    () => leads.find(lead => lead.id === detailsLeadId) || null,
    [detailsLeadId, leads],
  );

  React.useEffect(() => {
    setCurrentPage(1);
  }, [industryFilter, locationFilter, nextActionFilter, normalizedSearch, reviewFilter, stageFilter]);

  React.useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages));
  }, [totalPages]);

  React.useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  React.useEffect(() => {
    setSelectedLeadIds((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(Array.from(previous).filter((id) => leadIdSet.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [leadIdSet]);

  React.useEffect(() => {
    if (detailsLeadId && !leadIdSet.has(detailsLeadId)) setDetailsLeadId(null);
  }, [detailsLeadId, leadIdSet]);

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
    const toSelect = new Set<string>();
    const seenEmails = new Set<string>();
    const seenLinks = new Set<string>();
    const seenNames = new Set<string>();

    filteredLeads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase();
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      let isRedundant = false;

      if (email && seenEmails.has(email)) isRedundant = true;
      else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
      else if (nameKey !== '::' && seenNames.has(nameKey)) isRedundant = true;

      if (isRedundant) {
        toSelect.add(lead.id);
      } else {
        if (email) seenEmails.add(email);
        if (linkedin) seenLinks.add(linkedin);
        if (nameKey !== '::') seenNames.add(nameKey);
      }
    });

    if (toSelect.size > 0) {
      setSelectedLeadIds(new Set(toSelect));
      triggerToast(`Selected ${toSelect.size} redundant duplicate leads.`, 'info');
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
    setBulkMutation('stage');
    try {
      let updatedCount = targetIds.length;
      let removedCount = 0;
      if (handleUpdateLeadsStage) {
        const result = await handleUpdateLeadsStage(targetIds, stage);
        updatedCount = result.updatedCount;
        removedCount = result.removedCount;
      } else {
        await Promise.all(targetIds.map((id) => Promise.resolve(handleUpdateLeadStage(id, stage))));
      }
      if (!isMountedRef.current) return;
      const removedMessage = removedCount > 0
        ? ` ${removedCount} prospect${removedCount === 1 ? ' was' : 's were'} already removed elsewhere.`
        : '';
      triggerToast(
        updatedCount > 0
          ? `Updated ${updatedCount} lead stage${updatedCount === 1 ? '' : 's'} to ${getPipelineStageMeta(stage).shortLabel}.${removedMessage}`
          : `No stages were changed.${removedMessage}`,
        updatedCount > 0 ? 'success' : 'info',
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
    setBulkMutation('workflow');
    try {
      await handleUpdateLeadsFields(targetIds, updates);
      if (!isMountedRef.current) return;
      triggerToast(`Updated workflow for ${targetIds.length} prospect${targetIds.length === 1 ? '' : 's'}.`, 'success');
      setSelectedLeadIds(new Set());
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not update prospect workflow.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
  };

  const handleDetailsWorkflowChange = async (
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    if (!detailsLead || isBulkMutating) return;
    setBulkMutation('workflow');
    try {
      await handleUpdateLeadFields(detailsLead.id, updates);
      if (isMountedRef.current) triggerToast('Prospect workflow saved.', 'success');
    } catch (error: any) {
      if (isMountedRef.current) triggerToast(error.message || 'Could not save prospect workflow.', 'error');
    } finally {
      if (isMountedRef.current) setBulkMutation(null);
    }
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
            // Flexible heuristic field mapping
            const getField = (keys: string[]) => {
              const matchingKey = Object.keys(row).find(k => keys.some(key => k.toLowerCase().includes(key)));
              return matchingKey ? row[matchingKey].trim() : '';
            };

            const fName = getField(['first', 'fn']);
            const lName = getField(['last', 'ln']);
            let fullName = getField(['full name', 'name', 'contact']);
            if (!fullName && (fName || lName)) {
              fullName = `${fName} ${lName}`.trim();
            }
            if (!fullName) return [];

            const company = getField(['company', 'employer', 'org']);
            const title = getField(['title', 'role', 'position']);
            const email = getField(['email']);
            const phone = getField(['phone', 'mobile']);
            const linkedinUrl = getField(['linkedin', 'profile url', 'url']);

            const industry = getField(['industry', 'sector']) || 'Tech';
            const location = getField(['location', 'country', 'city']);
            const summary = getField(['summary', 'bio', 'notes']);
            const skillsStr = getField(['skills', 'tags']);
            const skills = skillsStr ? skillsStr.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];
            const importedReviewStatus = getField(['review status']).toUpperCase();
            const importedNextAction = getField(['next action']).toUpperCase().replace(/\s+/g, '_');
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
              stage: 'SCRAPED',
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
              {bulkMutation === 'delete' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
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
            <DialogTitle>Remove {duplicateIdsToDelete.length} duplicate record{duplicateIdsToDelete.length === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>This keeps one record per prospect and permanently deletes the redundant copies.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => {
              setShowConfirmPurgeDuplicates(false);
              setDuplicateIdsToDelete([]);
            }} disabled={isBulkMutating}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={handleExecutePurgeDuplicates} disabled={isBulkMutating || duplicateIdsToDelete.some((leadId) => asyncLockedLeadIds.has(leadId))}>
              {bulkMutation === 'purge' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {bulkMutation === 'purge' ? 'Removing...' : 'Remove duplicates'}
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
              {bulkMutation === 'delete' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {bulkMutation === 'delete' ? 'Deleting...' : 'Delete prospect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detailsLead)} onOpenChange={(open) => {
        if (!open && bulkMutation !== 'workflow') setDetailsLeadId(null);
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detailsLead?.profile.fullName || 'Prospect details'}</DialogTitle>
            <DialogDescription>
              Review provenance and set lightweight workflow labels. These controls do not send outreach or move pipeline stages.
            </DialogDescription>
          </DialogHeader>
          {detailsLead && (() => {
            const provenance = getLeadProvenance(detailsLead);
            return (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1 text-sm font-semibold">
                    <span>Review status</span>
                    <select
                      value={getReviewStatus(detailsLead)}
                      disabled={bulkMutation === 'workflow' || asyncLockedLeadIds.has(detailsLead.id)}
                      onChange={(event) => void handleDetailsWorkflowChange({ reviewStatus: event.target.value as ReviewStatus })}
                      className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      {REVIEW_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-semibold">
                    <span>Next action</span>
                    <select
                      value={getNextAction(detailsLead)}
                      disabled={bulkMutation === 'workflow' || asyncLockedLeadIds.has(detailsLead.id)}
                      onChange={(event) => void handleDetailsWorkflowChange({ nextAction: event.target.value as NextAction })}
                      className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      {NEXT_ACTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                </div>
                <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-sm sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Title</span><p className="mt-1 font-semibold">{detailsLead.profile.currentTitle || 'Not provided'}</p></div>
                  <div><span className="text-muted-foreground">Company</span><p className="mt-1 font-semibold">{detailsLead.profile.currentCompany || 'Not provided'}</p></div>
                  <div><span className="text-muted-foreground">Location</span><p className="mt-1 font-semibold">{provenance.location || 'Not provided'}</p></div>
                  <div><span className="text-muted-foreground">Industry</span><p className="mt-1 font-semibold">{provenance.industry || 'Not provided'}</p></div>
                  <div><span className="text-muted-foreground">Email</span><p className="mt-1 break-all font-semibold">{detailsLead.profile.contactDetails?.email || 'Not provided'}</p></div>
                  <div><span className="text-muted-foreground">LinkedIn</span><p className="mt-1 break-all font-semibold">{detailsLead.profile.contactDetails?.linkedinUrl || 'Not provided'}</p></div>
                </div>
                <section>
                  <h3 className="text-sm font-bold">Discovery query</h3>
                  <p className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-sm text-slate-300">{provenance.discoveryQuery || 'No discovery query was stored for this prospect.'}</p>
                </section>
                <section>
                  <h3 className="text-sm font-bold">Matched criteria</h3>
                  {provenance.matchedCriteria.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">{provenance.matchedCriteria.map(criterion => <Badge key={criterion} variant="outline">{criterion}</Badge>)}</div>
                  ) : <p className="mt-2 text-sm text-muted-foreground">No matched criteria recorded.</p>}
                </section>
                <section>
                  <h3 className="text-sm font-bold">Uncertainties</h3>
                  {provenance.uncertainties.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-200">{provenance.uncertainties.map(item => <li key={item}>{item}</li>)}</ul>
                  ) : <p className="mt-2 text-sm text-muted-foreground">No uncertainties recorded.</p>}
                </section>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Card className="relative shadow-2xl" aria-busy={isBulkMutating}>
        <CardContent className="space-y-6 p-4 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-extrabold text-foreground">
                <Layers className="h-5 w-5 text-primary" aria-hidden="true" />
                Prospects
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Review saved contacts, enrich selected records, and move them into the right pipeline stage.</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={onAddManualLead}>
                <UserPlus2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Add prospect
              </Button>
              <input type="file" accept=".csv" ref={fileInputRef} onChange={handleCsvImport} className="sr-only" tabIndex={-1} />
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
                {isImporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <UploadCloud className="mr-2 h-4 w-4" aria-hidden="true" />}
                {isImporting ? 'Importing...' : 'Import CSV'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => handleCsvExport(true)} disabled={leads.length === 0}>
                <FileDown className="mr-2 h-4 w-4" aria-hidden="true" />
                Export all
              </Button>
              <details className="group relative">
                <summary className="flex h-9 cursor-pointer list-none items-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  More actions
                </summary>
                <div className="absolute right-0 z-30 mt-2 grid w-52 gap-1 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-2xl">
                  <Button type="button" variant="ghost" size="sm" className="justify-start" onClick={handleSelectDuplicates} disabled={leads.length === 0 || isBulkMutating}>Select duplicates</Button>
                  <Button type="button" variant="ghost" size="sm" className="justify-start text-destructive hover:text-destructive" onClick={handleTriggerPurgeDuplicates} disabled={leads.length === 0 || isBulkMutating}>Remove duplicates</Button>
                </div>
              </details>
            </div>
          </div>

          {selectedLeadIds.size > 0 && (
            <section className="flex flex-col gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between" aria-label="Selected prospect actions">
              <div className="flex items-center gap-2">
                <Badge>{selectedLeadIds.size}</Badge>
                <span className="text-sm font-semibold text-slate-200">selected</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="bulk-stage" className="sr-only">Move selected prospects to stage</label>
                <select
                  id="bulk-stage"
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  defaultValue=""
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                  onChange={(event) => {
                    if (event.target.value) void handleBulkStageChange(event.target.value as Lead['stage']);
                    event.target.value = '';
                  }}
                >
                  <option value="" disabled>Move to stage...</option>
                  {PIPELINE_STAGES.map(stage => <option key={stage.id} value={stage.id}>{stage.shortLabel}</option>)}
                </select>
                <label htmlFor="bulk-review" className="sr-only">Set review status for selected prospects</label>
                <select
                  id="bulk-review"
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  defaultValue=""
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                  onChange={(event) => {
                    if (event.target.value) void handleBulkWorkflowChange({ reviewStatus: event.target.value as ReviewStatus });
                    event.target.value = '';
                  }}
                >
                  <option value="" disabled>Set review...</option>
                  {REVIEW_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <label htmlFor="bulk-next-action" className="sr-only">Set next action for selected prospects</label>
                <select
                  id="bulk-next-action"
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  defaultValue=""
                  disabled={isBulkMutating || selectedHasAsyncLockedLead}
                  onChange={(event) => {
                    if (event.target.value) void handleBulkWorkflowChange({ nextAction: event.target.value as NextAction });
                    event.target.value = '';
                  }}
                >
                  <option value="" disabled>Set next action...</option>
                  {NEXT_ACTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <Button type="button" variant="outline" size="sm" onClick={handleStartEnrichment} disabled={enrichmentQueue.length > 0 || isBulkMutating || selectedHasAsyncLockedLead}>
                  {enrichmentQueue.length > 0 ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />}
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
                <p className="basis-full text-xs font-medium text-amber-300" role="status">
                  Workflow, stage, and delete actions unlock when active enrichment finishes.
                </p>
              )}
            </section>
          )}

      {enrichmentStep && (
        <div className="bg-indigo-900/30 border border-indigo-500/30 rounded-xl px-4 py-3 flex items-center justify-between" role="status" aria-live="polite">
           <div className="flex items-center gap-3">
             <Loader2 className="w-5 h-5 text-indigo-400 animate-spin motion-reduce:animate-none" aria-hidden="true" />
             <div className="flex flex-col">
               <span className="text-sm font-bold text-indigo-200">Enriching {enrichmentQueue.length} record{enrichmentQueue.length === 1 ? '' : 's'}...</span>
               <span className="text-xs text-indigo-300">{enrichmentStep}</span>
             </div>
           </div>
        </div>
      )}

      {/* Spreadsheet Controller */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between border-t border-slate-800/60 pt-4">
        <div className="relative w-full md:w-80">
          <label htmlFor="prospect-search" className="sr-only">Search prospects</label>
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            id="prospect-search"
            type="text"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            placeholder="Search people, companies, criteria, or uncertainties..."
            className="pl-9"
          />
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
          <SlidersHorizontal className="w-4 h-4 text-slate-400" aria-hidden="true" />
          <label htmlFor="stage-filter" className="text-slate-400 text-xs font-bold uppercase">Stage:</label>
          <select
            id="stage-filter"
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value as Lead['stage'] | 'All')}
            className="bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-300 px-3 py-1.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <option value="All">All Stages</option>
            {PIPELINE_STAGES.map(stage => <option key={stage.id} value={stage.id}>{stage.shortLabel}</option>)}
          </select>
          <label htmlFor="review-filter" className="sr-only">Filter by review status</label>
          <select id="review-filter" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewStatus | 'All')} className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm font-medium text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            <option value="All">All reviews</option>
            {REVIEW_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label htmlFor="next-action-filter" className="sr-only">Filter by next action</label>
          <select id="next-action-filter" value={nextActionFilter} onChange={(event) => setNextActionFilter(event.target.value as NextAction | 'All')} className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm font-medium text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            <option value="All">All next actions</option>
            {NEXT_ACTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label htmlFor="location-filter" className="sr-only">Filter by location</label>
          <select id="location-filter" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)} className="max-w-44 rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm font-medium text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            <option value="All">All locations</option>
            {locationOptions.map(location => <option key={location} value={location}>{location}</option>)}
          </select>
          <label htmlFor="industry-filter" className="sr-only">Filter by industry</label>
          <select id="industry-filter" value={industryFilter} onChange={(event) => setIndustryFilter(event.target.value)} className="max-w-44 rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm font-medium text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            <option value="All">All industries</option>
            {industryOptions.map(industry => <option key={industry} value={industry}>{industry}</option>)}
          </select>
        </div>
      </div>

      {/* Real Table Grid scrollable container */}
      <div className="border rounded-xl mb-16">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-center">
                <input
                  ref={selectAllCheckboxRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  disabled={isBulkMutating || selectableVisibleLeadIds.length === 0}
                  className="h-4 w-4 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  aria-checked={someVisibleSelected ? 'mixed' : allVisibleSelected}
                  aria-label={`Select all ${selectableVisibleLeadIds.length} available prospects on this page`}
                />
              </TableHead>
              <TableHead>Contact Profile Name</TableHead>
              <TableHead>Primary Title</TableHead>
              <TableHead>Employer / Company Name</TableHead>
              <TableHead>Corporate Outreach Email</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-center">Qualification Score</TableHead>
              <TableHead className="text-center">Pipeline status</TableHead>
              <TableHead className="text-right">Delete</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLeads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground font-medium py-8">
                  No records stored matching your current directory queries.
                </TableCell>
              </TableRow>
            ) : (
              paginatedLeads.map((lead) => (
                <LeadTableRow
                  key={lead.id}
                  lead={lead}
                  isSelected={selectedLeadIds.has(lead.id)}
                  isDuplicate={duplicateIds.has(lead.id)}
                  isAsyncLocked={asyncLockedLeadIds.has(lead.id)}
                  isMutationLocked={isBulkMutating}
                  onSelect={handleSelectRow}
                  onOpenDetails={(selectedLead) => setDetailsLeadId(selectedLead.id)}
                  onRequestDelete={handleRequestDeleteLead}
                />
              ))
            )}
          </TableBody>
        </Table>
        {filteredLeads.length > PROSPECTS_PAGE_SIZE && (
          <div className="flex flex-col gap-3 border-t bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
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
              <span className="min-w-24 text-center text-xs font-bold text-slate-300">
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

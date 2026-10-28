/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import type { Lead } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  FileDown,
  Copy,
  Check,
  Sparkles,
  Database,
  Archive,
  History,
  Target,
} from 'lucide-react';
import {
  EXPORT_PRESETS,
  type ExportPresetId,
  serializeLeadsToCsv,
  serializeLeadsToTsv,
  downloadCsvFile,
} from '@/utils/csvExport';

export type ExportScope = 'all' | 'filtered' | 'selected';

export interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allLeads: readonly Lead[];
  filteredLeads: readonly Lead[];
  selectedLeadIds: ReadonlySet<string>;
  initialScope?: ExportScope;
  onTriggerToast: (message: string, variant?: 'success' | 'error' | 'info') => void;
}

const PRESET_STORAGE_KEY = 'apex_crm_export_preset';

const PRESET_ICONS: Record<ExportPresetId, React.ComponentType<{ className?: string }>> = {
  outreach: Target,
  crm: Database,
  diagnostic: Archive,
  legacy: History,
};

export function ExportModal({
  open,
  onOpenChange,
  allLeads,
  filteredLeads,
  selectedLeadIds,
  initialScope = 'all',
  onTriggerToast,
}: ExportModalProps) {
  const [selectedPreset, setSelectedPreset] = useState<ExportPresetId>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(PRESET_STORAGE_KEY) as ExportPresetId | null;
      if (saved && EXPORT_PRESETS[saved]) return saved;
    }
    return 'outreach';
  });

  const [scope, setScope] = useState<ExportScope>(initialScope);
  const [copied, setCopied] = useState(false);

  // Synchronize initial scope whenever modal opens
  useEffect(() => {
    if (open) {
      if (initialScope === 'selected' && selectedLeadIds.size > 0) {
        setScope('selected');
      } else if (filteredLeads.length < allLeads.length) {
        setScope('filtered');
      } else {
        setScope('all');
      }
      setCopied(false);
    }
  }, [open, initialScope, selectedLeadIds.size, filteredLeads.length, allLeads.length]);

  const handlePresetChange = (presetId: ExportPresetId) => {
    setSelectedPreset(presetId);
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, presetId);
    } catch {
      // Ignore localStorage failure in private modes
    }
  };

  // Determine target leads based on selected scope
  const targetLeads: readonly Lead[] = React.useMemo(() => {
    if (scope === 'selected') {
      return allLeads.filter((l) => selectedLeadIds.has(l.id));
    }
    if (scope === 'filtered') {
      return filteredLeads;
    }
    return allLeads;
  }, [scope, allLeads, filteredLeads, selectedLeadIds]);

  const activePresetDef = EXPORT_PRESETS[selectedPreset] || EXPORT_PRESETS.outreach;

  const handleDownload = () => {
    if (targetLeads.length === 0) {
      onTriggerToast('No prospects match the selected scope to export.', 'info');
      return;
    }

    try {
      const csv = serializeLeadsToCsv(targetLeads, selectedPreset);
      downloadCsvFile(csv, selectedPreset);
      onTriggerToast(
        `Exported ${targetLeads.length} prospect${targetLeads.length === 1 ? '' : 's'} (${activePresetDef.label}).`,
        'success',
      );
      onOpenChange(false);
    } catch (err) {
      console.error('CSV export failed:', err);
      onTriggerToast('Failed to generate CSV export.', 'error');
    }
  };

  const handleCopyClipboard = async () => {
    if (targetLeads.length === 0) {
      onTriggerToast('No prospects match the selected scope to copy.', 'info');
      return;
    }

    try {
      const tsv = serializeLeadsToTsv(targetLeads, selectedPreset);
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      onTriggerToast(
        `Copied ${targetLeads.length} records to clipboard (TSV format). Ready to paste into Sheets or Excel!`,
        'success',
      );
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      onTriggerToast('Could not copy to clipboard. Please check browser permissions.', 'error');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileDown className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold">Export Prospects</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Export verified contacts with clean domains, personalized icebreaker quotes, and AI match scores.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Scope Selector */}
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Export Scope
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setScope('all')}
                className={`flex flex-col items-start p-3 rounded-lg border text-left transition-all ${
                  scope === 'all'
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'border-border/60 hover:bg-muted/50'
                }`}
              >
                <span className="text-xs font-bold text-foreground">All Prospects</span>
                <span className="text-xs text-muted-foreground mt-0.5">
                  {allLeads.length} total record{allLeads.length === 1 ? '' : 's'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setScope('filtered')}
                disabled={filteredLeads.length === 0}
                className={`flex flex-col items-start p-3 rounded-lg border text-left transition-all ${
                  filteredLeads.length === 0 ? 'opacity-50 cursor-not-allowed' : ''
                } ${
                  scope === 'filtered'
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'border-border/60 hover:bg-muted/50'
                }`}
              >
                <span className="text-xs font-bold text-foreground">Filtered Results</span>
                <span className="text-xs text-muted-foreground mt-0.5">
                  {filteredLeads.length} matching search
                </span>
              </button>

              <button
                type="button"
                onClick={() => setScope('selected')}
                disabled={selectedLeadIds.size === 0}
                className={`flex flex-col items-start p-3 rounded-lg border text-left transition-all ${
                  selectedLeadIds.size === 0 ? 'opacity-50 cursor-not-allowed' : ''
                } ${
                  scope === 'selected'
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'border-border/60 hover:bg-muted/50'
                }`}
              >
                <span className="text-xs font-bold text-foreground">Selected Prospects</span>
                <span className="text-xs text-muted-foreground mt-0.5">
                  {selectedLeadIds.size} checked row{selectedLeadIds.size === 1 ? '' : 's'}
                </span>
              </button>
            </div>
          </div>

          {/* Preset Selector */}
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Export Preset & Destination Format
            </label>
            <div className="grid grid-cols-1 gap-2.5">
              {(Object.keys(EXPORT_PRESETS) as ExportPresetId[]).map((presetId) => {
                const preset = EXPORT_PRESETS[presetId];
                const IconComponent = PRESET_ICONS[presetId] || Target;
                const isSelected = selectedPreset === presetId;

                return (
                  <button
                    key={presetId}
                    type="button"
                    onClick={() => handlePresetChange(presetId)}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/10 ring-1 ring-primary shadow-xs'
                        : 'border-border/60 hover:bg-muted/40'
                    }`}
                  >
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 ${
                        isSelected
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <IconComponent className="h-4 w-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-foreground">{preset.label}</span>
                        <Badge
                          variant="outline"
                          className={`h-5 text-[10px] px-1.5 font-medium ${
                            presetId === 'outreach'
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : presetId === 'crm'
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          {preset.badge}
                        </Badge>
                        <span className="text-xs text-muted-foreground/80 font-mono">
                          ({preset.columns.length} columns)
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {preset.description}
                      </p>

                      <div className="mt-1.5 text-[11px] font-medium text-foreground/70 flex items-center gap-1">
                        <span className="text-muted-foreground">Best for:</span>
                        <span className="truncate">{preset.targetTools}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Preset Columns Preview */}
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Columns included ({activePresetDef.columns.length})
              </span>
              <span className="text-[11px] text-muted-foreground">
                Targeting: {targetLeads.length} record{targetLeads.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pt-1">
              {activePresetDef.columns.map((col) => {
                const isHighlight =
                  col.id === 'companyDomain' ||
                  col.id === 'icebreakerQuote' ||
                  col.id === 'priorityTier' ||
                  col.id === 'compositeScore' ||
                  col.id === 'hiringSignalUrl';

                return (
                  <Badge
                    key={col.id}
                    variant={isHighlight ? 'default' : 'secondary'}
                    className={`text-[11px] px-2 py-0.5 font-normal ${
                      isHighlight
                        ? 'bg-primary text-primary-foreground font-semibold shadow-2xs'
                        : 'bg-background/80 text-foreground/80 border border-border/50'
                    }`}
                    title={col.description}
                  >
                    {col.header}
                  </Badge>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 pt-2 border-t">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-xs text-muted-foreground"
          >
            Cancel
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyClipboard}
              disabled={targetLeads.length === 0}
              className="text-xs gap-1.5"
              title="Copy to clipboard as tab-separated values to paste directly into Google Sheets or Excel"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-success" aria-hidden="true" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  <span>Copy to Clipboard</span>
                </>
              )}
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={handleDownload}
              disabled={targetLeads.length === 0}
              className="text-xs gap-1.5 font-semibold"
            >
              <FileDown className="h-4 w-4" aria-hidden="true" />
              <span>Download CSV ({targetLeads.length})</span>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

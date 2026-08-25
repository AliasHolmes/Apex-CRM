import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Lead } from '@/types';
import { AlertTriangle, Check, RefreshCw, GitMerge } from 'lucide-react';

export type ConflictResolutionStrategy = 'keep_local' | 'keep_server' | 'merge';

export interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localLead: Lead | null;
  serverLead: Lead | null;
  onResolve: (resolvedLead: Lead, strategy: ConflictResolutionStrategy) => void;
}

export function ConflictDialog({
  open,
  onOpenChange,
  localLead,
  serverLead,
  onResolve,
}: ConflictDialogProps) {
  if (!localLead || !serverLead) return null;

  const getChangedFields = () => {
    const fields: { label: string; localVal: string; serverVal: string }[] = [];

    const checkField = (label: string, lVal?: string | number | null, sVal?: string | number | null) => {
      const l = String(lVal ?? '').trim();
      const s = String(sVal ?? '').trim();
      if (l !== s) {
        fields.push({ label, localVal: l || '(empty)', serverVal: s || '(empty)' });
      }
    };

    checkField('Full Name', localLead.profile?.fullName, serverLead.profile?.fullName);
    checkField('Title', localLead.profile?.currentTitle || localLead.profile?.headline, serverLead.profile?.currentTitle || serverLead.profile?.headline);
    checkField('Company', localLead.profile?.currentCompany, serverLead.profile?.currentCompany);
    checkField('Stage', localLead.stage, serverLead.stage);
    checkField('Review Status', localLead.reviewStatus, serverLead.reviewStatus);
    checkField('Next Action', localLead.nextAction, serverLead.nextAction);
    checkField('Email', localLead.profile?.contactDetails?.email, serverLead.profile?.contactDetails?.email);
    checkField('Notes', localLead.notes, serverLead.notes);

    return fields;
  };

  const changedFields = getChangedFields();

  const handleKeepLocal = () => {
    const resolved: Lead = {
      ...localLead,
      revision: serverLead.revision,
    };
    onResolve(resolved, 'keep_local');
    onOpenChange(false);
  };

  const handleKeepServer = () => {
    onResolve(serverLead, 'keep_server');
    onOpenChange(false);
  };

  const handleMerge = () => {
    const resolved: Lead = {
      ...serverLead,
      ...localLead,
      revision: serverLead.revision,
      profile: {
        ...serverLead.profile,
        ...localLead.profile,
        contactDetails: {
          ...serverLead.profile?.contactDetails,
          ...localLead.profile?.contactDetails,
        },
      },
      notes: localLead.notes || serverLead.notes || '',
      tags: Array.from(new Set([...(serverLead.tags || []), ...(localLead.tags || [])])),
    };
    onResolve(resolved, 'merge');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="h-5 w-5" />
            <DialogTitle className="text-lg font-semibold">Lead Revision Conflict</DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            This prospect was modified on the server while you were making changes. Review the differences below and choose how to reconcile them.
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 space-y-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground px-2">
            <span>Server Revision: v{serverLead.revision ?? 1}</span>
            <span>Local Revision: v{localLead.revision ?? 0}</span>
          </div>

          {changedFields.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2 text-center">
              Metadata timestamp differences only. No user-visible field conflicts.
            </p>
          ) : (
            <div className="border rounded-md divide-y overflow-hidden text-sm">
              <div className="grid grid-cols-3 bg-muted/40 font-medium p-2 text-xs text-muted-foreground">
                <div>Field</div>
                <div>Your Edit (Local)</div>
                <div>Server Version</div>
              </div>
              {changedFields.map((f, i) => (
                <div key={i} className="grid grid-cols-3 p-2 gap-2 items-center text-xs">
                  <div className="font-medium text-foreground flex items-center gap-1.5">
                    <Badge variant="outline" className="text-xs px-1.5 py-0 font-normal">
                      {f.label}
                    </Badge>
                  </div>
                  <div className="text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20 p-1.5 rounded truncate">
                    {f.localVal}
                  </div>
                  <div className="text-emerald-600 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 p-1.5 rounded truncate">
                    {f.serverVal}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-end">
          <Button variant="outline" size="sm" onClick={handleKeepServer} className="flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Accept Server Version
          </Button>
          <Button variant="outline" size="sm" onClick={handleMerge} className="flex items-center gap-1.5">
            <GitMerge className="h-4 w-4" />
            Smart Merge
          </Button>
          <Button variant="default" size="sm" onClick={handleKeepLocal} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700">
            <Check className="h-4 w-4" />
            Overwrite With My Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

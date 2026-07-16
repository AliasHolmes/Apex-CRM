import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { Lead, LinkedInProfile, NextAction, QualifiedLeadProfile, ReviewStatus } from '../types';
import { predictiveScoreFromComposite, scoreLeadDeterministically } from '../utils/leadScore';
import { buildProfileDedupeKeys, hasDuplicateProfile } from '../utils/leadDedupe';
import { preferNewerCanonical, rebaseLeadChanges } from '@/lib/leadMutations';

const LEGACY_LEADS_STORAGE_KEY = 'linkedin_scraper_crm_leads';

type StoredLeadsResponse = {
  leads: Lead[];
  initialized: boolean;
};

async function loadLeadsFromSqliteBackend(): Promise<StoredLeadsResponse> {
  const response = await fetch('/api/leads');
  if (!response.ok) {
    throw new Error(`Failed to load leads: ${response.status}`);
  }

  const data = await response.json();
  return {
    leads: Array.isArray(data.leads) ? data.leads : [],
    initialized: Boolean(data.initialized)
  };
}

async function persistLeadsToSqliteBackend(leads: Lead[]): Promise<void> {
  const response = await fetch('/api/leads/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads })
  });

  if (!response.ok) {
    throw new Error(`Failed to save leads: ${response.status}`);
  }
}

function sanitizeLeads(loadedLeads: unknown[]): Lead[] {
  return loadedLeads.map((lead) => {
    const candidate = lead as Lead;
    return {
      ...candidate,
      id: candidate.id || crypto.randomUUID(),
      reviewStatus: candidate.reviewStatus || 'UNREVIEWED',
      nextAction: candidate.nextAction || 'NONE',
    };
  });
}

function loadLegacyBrowserLeads(): Lead[] | null {
  try {
    const legacyStored = localStorage.getItem(LEGACY_LEADS_STORAGE_KEY);
    if (!legacyStored) return null;

    const parsed: unknown = JSON.parse(legacyStored);
    return Array.isArray(parsed) ? sanitizeLeads(parsed) : null;
  } catch (error) {
    console.warn('Legacy browser lead migration failed:', error);
    return null;
  }
}

class LeadPatchConflictError extends Error {
  constructor(public readonly currentLead: Lead, message: string) {
    super(message);
    this.name = 'LeadPatchConflictError';
  }
}

class LeadDeletedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadDeletedConflictError';
  }
}

async function persistLeadPatch(lead: Lead, allowCreate = false): Promise<Lead> {
  const response = await fetch(`/api/leads/${lead.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead, allowCreate }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409 && data.lead) {
    throw new LeadPatchConflictError(
      data.lead as Lead,
      data.error || 'This prospect changed while the update was being saved.',
    );
  }
  if (response.status === 409 && data.code === 'LEAD_NO_LONGER_EXISTS') {
    throw new LeadDeletedConflictError(
      data.error || 'This prospect was removed before the update completed.',
    );
  }
  if (!response.ok || !data.lead) {
    throw new Error(data.error || `Failed to patch lead: ${response.status}`);
  }
  return data.lead as Lead;
}


interface LeadContextType {
  leads: Lead[];
  isHydrated: boolean;
  saveLeadsToStorage: (updater: Lead[] | ((prev: Lead[]) => Lead[])) => void;
  rehydrateLeads: (preserveExistingOnFailure?: boolean) => Promise<boolean>;
  handleLeadAdded: (profile: LinkedInProfile) => Promise<{ added: boolean }>;
  handleBulkLeadsAdded: (profiles: (QualifiedLeadProfile | Lead)[]) => Promise<{ addedCount: number; skippedCount: number }>;
  handleUpdateLeadStage: (leadId: string, stage: Lead['stage']) => Promise<void>;
  handleUpdateLeadNotes: (leadId: string, notes: string) => Promise<void>;
  handleUpdateLeadFields: (
    leadId: string,
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => Promise<void>;
  handleUpdateLeadsFields: (
    leadIds: string[],
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => Promise<{ updatedCount: number }>;
  handleUpdateLeadProfile: (leadId: string, profileUpdates: Partial<LinkedInProfile>) => void;
  handleMergeLead: (updatedLead: Lead) => void;
  handleServerMergeLead: (winnerId: string, duplicateId: string) => Promise<void>;
  handleUpdateLeadTags: (leadId: string, tags: string[]) => Promise<void>;
  handleDeleteLead: (leadId: string) => Promise<void>;
  handleDeleteLeads: (leadIds: string[]) => Promise<void>;
  handleUpdateLeadsStage: (
    leadIds: string[],
    stage: Lead['stage'],
  ) => Promise<{ updatedCount: number; removedCount: number }>;
}

const LeadContext = createContext<LeadContextType | undefined>(undefined);

export function LeadProvider({ children }: { children: ReactNode }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const leadsRef = useRef<Lead[]>([]);
  const leadPatchQueuesRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const leadPatchRollbackRef = useRef<Map<string, Lead | null>>(new Map());

  const saveLeadsToStorage = useCallback((updater: Lead[] | ((prevLeads: Lead[]) => Lead[])) => {
    const nextLeads = typeof updater === 'function'
      ? updater(leadsRef.current)
      : updater;
    leadsRef.current = nextLeads;
    setLeads(nextLeads);
  }, []);

  const restoreLeadSubset = useCallback((affectedIds: ReadonlySet<string>, rollbackLeads: Lead[]) => {
    const rollbackById = new Map(rollbackLeads.map(lead => [lead.id, lead]));
    saveLeadsToStorage(currentLeads => {
      const restoredIds = new Set<string>();
      const nextLeads = currentLeads.flatMap(lead => {
        if (!affectedIds.has(lead.id)) return [lead];
        const rollbackLead = rollbackById.get(lead.id);
        if (!rollbackLead) return [];
        restoredIds.add(lead.id);
        return [rollbackLead];
      });
      for (const rollbackLead of rollbackLeads) {
        if (!restoredIds.has(rollbackLead.id)) nextLeads.unshift(rollbackLead);
      }
      return nextLeads;
    });
  }, [saveLeadsToStorage]);

  const rehydrateLeads = useCallback(async (preserveExistingOnFailure = false): Promise<boolean> => {
    try {
      const stored = await loadLeadsFromSqliteBackend();
      if (stored.initialized) {
        saveLeadsToStorage(sanitizeLeads(stored.leads));
        return true;
      }

      const initialLeads = loadLegacyBrowserLeads() || [];
      saveLeadsToStorage(initialLeads);
      persistLeadsToSqliteBackend(initialLeads).catch(error => console.warn('SQLite seed migration failed:', error));
      return true;
    } catch (error) {
      console.error('SQLite lead load failed:', error);
      if (!preserveExistingOnFailure) {
        saveLeadsToStorage(loadLegacyBrowserLeads() || []);
      }
      return false;
    } finally {
      setIsHydrated(true);
    }
  }, [saveLeadsToStorage]);

  useEffect(() => {
    void rehydrateLeads();
  }, [rehydrateLeads]);

  const reconcileLeadPatch = useCallback((lead: Lead, rollbackLead: Lead | null, allowCreate = false): Promise<boolean> => {
    const existingOperation = leadPatchQueuesRef.current.get(lead.id);
    if (!existingOperation) leadPatchRollbackRef.current.set(lead.id, rollbackLead);
    const previousOperation = existingOperation ?? Promise.resolve(true);
    let operation: Promise<boolean>;

    operation = previousOperation.then(async (previousSucceeded) => {
      if (!previousSucceeded) return false;
      try {
        const stableCanonicalLead = leadPatchRollbackRef.current.get(lead.id) ?? rollbackLead;
        const leadWithCurrentRevision = !allowCreate && stableCanonicalLead && rollbackLead
          ? rebaseLeadChanges(stableCanonicalLead, lead, rollbackLead)
          : stableCanonicalLead?.revision === undefined
            ? lead
            : { ...lead, revision: stableCanonicalLead.revision };
        let canonicalLead: Lead;
        try {
          canonicalLead = await persistLeadPatch(leadWithCurrentRevision, allowCreate);
        } catch (error) {
          if (!(error instanceof LeadPatchConflictError) || allowCreate) throw error;
          const rebasedLead = rebaseLeadChanges(error.currentLead, lead, rollbackLead);
          canonicalLead = await persistLeadPatch(rebasedLead);
        }
        const hasNewerQueuedPatch = leadPatchQueuesRef.current.get(lead.id) !== operation;
        canonicalLead = preferNewerCanonical(
          canonicalLead,
          leadPatchRollbackRef.current.get(lead.id),
        );
        if (hasNewerQueuedPatch) {
          leadPatchRollbackRef.current.set(lead.id, canonicalLead);
        }

        saveLeadsToStorage(currentLeads => currentLeads.map(current => {
          if (current.id !== canonicalLead.id) return current;
          return hasNewerQueuedPatch
            ? { ...canonicalLead, ...current, revision: canonicalLead.revision }
            : canonicalLead;
        }));
        return true;
      } catch (error) {
        console.error(`Failed to sync lead ${lead.id} update to backend:`, error);
        if (error instanceof LeadDeletedConflictError) {
          restoreLeadSubset(new Set([lead.id]), []);
          return false;
        }
        const stableLead = leadPatchRollbackRef.current.get(lead.id) ?? null;
        restoreLeadSubset(new Set([lead.id]), stableLead ? [stableLead] : []);
        return false;
      }
    });

    leadPatchQueuesRef.current.set(lead.id, operation);
    void operation.finally(() => {
      if (leadPatchQueuesRef.current.get(lead.id) === operation) {
        leadPatchQueuesRef.current.delete(lead.id);
        leadPatchRollbackRef.current.delete(lead.id);
      }
    });
    return operation;
  }, [restoreLeadSubset, saveLeadsToStorage]);

  // 3. Callback to add single scraped profile
  const handleLeadAdded = useCallback(async (profile: LinkedInProfile): Promise<{ added: boolean }> => {
    let newLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => {
      const existingKeys = new Set<string>();
      currentLeads.forEach(lead => buildProfileDedupeKeys(lead.profile).forEach(key => existingKeys.add(key)));
      const isDup = hasDuplicateProfile(profile, existingKeys);

      if (isDup) {
        console.warn("Skipped writing duplicate lead to CRM:", profile.fullName);
        return currentLeads;
      }

      const compositeScore = scoreLeadDeterministically(profile);
      const predictiveScore = predictiveScoreFromComposite(compositeScore);

      newLead = {
        id: `lead-${crypto.randomUUID()}`,
        profile,
        stage: 'SCRAPED',
        notes: 'Profile automatically harvested and structured by AI Search Scraper.',
        createdAt: new Date().toISOString(),
        tags: ['Scraped Lead', profile.industry || 'Tech'],
        compositeScore,
        predictiveScore,
        qualificationScore: predictiveScore,
        reviewStatus: 'UNREVIEWED',
        nextAction: 'NONE'
      };

      return [newLead, ...currentLeads];
    });

    const leadToPersist = newLead as Lead | null;
    if (!leadToPersist) {
      return { added: false };
    }

    const didPersist = await reconcileLeadPatch(leadToPersist, null, true);
    if (!didPersist) throw new Error(`Could not save ${profile.fullName} to the CRM.`);
    return { added: true };
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  // 4. Callback to handle bulk lead inputs
  const handleBulkLeadsAdded = useCallback(async (profiles: (QualifiedLeadProfile | Lead)[]): Promise<{ addedCount: number; skippedCount: number }> => {
    const leadsToSaveBackend: Lead[] = [];
    let skippedCount = profiles.length;

    saveLeadsToStorage(currentLeads => {
      const existingKeys = new Set<string>();
      currentLeads.forEach(l => buildProfileDedupeKeys(l.profile).forEach(key => existingKeys.add(key)));

      const uniqueItems = profiles.filter(item => {
        const profile = ('profile' in item) ? item.profile : item;
        if (hasDuplicateProfile(profile, existingKeys)) return false;
        buildProfileDedupeKeys(profile).forEach(key => existingKeys.add(key));
        return true;
      });

      if (uniqueItems.length === 0) {
        console.warn("All bulk profiles were duplicates, skipping CRM integration.");
        return currentLeads;
      }

      const newLeads = uniqueItems.map((item, i) => {
        if ('profile' in item) {
          const existingLead = {
            ...(item as Lead),
            reviewStatus: (item as Lead).reviewStatus || 'UNREVIEWED',
            nextAction: (item as Lead).nextAction || 'NONE',
          };
          leadsToSaveBackend.push(existingLead);
          return existingLead;
        }

        const p = item;
        const hasAccountContext = !!p.companyAccount;
        const backendFinalScore = Number(p.scoreBreakdown?.finalScore || p.scoreOverride || 0);
        const compositeScore = backendFinalScore > 0
          ? Math.round(backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore)
          : scoreLeadDeterministically(p, p.companyAccount);
        const predictiveScore = predictiveScoreFromComposite(compositeScore, hasAccountContext);

        const newLead: Lead = {
          id: `lead-bulk-${crypto.randomUUID()}-${i}`,
          profile: p,
          stage: 'SCRAPED' as Lead['stage'],
          notes: hasAccountContext
            ? `LinkedIn-indexed lead with account context. ${p.companyAccount?.painSummary || 'Review profile and advance to outreach.'}`
            : 'Discovered via Tavily LinkedIn-indexed search.',
          createdAt: new Date().toISOString(),
          tags: hasAccountContext
            ? ['LinkedIn Indexed', 'Account Context', p.industry || 'Tech']
            : ['LinkedIn Indexed', p.industry || 'Tech'],
          fitScore: p.scoreBreakdown?.fitScore,
          intentScore: p.scoreBreakdown?.intentScore,
          timingScore: p.scoreBreakdown?.timingScore,
          compositeScore,
          predictiveScore,
          qualificationScore: predictiveScore,
          companyAccount: p.companyAccount,
          decisionMakerVerification: p.decisionMakerVerification,
          sourceProvider: p.sourceProvider || 'tavily',
          evidenceReasons: p.evidenceReasons,
          evidence: p.evidence,
          scoreBreakdown: p.scoreBreakdown,
          buyingSignalsDetected: p.companyAccount?.buyingSignals?.map(signal => signal.label),
          reviewStatus: 'UNREVIEWED',
          nextAction: 'NONE'
        };

        leadsToSaveBackend.push(newLead);
        return newLead;
      });
      skippedCount = profiles.length - newLeads.length;
      return [...newLeads, ...currentLeads];
    });

    if (leadsToSaveBackend.length === 0) {
      return { addedCount: 0, skippedCount };
    }

    const insertedIds = new Set(leadsToSaveBackend.map(lead => lead.id));
    let bulkError: unknown;
    let bulkOperation!: Promise<boolean>;
    bulkOperation = (async () => {
      try {
        const response = await fetch('/api/leads/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: leadsToSaveBackend })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Failed to save bulk leads: ${response.status}`);
        }
        {
          const returnedLeads = Array.isArray(data.leads) ? data.leads as Lead[] : [];
          const returnedById = new Map(returnedLeads.map(lead => [lead.id, lead]));
          const canonicalLeads = leadsToSaveBackend.map(
            lead => returnedById.get(lead.id) ?? lead,
          );
          const serverLeads = new Map(canonicalLeads.map(lead => [
            lead.id,
            preferNewerCanonical(lead, leadPatchRollbackRef.current.get(lead.id)),
          ]));
          for (const [leadId, canonicalLead] of serverLeads) {
            if (leadPatchQueuesRef.current.get(leadId) !== bulkOperation) {
              leadPatchRollbackRef.current.set(leadId, canonicalLead);
            }
          }
          saveLeadsToStorage(currentLeads => currentLeads.map(lead => {
            const canonicalLead = serverLeads.get(lead.id);
            if (!canonicalLead) return lead;
            return leadPatchQueuesRef.current.get(lead.id) === bulkOperation
              ? canonicalLead
              : { ...canonicalLead, ...lead, revision: canonicalLead.revision };
          }));
        }
        return true;
      } catch (error) {
        bulkError = error;
        console.error('Failed to save bulk leads to backend:', error);
        restoreLeadSubset(insertedIds, []);
        return false;
      }
    })();

    for (const lead of leadsToSaveBackend) {
      leadPatchRollbackRef.current.set(lead.id, null);
      leadPatchQueuesRef.current.set(lead.id, bulkOperation);
    }
    void bulkOperation.finally(() => {
      for (const lead of leadsToSaveBackend) {
        if (leadPatchQueuesRef.current.get(lead.id) === bulkOperation) {
          leadPatchQueuesRef.current.delete(lead.id);
          leadPatchRollbackRef.current.delete(lead.id);
        }
      }
    });

    const didPersist = await bulkOperation;
    if (!didPersist) {
      throw bulkError instanceof Error
        ? bulkError
        : new Error('Failed to save bulk leads to the CRM.');
    }
    return { addedCount: leadsToSaveBackend.length, skippedCount };
  }, [restoreLeadSubset, saveLeadsToStorage]);

  // 5. Update pipeline stage for CRM Lead
  const handleUpdateLeadStage = useCallback(async (leadId: string, stage: Lead['stage']) => {
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId) ?? null;
    let updatedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => 
      currentLeads.map(l => {
        if (l.id === leadId) {
          updatedLead = { ...l, stage };
          return updatedLead;
        }
        return l;
      })
    );

    if (updatedLead) {
      const didPersist = await reconcileLeadPatch(updatedLead, rollbackLead);
      if (!didPersist) {
        throw new Error('The pipeline stage could not be saved.');
      }
    }
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  // 6. Update internal notes for a lead
  const handleUpdateLeadNotes = useCallback(async (leadId: string, notes: string) => {
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId) ?? null;
    let updatedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => 
      currentLeads.map(l => {
        if (l.id === leadId) {
          updatedLead = { ...l, notes };
          return updatedLead;
        }
        return l;
      })
    );

    if (updatedLead) {
      const didPersist = await reconcileLeadPatch(updatedLead, rollbackLead);
      if (!didPersist) {
        throw new Error('Notes could not be saved to the CRM.');
      }
    }
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  const handleUpdateLeadFields = useCallback(async (
    leadId: string,
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId) ?? null;
    let updatedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => currentLeads.map(lead => {
      if (lead.id !== leadId) return lead;
      updatedLead = { ...lead, ...updates };
      return updatedLead;
    }));
    if (!updatedLead) return;
    const didPersist = await reconcileLeadPatch(updatedLead, rollbackLead);
    if (!didPersist) throw new Error('The prospect workflow could not be saved.');
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  const handleUpdateLeadsFields = useCallback(async (
    leadIds: string[],
    updates: { reviewStatus?: ReviewStatus; nextAction?: NextAction },
  ) => {
    await Promise.all(leadIds.map(leadId => handleUpdateLeadFields(leadId, updates)));
    return { updatedCount: leadIds.length };
  }, [handleUpdateLeadFields]);

  const handleUpdateLeadProfile = useCallback((leadId: string, profileUpdates: Partial<LinkedInProfile>) => {
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId) ?? null;
    let updatedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => 
      currentLeads.map(l => {
        if (l.id === leadId) {
          updatedLead = {
            ...l,
            profile: { ...l.profile, ...profileUpdates },
            notes: 'Profile dynamically enriched and verified by background AI pipeline.',
            lastEnrichedAt: new Date().toISOString()
          };
          return updatedLead;
        }
        return l;
      })
    );

    if (updatedLead) {
      void reconcileLeadPatch(updatedLead, rollbackLead);
    }
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  const handleMergeLead = useCallback((updatedLead: Lead) => {
    if (!updatedLead || !updatedLead.id) return;
    const hasPendingMutation = leadPatchQueuesRef.current.has(updatedLead.id);
    const currentLocalLead = leadsRef.current.find(lead => lead.id === updatedLead.id);
    const canonicalLead = preferNewerCanonical(
      updatedLead,
      hasPendingMutation
        ? leadPatchRollbackRef.current.get(updatedLead.id)
        : currentLocalLead,
    );
    if (hasPendingMutation) {
      leadPatchRollbackRef.current.set(updatedLead.id, canonicalLead);
    }
    saveLeadsToStorage(currentLeads => currentLeads.map(lead => {
      if (lead.id !== updatedLead.id) return lead;
      return hasPendingMutation
        ? { ...canonicalLead, ...lead, revision: canonicalLead.revision }
        : canonicalLead;
    }));
  }, [saveLeadsToStorage]);

  const handleServerMergeLead = useCallback(async (winnerId: string, duplicateId: string): Promise<void> => {
    await Promise.all(
      [winnerId, duplicateId]
        .map(id => leadPatchQueuesRef.current.get(id))
        .filter((operation): operation is Promise<boolean> => Boolean(operation)),
    );
    const affectedIds = new Set([winnerId, duplicateId]);
    const rollbackLeads = leadsRef.current.filter(lead => affectedIds.has(lead.id));
    saveLeadsToStorage(currentLeads => currentLeads.filter(l => l.id !== duplicateId));

    try {
      const response = await fetch(`/api/leads/${winnerId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicateId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Merge failed: ${response.status}`);
      }
      if (data.lead) {
        saveLeadsToStorage(currentLeads =>
          currentLeads.map(l => (l.id === winnerId ? (data.lead as Lead) : l))
        );
      }
    } catch (err) {
      console.error('[App] Lead merge failed:', err);
      restoreLeadSubset(affectedIds, rollbackLeads);
      throw err;
    }
  }, [restoreLeadSubset, saveLeadsToStorage]);

  // 7. Update custom tags for a lead
  const handleUpdateLeadTags = useCallback(async (leadId: string, tags: string[]) => {
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId) ?? null;
    let updatedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => 
      currentLeads.map(l => {
        if (l.id === leadId) {
          updatedLead = { ...l, tags };
          return updatedLead;
        }
        return l;
      })
    );

    if (updatedLead) {
      const didPersist = await reconcileLeadPatch(updatedLead, rollbackLead);
      if (!didPersist) {
        throw new Error('The lead tags could not be saved.');
      }
    }
  }, [reconcileLeadPatch, saveLeadsToStorage]);

  // 8. Delete lead or leads permanently
  const handleDeleteLead = useCallback(async (leadId: string) => {
    const pendingPatch = leadPatchQueuesRef.current.get(leadId);
    if (pendingPatch) await pendingPatch;
    const rollbackLead = leadsRef.current.find(lead => lead.id === leadId);
    try {
      saveLeadsToStorage(currentLeads => {
        return currentLeads.filter(l => l.id !== leadId);
      });

      const response = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Failed to delete lead: ${response.status}`);
      }
    } catch (e) {
      console.error(`[App] Error during lead deletion:`, e);
      restoreLeadSubset(new Set([leadId]), rollbackLead ? [rollbackLead] : []);
      throw e;
    }
  }, [restoreLeadSubset, saveLeadsToStorage]);

  const handleDeleteLeads = useCallback(async (leadIds: string[]) => {
    await Promise.all(
      leadIds
        .map(id => leadPatchQueuesRef.current.get(id))
        .filter((operation): operation is Promise<boolean> => Boolean(operation)),
    );
    const idSet = new Set(leadIds);
    let rollbackLeads = leadsRef.current.filter(lead => idSet.has(lead.id));
    try {
      saveLeadsToStorage(currentLeads => {
        return currentLeads.filter(l => !idSet.has(l.id));
      });

        const response = await fetch('/api/leads', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: leadIds })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Failed to delete bulk leads: ${response.status}`);
        }
    } catch (e) {
      console.error(`[App] Error during bulk lead deletion:`, e);
      restoreLeadSubset(idSet, rollbackLeads);
      throw e;
    }
  }, [restoreLeadSubset, saveLeadsToStorage]);

  const handleUpdateLeadsStage = useCallback(async (leadIds: string[], stage: Lead['stage']) => {
    await Promise.all(
      leadIds
        .map(id => leadPatchQueuesRef.current.get(id))
        .filter((operation): operation is Promise<boolean> => Boolean(operation)),
    );
    const idSet = new Set(leadIds);
    let rollbackLeads = leadsRef.current.filter(lead => idSet.has(lead.id));
    let updatedLeads: Lead[] = [];
    saveLeadsToStorage(currentLeads => {
      return currentLeads.map(l => {
        if (idSet.has(l.id)) {
          const updated = { ...l, stage };
          updatedLeads.push(updated);
          return updated;
        }
        return l;
      });
    });

    if (updatedLeads.length === 0) return { updatedCount: 0, removedCount: 0 };

    let operationError: unknown;
    let updatedCount = updatedLeads.length;
    let removedCount = 0;
    let bulkStageOperation!: Promise<boolean>;
    bulkStageOperation = (async () => {
      try {
        const persistStageBatch = async (batch: Lead[]) => {
          const response = await fetch('/api/leads/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leads: batch, requireExisting: true })
          });
          const data = await response.json().catch(() => ({}));
          return { response, data };
        };

        let leadsToPersist = updatedLeads;
        let { response, data } = await persistStageBatch(leadsToPersist);
        if (response.status === 409) {
          const latestStore = await loadLeadsFromSqliteBackend();
          const latestById = new Map(latestStore.leads.map(lead => [lead.id, lead]));
          rollbackLeads = leadIds
            .map(leadId => latestById.get(leadId))
            .filter((lead): lead is Lead => Boolean(lead));
          leadsToPersist = rollbackLeads.map(lead => ({ ...lead, stage }));
          removedCount = updatedLeads.length - leadsToPersist.length;
          if (leadsToPersist.length === 0) {
            updatedCount = 0;
            restoreLeadSubset(idSet, []);
            return true;
          }
          ({ response, data } = await persistStageBatch(leadsToPersist));
        }
        if (!response.ok) {
          throw new Error(data.error || `Failed to bulk update stages: ${response.status}`);
        }
        const returnedLeads = Array.isArray(data.leads) ? data.leads as Lead[] : [];
        const returnedById = new Map(returnedLeads.map(lead => [lead.id, lead]));
        const canonicalLeads = leadsToPersist.map(
          lead => returnedById.get(lead.id) ?? lead,
        );
        updatedCount = canonicalLeads.length;
        const serverLeads = new Map(canonicalLeads.map(lead => [
          lead.id,
          preferNewerCanonical(lead, leadPatchRollbackRef.current.get(lead.id)),
        ]));
        for (const [leadId, canonicalLead] of serverLeads) {
          if (leadPatchQueuesRef.current.get(leadId) !== bulkStageOperation) {
            leadPatchRollbackRef.current.set(leadId, canonicalLead);
          }
        }
        saveLeadsToStorage(currentLeads => currentLeads.flatMap(lead => {
          if (idSet.has(lead.id) && !serverLeads.has(lead.id)) return [];
          const canonicalLead = serverLeads.get(lead.id);
          if (!canonicalLead) return [lead];
          return [leadPatchQueuesRef.current.get(lead.id) === bulkStageOperation
            ? canonicalLead
            : { ...canonicalLead, ...lead, revision: canonicalLead.revision }];
        }));
        return true;
      } catch (error) {
        operationError = error;
        console.error('Failed to sync bulk stage updates to backend:', error);
        try {
          const latestStore = await loadLeadsFromSqliteBackend();
          rollbackLeads = latestStore.leads.filter(lead => idSet.has(lead.id));
        } catch {
          // Fall back to the last known stable subset if canonical refresh fails.
        }
        restoreLeadSubset(idSet, rollbackLeads);
        return false;
      }
    })();

    for (const rollbackLead of rollbackLeads) {
      leadPatchRollbackRef.current.set(rollbackLead.id, rollbackLead);
      leadPatchQueuesRef.current.set(rollbackLead.id, bulkStageOperation);
    }
    void bulkStageOperation.finally(() => {
      for (const leadId of idSet) {
        if (leadPatchQueuesRef.current.get(leadId) === bulkStageOperation) {
          leadPatchQueuesRef.current.delete(leadId);
          leadPatchRollbackRef.current.delete(leadId);
        }
      }
    });

    const didPersist = await bulkStageOperation;
    if (!didPersist) {
      throw operationError instanceof Error
        ? operationError
        : new Error('Failed to update selected prospect stages.');
    }
    return { updatedCount, removedCount };
  }, [restoreLeadSubset, saveLeadsToStorage]);

  const contextValue = useMemo<LeadContextType>(() => ({
    leads,
    isHydrated,
    saveLeadsToStorage,
    rehydrateLeads,
    handleLeadAdded,
    handleBulkLeadsAdded,
    handleUpdateLeadStage,
    handleUpdateLeadNotes,
    handleUpdateLeadFields,
    handleUpdateLeadsFields,
    handleUpdateLeadProfile,
    handleMergeLead,
    handleServerMergeLead,
    handleUpdateLeadTags,
    handleDeleteLead,
    handleDeleteLeads,
    handleUpdateLeadsStage,
  }), [
    handleBulkLeadsAdded,
    handleDeleteLead,
    handleDeleteLeads,
    handleLeadAdded,
    handleMergeLead,
    handleServerMergeLead,
    handleUpdateLeadNotes,
    handleUpdateLeadFields,
    handleUpdateLeadsFields,
    handleUpdateLeadProfile,
    handleUpdateLeadStage,
    handleUpdateLeadTags,
    handleUpdateLeadsStage,
    isHydrated,
    leads,
    rehydrateLeads,
    saveLeadsToStorage,
  ]);

  return (
    <LeadContext.Provider value={contextValue}>
      {children}
    </LeadContext.Provider>
  );
}

export function useLeads() {
  const context = useContext(LeadContext);
  if (context === undefined) {
    throw new Error('useLeads must be used within a LeadProvider');
  }
  return context;
}


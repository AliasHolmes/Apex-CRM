/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LeadProvider, useLeads } from './context/LeadContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { ThemeProvider } from './context/ThemeContext';
import { ThemeToggle } from './components/ThemeToggle';
import { ApexLogo } from './components/ApexLogo';
import { HeaderSearch } from './components/HeaderSearch';
import { PageHeader } from './components/PageHeader';
import { Skeleton } from './components/ui/skeleton';
import type { ProspectPreset } from './components/LeadTable';
import type { ProspectFilters } from './lib/prospectViews';
import { IconProvider, NAV_ICONS } from './components/icons';
import { motion, useReducedMotion } from 'motion/react';
import { 
  Plus, 
  BotMessageSquare,
  type LucideIcon
} from 'lucide-react';
import { LinkedInProfile, Lead } from './types';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DASHBOARD_NAV_ITEMS,
  getHashForLead,
  getHashForTab,
  getLeadIdFromHash,
  getTabFromHash,
  type DashboardTab,
} from './lib/navigation';
import { DEFAULT_MANUAL_INDUSTRY, MANUAL_PROSPECT_INDUSTRIES } from './lib/ui';
import { buildProfileDedupeKeys } from './utils/leadDedupe';

// Large workspaces load only when the user opens their tab.
const ScrapeWorkspace = lazy(() => import('./components/ScrapeWorkspace'));
const CrmPipeline = lazy(() => import('./components/CrmPipeline'));
const LeadTable = lazy(() => import('./components/LeadTable'));
const OutreachStudio = lazy(() => import('./components/OutreachStudio'));
const CrmOverview = lazy(() => import('./components/CrmOverview'));
const CrmCopilot = lazy(() => import('./components/CrmCopilot'));
const LeadDrawer = lazy(() => import('./components/LeadDrawer'));
import TabErrorBoundary from './components/TabErrorBoundary';

// ScrapeWorkspace marks a running discovery in sessionStorage. If the page is
// force-reloaded (e.g. the Vite dev-server HMR client's websocket-drop reload),
// this marker re-mounts the workspace so its mount effect can re-attach to the
// still-running server-side mining session. See docs/adr/0010-dev-server-hmr-reload-containment.md.
const ACTIVE_SESSION_STORAGE_KEY = 'apex-active-mining-session-id';
const MOUNTED_JOB_TABS_STORAGE_KEY = 'apex-mounted-job-tabs';
const JOB_TABS: readonly DashboardTab[] = ['workspace', 'inventory', 'outreach'];

const hasActiveMiningSessionMarker = (): boolean => {
  try {
    return Boolean(sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY));
  } catch {
    return false;
  }
};

const readPersistedJobTabs = (): DashboardTab[] => {
  try {
    const raw = sessionStorage.getItem(MOUNTED_JOB_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tab): tab is DashboardTab =>
      JOB_TABS.includes(tab as DashboardTab),
    );
  } catch {
    return [];
  }
};

interface NavigationItem {
  id: DashboardTab;
  hash: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavigationItem[] = DASHBOARD_NAV_ITEMS.map(item => ({
  ...item,
  icon: NAV_ICONS[item.id],
}));


class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Apex CRM render failure:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="min-h-screen bg-background px-6 py-16 text-foreground">
          <section className="mx-auto max-w-xl rounded-xl border border-danger/30 bg-card p-6 shadow-2xl">
            <p className="text-sm font-semibold text-danger">Apex CRM could not render this workspace.</p>
            <p className="mt-2 text-sm text-foreground/80">
              Reload the app to recover. If this repeats, the browser console contains the underlying error.
            </p>
            <button
              type="button"
              className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={() => window.location.reload()}
            >
              Reload Apex CRM
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

const TabLoading = () => (
  <div className="space-y-4" role="status" aria-busy="true">
    <span className="sr-only">Loading workspace</span>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
    <Skeleton className="h-72 rounded-xl" />
  </div>
);

const AppShellLoading = () => (
  <div className="min-h-screen bg-background text-foreground" aria-busy="true">
    <header className="border-b border-border bg-background/80 px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-16" />
          </div>
        </div>
        <div className="hidden gap-2 lg:flex">
          {NAV_ITEMS.map(item => (
            <Skeleton key={item.id} className="h-9 w-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
    </header>
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8" role="status">
      <span className="sr-only">Loading CRM data</span>
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </main>
  </div>
);

import { predictiveScoreFromComposite, scoreLeadDeterministically } from './utils/leadScore';

function Dashboard() {
  const {
    leads,
    stats,
    isHydrated,
    refreshStats,
    handleBulkLeadsAdded,
    handleUpdateLeadStage,
  } = useLeads();
  const { triggerToast } = useToast();
  const shouldReduceMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => getTabFromHash(window.location.hash));
  const [mountedJobTabs, setMountedJobTabs] = useState<Set<DashboardTab>>(() => {
    // A forced dev-server reload must not lose an active mining session: when one
    // is marked as running, (re)mount the workspace so its mount effect re-attaches
    // to the live server-side session (ADR-0010).
    if (hasActiveMiningSessionMarker()) return new Set<DashboardTab>(['workspace']);
    const initialTab = getTabFromHash(window.location.hash);
    const persisted = new Set<DashboardTab>(readPersistedJobTabs());
    if (JOB_TABS.includes(initialTab)) persisted.add(initialTab);
    return persisted;
  });
  const [hasLoadedCopilot, setHasLoadedCopilot] = useState(false);
  const [prospectPreset, setProspectPreset] = useState<ProspectPreset | null>(null);
  const [openLeadId, setOpenLeadId] = useState<string | null>(() => getLeadIdFromHash(window.location.hash));
  const [selectedLeadForOutreach, setSelectedLeadForOutreach] = useState<Lead | null>(null);
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualIndustry, setManualIndustry] = useState<(typeof MANUAL_PROSPECT_INDUSTRIES)[number]>(DEFAULT_MANUAL_INDUSTRY);
  const [manualSummary, setManualSummary] = useState('');
  const [isSavingManualLead, setIsSavingManualLead] = useState(false);

  const navigateToTab = useCallback((tab: DashboardTab) => {
    setActiveTab(tab);
    setOpenLeadId(null);
    const nextHash = getHashForTab(tab);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }, []);

  // The shared lead drawer is addressable: #prospects/<leadId> reopens it after a reload.
  const openLead = useCallback((leadId: string) => {
    setOpenLeadId(leadId);
    const nextHash = getHashForLead(getTabFromHash(window.location.hash), leadId);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }, []);

  const closeLead = useCallback(() => {
    setOpenLeadId(null);
    const tabHash = getHashForTab(getTabFromHash(window.location.hash));
    if (window.location.hash !== tabHash) {
      window.history.replaceState(null, '', tabHash);
    }
  }, []);

  useEffect(() => {
    const syncTabFromLocation = () => {
      setActiveTab(getTabFromHash(window.location.hash));
      setOpenLeadId(getLeadIdFromHash(window.location.hash));
    };
    if (!window.location.hash) {
      window.history.replaceState(null, '', getHashForTab('overview'));
    }
    window.addEventListener('hashchange', syncTabFromLocation);
    window.addEventListener('popstate', syncTabFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncTabFromLocation);
      window.removeEventListener('popstate', syncTabFromLocation);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'workspace' && activeTab !== 'inventory' && activeTab !== 'outreach') return;
    setMountedJobTabs((currentTabs) => {
      if (currentTabs.has(activeTab)) return currentTabs;
      const nextTabs = new Set(currentTabs);
      nextTabs.add(activeTab);
      return nextTabs;
    });
  }, [activeTab]);

  // Keep the mounted job tabs across forced reloads (see ADR-0010): a reload
  // that detaches the workspace would drop live trace state and in-flight drafts.
  useEffect(() => {
    try {
      sessionStorage.setItem(MOUNTED_JOB_TABS_STORAGE_KEY, JSON.stringify([...mountedJobTabs]));
    } catch {
      // sessionStorage unavailable - mounted-tab restoration is best-effort.
    }
  }, [mountedJobTabs]);

  // Mount-only: if a discovery session is running after a forced reload, bring the
  // user straight back to the workspace with the live trace instead of leaving them
  // on the hash tab watching a detached UI. Deliberately not keyed on activeTab so
  // navigating away mid-session is never yanked back.
  useEffect(() => {
    if (!hasActiveMiningSessionMarker()) return;
    if (getTabFromHash(window.location.hash) === 'workspace') return;
    navigateToTab('workspace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [activeTab, refreshStats]);

  const resetManualForm = useCallback(() => {
    setManualName('');
    setManualTitle('');
    setManualCompany('');
    setManualEmail('');
    setManualUrl('');
    setManualIndustry(DEFAULT_MANUAL_INDUSTRY);
    setManualSummary('');
  }, []);

  const handleManualLeadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fullName = manualName.trim();
    if (!fullName || isSavingManualLead) return;

    const companyName = manualCompany.trim() || 'Independent';
    const candidateKeys = buildProfileDedupeKeys({
      fullName,
      currentCompany: companyName,
      contactDetails: {
        email: manualEmail,
        linkedinUrl: manualUrl,
      },
    });

    const duplicateLead = leads.find(lead => {
      const leadKeys = buildProfileDedupeKeys(lead.profile || lead);
      for (const k of candidateKeys) {
        if (leadKeys.has(k)) return true;
      }
      return false;
    });

    if (duplicateLead) {
      triggerToast(`${duplicateLead.profile.fullName} is already in Prospects.`, 'info');
      return;
    }

    const newProfile: LinkedInProfile = {
      id: `manual-profile-${crypto.randomUUID()}`,
      fullName,
      headline: manualTitle.trim() ? `${manualTitle.trim()} @ ${companyName}` : `Professional @ ${companyName}`,
      currentCompany: companyName,
      currentTitle: manualTitle.trim() || 'Professional',
      location: 'Undisclosed Location',
      industry: manualIndustry,
      summary: 'Manually added prospect.',
      contactDetails: {
        email: manualEmail.trim() || undefined,
        linkedinUrl: manualUrl.trim() || undefined
      },
      experiences: manualTitle.trim() ? [{ title: manualTitle.trim(), company: companyName }] : []
    };

    const compositeScore = scoreLeadDeterministically(newProfile);
    const predictiveScore = predictiveScoreFromComposite(compositeScore);
    const newLead: Lead = {
      id: `lead-manual-${crypto.randomUUID()}`,
      profile: newProfile,
      stage: 'SCRAPED',
      notes: manualSummary.trim() || 'Manually added contact.',
      createdAt: new Date().toISOString(),
      tags: ['Manual Entry', manualIndustry],
      compositeScore,
      predictiveScore,
      qualificationScore: predictiveScore
    };

    setIsSavingManualLead(true);
    try {
      const result = await handleBulkLeadsAdded([newLead]);
      if (result.addedCount === 0) {
        triggerToast(`${fullName} is already in Prospects.`, 'info');
        return;
      }
      resetManualForm();
      setShowManualModal(false);
      triggerToast(`${fullName} was added to Prospects.`, 'success');
    } catch (error) {
      console.error('Failed to add manual lead:', error);
      triggerToast('Could not save this prospect. Please try again.', 'error');
    } finally {
      setIsSavingManualLead(false);
    }
  };

  const handleViewProspects = useCallback((filters: Partial<ProspectFilters>) => {
    setProspectPreset({ nonce: Date.now(), filters });
    navigateToTab('inventory');
  }, [navigateToTab]);

  const handleSelectLeadForOutreach = useCallback((lead: Lead) => {
    setSelectedLeadForOutreach(lead);
    navigateToTab('outreach');
  }, [navigateToTab]);

  if (!isHydrated) {
    return <AppShellLoading />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex flex-col justify-between selection:bg-primary/30 selection:text-foreground">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only z-[70] rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to workspace
      </a>

      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-[72px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ApexLogo className="h-10 w-10 shadow-sm rounded-xl" />
            <div>
              <h1 className="font-extrabold text-foreground text-sm tracking-tight">
                Apex CRM
              </h1>
              <Badge variant="secondary" className="mt-0.5 text-xs font-bold">
                {stats.total} prospect{stats.total === 1 ? '' : 's'}
              </Badge>
            </div>
          </div>

          <nav className="hidden lg:flex items-center gap-1.5" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isSelected = activeTab === item.id;
              return (
                <Button
                  key={item.id}
                  id={`nav-${item.id}`}
                  type="button"
                  variant={isSelected ? "secondary" : "ghost"}
                  onClick={() => navigateToTab(item.id)}
                  aria-current={isSelected ? 'page' : undefined}
                  aria-label={item.label}
                  title={item.label}
                  className="flex items-center gap-2 h-9 px-3"
                >
                  <Icon className={`w-4 h-4 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                  <span className="hidden xl:inline">{item.label}</span>
                </Button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <HeaderSearch leads={leads} onOpenLead={openLead} />
            <ThemeToggle />
            <Button type="button" size="sm" onClick={() => setShowManualModal(true)}>
              <Plus className="w-4 h-4 mr-1.5" aria-hidden="true" />
              Add prospect
            </Button>
          </div>
        </div>

        <nav
          className="lg:hidden border-t border-border/80 bg-background/60 backdrop-blur-md px-4 py-2 flex gap-1.5 overflow-x-auto select-none"
          aria-label="Mobile navigation"
        >
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const isSelected = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateToTab(item.id)}
                aria-current={isSelected ? 'page' : undefined}
                className={`px-3 py-2 rounded-lg text-xs font-bold shrink-0 transition-colors flex items-center gap-1.5 cursor-pointer border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary shadow-md'
                    : 'bg-card/40 border-border/60 text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10 focus:outline-none">
            {(activeTab === 'workspace' || mountedJobTabs.has('workspace')) && (
              <motion.section
                key="tab-workspace"
                hidden={activeTab !== 'workspace'}
                aria-labelledby="discover-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <PageHeader
                  id="discover-heading"
                  title="Discover prospects"
                  description="Find qualified people, review the evidence, then add only the prospects you want to enrich."
                />
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Discover prospects">
                    <ScrapeWorkspace />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
            {activeTab === 'overview' && (
              <motion.section
                key="tab-overview"
                aria-labelledby="overview-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="CRM overview">
                    <CrmOverview
                      leads={leads}
                      stats={stats}
                      onNavigate={navigateToTab}
                      onOpenLead={openLead}
                      onViewProspects={handleViewProspects}
                      onAddProspect={() => setShowManualModal(true)}
                    />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
            {activeTab === 'pipeline' && (
              <motion.section
                key="tab-pipeline"
                aria-labelledby="pipeline-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <PageHeader
                  id="pipeline-heading"
                  title="Pipeline"
                  description="Drag prospects between stages, or open one to review, reach out, and follow up without losing context."
                />
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Pipeline">
                    <CrmPipeline
                      leads={leads}
                      onUpdateLeadStage={handleUpdateLeadStage}
                      onOpenLead={openLead}
                      onSelectLeadForOutreach={handleSelectLeadForOutreach}
                    />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}

            {(activeTab === 'inventory' || mountedJobTabs.has('inventory')) && (
              <motion.section
                key="tab-inventory"
                hidden={activeTab !== 'inventory'}
                aria-label="Prospect inventory"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <PageHeader
                  id="prospects-heading"
                  title="Prospects"
                  description="Review saved contacts, enrich selected records, and move them into the right pipeline stage."
                />
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Prospect inventory">
                    <LeadTable onAddManualLead={() => setShowManualModal(true)} onOpenLead={openLead} preset={prospectPreset} />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}

            {(activeTab === 'outreach' || mountedJobTabs.has('outreach')) && (
              <motion.section
                key="tab-outreach"
                hidden={activeTab !== 'outreach'}
                aria-labelledby="outreach-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <PageHeader
                  id="outreach-heading"
                  title="Outreach"
                  description="Draft personalized messages from the prospect and account evidence already in your CRM."
                />
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Outreach">
                    <OutreachStudio
                      selectedLeadForOutreach={selectedLeadForOutreach}
                      leads={leads}
                    />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
      </main>

      {openLeadId && (
        <Suspense fallback={null}>
          <LeadDrawer leadId={openLeadId} onClose={closeLead} onOpenOutreach={handleSelectLeadForOutreach} />
        </Suspense>
      )}

      {hasLoadedCopilot ? (
        <Suspense
          fallback={(
            <div className="fixed bottom-5 right-5 z-50 grid h-14 w-14 place-items-center rounded-2xl border border-primary/30 bg-primary text-primary-foreground" role="status">
              <span className="sr-only">Loading Apex Copilot</span>
              <BotMessageSquare className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
        >
          <TabErrorBoundary tabName="Apex Copilot">
            <CrmCopilot defaultOpen leads={leads} onOpenLead={openLead} />
          </TabErrorBoundary>
        </Suspense>
      ) : (
        <button
          type="button"
          onClick={() => setHasLoadedCopilot(true)}
          aria-label="Open Apex Copilot"
          className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-xl shadow-primary/40 transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          <BotMessageSquare className="h-6 w-6" aria-hidden="true" />
        </button>
      )}

      <Dialog
        open={showManualModal}
        onOpenChange={(open) => {
          setShowManualModal(open);
          if (!open && !isSavingManualLead) resetManualForm();
        }}
      >
        <DialogContent className="max-w-lg bg-card border-border text-foreground">
          <DialogHeader className="border-b border-border pb-4">
            <DialogTitle>Add a prospect</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Save a contact you already know. Name is required; email and LinkedIn URL improve duplicate detection.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleManualLeadSubmit} aria-busy={isSavingManualLead} className="space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar pr-2 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="manual-name" className="text-foreground/80">Full name</Label>
                <Input
                  id="manual-name"
                  type="text"
                  required
                  autoComplete="name"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="e.g. John Smith"
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-industry" className="text-foreground/80">Industry</Label>
                <Select
                  value={manualIndustry}
                  onValueChange={(val) => setManualIndustry(val as (typeof MANUAL_PROSPECT_INDUSTRIES)[number])}
                >
                  <SelectTrigger id="manual-industry" className="w-full bg-background border border-border">
                    <SelectValue placeholder="Select industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {MANUAL_PROSPECT_INDUSTRIES.map(industry => (
                      <SelectItem key={industry} value={industry}>{industry}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="manual-title" className="text-foreground/80">Current job title</Label>
                <Input
                  id="manual-title"
                  type="text"
                  autoComplete="organization-title"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="e.g. Managing Director"
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-company" className="text-foreground/80">Company name</Label>
                <Input
                  id="manual-company"
                  type="text"
                  autoComplete="organization"
                  value={manualCompany}
                  onChange={(e) => setManualCompany(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="bg-background border-border"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-email" className="text-foreground/80">Contact email</Label>
              <Input
                id="manual-email"
                type="email"
                autoComplete="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                placeholder="e.g. jsmith@acme.com"
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-linkedin" className="text-foreground/80">LinkedIn profile URL</Label>
              <Input
                id="manual-linkedin"
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="e.g. https://linkedin.com/in/johnsmith"
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-summary" className="text-foreground/80">Notes</Label>
              <Textarea
                id="manual-summary"
                value={manualSummary}
                onChange={(e) => setManualSummary(e.target.value)}
                placeholder="Add useful context for review or outreach..."
                rows={3}
                className="bg-background border-border resize-y"
              />
            </div>

            <DialogFooter className="pt-4 border-t border-border">
              <Button
                type="button"
                variant="outline"
                disabled={isSavingManualLead}
                onClick={() => {
                  resetManualForm();
                  setShowManualModal(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSavingManualLead || !manualName.trim()}>
                {isSavingManualLead ? 'Saving...' : 'Add prospect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <IconProvider>
          <ToastProvider>
            <LeadProvider>
              <Dashboard />
            </LeadProvider>
          </ToastProvider>
        </IconProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}

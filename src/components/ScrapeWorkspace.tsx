/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useToast } from '../context/ToastContext';
import { useLeads } from '../context/LeadContext';
import { isDiscoveryProviderConfigured } from '@/lib/ui';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { 
  Globe, 
  Clipboard, 
  Search, 
  Sparkles, 
  Check, 
  AlertCircle, 
  Info,
  RefreshCw, 
  Database,
  History,
  Save,
  SlidersHorizontal,
  ChevronDown
} from 'lucide-react';
import { ScrapingTask, SearchLog, MiningTraceEvent, MiningTraceSummary, ProviderSummary } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const DebugLogsViewer = ({ debugLogsStr }: { debugLogsStr?: string }) => {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

  if (!debugLogsStr) return null;
  
  let events: any[] = [];
  try {
    events = JSON.parse(debugLogsStr);
  } catch {
    return <div className="text-xs text-rose-400 mt-2">Failed to parse debug logs.</div>;
  }

  if (events.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-800/50">
      <Button 
        variant="ghost" 
        size="sm" 
        onClick={() => setExpanded(!expanded)} 
        aria-expanded={expanded}
        aria-controls={panelId}
        className="text-xs text-indigo-400 hover:text-indigo-300 p-0 h-auto gap-1"
      >
        {expanded ? 'Hide' : 'Show'} technical details ({events.length})
      </Button>
      
      {expanded && (
        <div id={panelId} className="mt-2 space-y-2 max-h-96 overflow-y-auto custom-scrollbar p-2 bg-slate-950/50 rounded border border-slate-800/80">
          {events.map((ev, idx) => (
            <div key={idx} className="text-xs border-b border-slate-900 last:border-0 pb-2 mb-2 last:pb-0 last:mb-0">
              <div className="flex items-center justify-between text-slate-500 font-mono text-xs">
                <span>{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}</span>
                <span className="uppercase font-semibold text-indigo-400/80">{ev.type}</span>
              </div>
              <div className="font-semibold text-slate-300 mt-0.5">{ev.label || ev.query || ev.url}</div>
              
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setExpandedEvent(expandedEvent === idx ? null : idx)}
                aria-expanded={expandedEvent === idx}
                aria-controls={`${panelId}-${idx}`}
                className="text-xs text-slate-400 hover:text-slate-200 p-0 h-auto mt-1"
              >
                {expandedEvent === idx ? 'Collapse details' : 'Expand details'}
              </Button>
              
              {expandedEvent === idx && (
                <pre id={`${panelId}-${idx}`} className="text-xs text-slate-300 font-mono bg-slate-950 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap max-h-64 border border-slate-800">
                  {JSON.stringify(ev, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const formatDuration = (ms?: number) => {
  if (!ms || ms < 0) return '0s';
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
};

const DETAILED_SEARCH_EXAMPLE = `Job titles: Founder, CEO, Owner, COO, Head of Growth
Industries: Marketing agencies, home services, dental practices
Company size: 5-75 employees
Locations: United States, United Kingdom, Canada, Australia, UAE
Signals: Posted publicly in the last 30 days
Priority: Owners at growing service businesses`;

const TraceSummaryViewer = ({ traceSummary, traceEvents = [] }: { traceSummary?: MiningTraceSummary; traceEvents?: MiningTraceEvent[] }) => {
  const providerSummary: ProviderSummary = traceSummary?.providerSummary || {};
  const providers = Object.entries(providerSummary).filter(([, item]) => item.calls > 0 || item.failures > 0 || item.skipped > 0);
  const phases = traceSummary?.phaseTimeline || [];
  const cost = traceSummary?.costSummary;
  const recent = traceEvents.slice(-6).reverse();
  if (!traceSummary && traceEvents.length === 0) return null;
  return (
    <div className="mt-3 space-y-3 border-t border-slate-800/60 pt-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-xs uppercase text-slate-500 font-bold">Events</div><div className="text-sm text-slate-200 font-semibold">{traceSummary?.eventCount ?? traceEvents.length}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-xs uppercase text-slate-500 font-bold">Model tokens</div><div className="text-sm text-indigo-300 font-semibold">{cost?.totalTokens?.toLocaleString?.() || 0}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-xs uppercase text-slate-500 font-bold">Est. Cost</div><div className="text-sm text-emerald-300 font-semibold">${(cost?.estimatedUsd || 0).toFixed(4)}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-xs uppercase text-slate-500 font-bold">Cost / Lead</div><div className="text-sm text-slate-200 font-semibold">${(cost?.costPerAcceptedLead || 0).toFixed(4)}</div></div>
      </div>
      {providers.length > 0 && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{providers.map(([provider, item]) => (<div key={provider} className="bg-slate-950/50 border border-slate-800 rounded-md p-2 text-xs"><div className="flex items-center justify-between mb-1"><span className="uppercase font-bold text-slate-300">{provider}</span><span className="text-slate-500">avg {formatDuration(item.avgLatencyMs)}</span></div><div className="flex gap-3 text-xs text-slate-400"><span>{item.calls} calls</span><span className="text-emerald-400">{item.successes} ok</span><span className="text-rose-400">{item.failures} fail</span>{item.totalTokens > 0 && <span className="text-indigo-300">{item.totalTokens.toLocaleString()} tok</span>}</div></div>))}</div>}
      {phases.length > 0 && <div className="flex flex-wrap gap-1.5">{phases.map(phase => (<span key={phase.phase} className={`px-2 py-1 rounded-md border text-xs font-semibold ${phase.status === 'error' ? 'border-rose-500/30 text-rose-300 bg-rose-500/5' : 'border-slate-700 text-slate-300 bg-slate-950/50'}`}>{phase.phase.replace(/_/g, ' ')} - {phase.events} - {formatDuration(phase.durationMs)}</span>))}</div>}
      {recent.length > 0 && <div className="space-y-1">{recent.map(event => (<div key={event.id} className="text-xs text-slate-400 font-mono bg-slate-950/40 border border-slate-800 rounded px-2 py-1 flex justify-between gap-2"><span className="truncate">{event.phase}/{event.operation}{event.query ? ` - ${event.query}` : ''}</span><span className={event.status === 'error' ? 'text-rose-400' : event.status === 'success' ? 'text-emerald-400' : 'text-slate-500'}>{event.status}</span></div>))}</div>}
    </div>
  );
};
export default function ScrapeWorkspace() {
  const shouldReduceMotion = useReducedMotion();
  const activeDiscoveryRef = useRef<{
    controller: AbortController;
    sessionId: string;
    pollController: AbortController | null;
    pollTimer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const previewRequestRef = useRef<{ controller: AbortController; requestId: number } | null>(null);
  const previewRequestIdRef = useRef(0);
  const { leads, handleLeadAdded, handleBulkLeadsAdded } = useLeads();
  const { triggerToast } = useToast();
  const [activeTab, setActiveTab] = useState<'url' | 'paste' | 'find'>('url');
  const [providerStatus, setProviderStatus] = useState<'checking' | 'ready' | 'missing' | 'offline'>('checking');

  // URL Mode inputs
  const [urlInput, setUrlInput] = useState('');
  // Paste Mode inputs
  const [pastedText, setPastedText] = useState('');
  // Find Leads inputs
  const [findQuery, setFindQuery] = useState('');
  const [leadLimit, setLeadLimit] = useState<number>(5);
  const [discoveryMode, setDiscoveryMode] = useState<'person_first' | 'account_first' | 'signal_first' | 'local_business'>('person_first');
  const [maxPerCompany, setMaxPerCompany] = useState(2);
  const [searchSpec, setSearchSpec] = useState<any>(null);
  const [searchPreview, setSearchPreview] = useState<any>(null);
  const [providerCapabilities, setProviderCapabilities] = useState<any>(null);
  const [savedSearches, setSavedSearches] = useState<any[]>([]);
  const [selectedSavedSearchId, setSelectedSavedSearchId] = useState('');
  const [savedSearchName, setSavedSearchName] = useState('');
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [sourceLinks, setSourceLinks] = useState<{ title: string; uri: string }[]>([]);

  // Diagnostic Terminal States for Adaptive Scraping & Nudge Logs
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [liveTraceEvents, setLiveTraceEvents] = useState<MiningTraceEvent[]>([]);
  
  const [showLogs, setShowLogs] = useState(false);
  const [searchLogs, setSearchLogs] = useState<SearchLog[]>([]);
  const [searchLogsLoading, setSearchLogsLoading] = useState(false);
  const [searchLogsError, setSearchLogsError] = useState<string | null>(null);

  useEffect(() => {
    if (!showLogs) return;

    const controller = new AbortController();
    setSearchLogsLoading(true);
    setSearchLogsError(null);
    fetch('/api/search-logs', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Search history returned ${response.status}.`);
        return response.json();
      })
      .then(data => setSearchLogs(Array.isArray(data) ? data : (Array.isArray(data.logs) ? data.logs : [])))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setSearchLogsError('Search history could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchLogsLoading(false);
      });

    return () => controller.abort();
  }, [showLogs]);

  const refreshScoutWorkspace = useCallback(async () => {
    const [capabilitiesResponse, searchesResponse] = await Promise.all([
      fetch('/api/provider-capabilities'),
      fetch('/api/saved-searches')
    ]);
    if (capabilitiesResponse.ok) setProviderCapabilities(await capabilitiesResponse.json());
    if (searchesResponse.ok) {
      const data = await searchesResponse.json();
      setSavedSearches(Array.isArray(data.searches) ? data.searches : []);
    }
  }, []);

  useEffect(() => {
    void refreshScoutWorkspace().catch(() => {});
  }, [refreshScoutWorkspace]);

  // Live logs are handled directly via active status polling during search execution

  useEffect(() => {
    let disposed = false;
    const checkProvider = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error(`Health check returned ${response.status}.`);
        const data = await response.json();
        const hasDiscoveryProvider = isDiscoveryProviderConfigured(data);
        if (!disposed) setProviderStatus(hasDiscoveryProvider ? 'ready' : 'missing');
      } catch {
        if (!disposed) setProviderStatus('offline');
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkProvider();
    };

    void checkProvider();
    const interval = window.setInterval(() => void checkProvider(), 45_000);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
  const [tasks, setTasks] = useState<ScrapingTask[]>([]);

  useEffect(() => () => {
    previewRequestIdRef.current += 1;
    previewRequestRef.current?.controller.abort();
    previewRequestRef.current = null;

    const activeDiscovery = activeDiscoveryRef.current;
    if (!activeDiscovery) return;

    void fetch(`/api/mining-sessions/${activeDiscovery.sessionId}/cancel`, { method: 'POST' })
      .catch(() => undefined);
    if (activeDiscovery.pollTimer) clearTimeout(activeDiscovery.pollTimer);
    activeDiscovery.pollController?.abort();
    activeDiscovery.controller.abort();
    activeDiscoveryRef.current = null;
  }, []);

  const handleTaskAdd = (type: 'url' | 'paste' | 'search', query: string) => {
    const newTask: ScrapingTask = {
      id: `task-${Date.now()}`,
      type,
      query: query.length > 50 ? query.substring(0, 50) + '...' : query,
      status: 'processing',
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [newTask, ...prev]);
    return newTask.id;
  };

  const updateTaskStatus = (taskId: string, status: 'completed' | 'failed' | 'cancelled', resultCount?: number) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, resultCount } : t));
  };

  const cancelPreviewRequest = useCallback(() => {
    previewRequestIdRef.current += 1;
    previewRequestRef.current?.controller.abort();
    previewRequestRef.current = null;
  }, []);

  const updateSearchBrief = useCallback((value: string) => {
    cancelPreviewRequest();
    setFindQuery(value);
    setSearchSpec(null);
    setSearchPreview(null);
    setSelectedSavedSearchId('');
  }, [cancelPreviewRequest]);

  const activeSpec = () => ({
    ...(searchSpec || {}),
    mode: discoveryMode,
    maxPerCompany
  });

  const handlePreviewScout = async () => {
    if (!findQuery.trim() || loading) return;

    cancelPreviewRequest();
    const requestId = previewRequestIdRef.current;
    const controller = new AbortController();
    previewRequestRef.current = { controller, requestId };
    setErrorCode(null);
    setInfoMsg(null);
    try {
      const response = await fetch('/api/lead-search/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: findQuery, discoveryMode, searchSpec: searchSpec ? activeSpec() : undefined }),
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not plan this scout search.');
      if (controller.signal.aborted || previewRequestIdRef.current !== requestId) return;
      setSearchPreview(data);
      setSearchSpec(data.spec);
      setDiscoveryMode(data.spec?.mode || discoveryMode);
      setMaxPerCompany(data.spec?.maxPerCompany || maxPerCompany);
    } catch (error: any) {
      if (error?.name === 'AbortError' || previewRequestIdRef.current !== requestId) return;
      setErrorCode(error.message || 'Could not plan this scout search.');
    } finally {
      if (previewRequestRef.current?.requestId === requestId) {
        previewRequestRef.current = null;
      }
    }
  };

  const handleSaveSearch = async () => {
    if (!findQuery.trim()) return;
    cancelPreviewRequest();
    const name = savedSearchName.trim() || findQuery.trim().slice(0, 72);
    try {
      const response = await fetch('/api/saved-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, query: findQuery, spec: activeSpec() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save this search.');
      setSelectedSavedSearchId(data.search.id);
      setSavedSearchName(data.search.name);
      await refreshScoutWorkspace();
      triggerToast('Scout search saved.');
    } catch (error: any) {
      setErrorCode(error.message || 'Could not save this search.');
    }
  };

  const applySavedSearch = (id: string) => {
    cancelPreviewRequest();
    setSelectedSavedSearchId(id);
    const saved = savedSearches.find((item) => item.id === id);
    if (!saved) return;
    setFindQuery(saved.query || '');
    setSearchSpec(saved.spec || null);
    setDiscoveryMode(saved.mode || saved.spec?.mode || 'person_first');
    setMaxPerCompany(saved.maxPerCompany || saved.spec?.maxPerCompany || 2);
    setSavedSearchName(saved.name || '');
    setSearchPreview(null);
  };

  const handleUseLookalike = (leadId: string) => {
    const seed = leads.find((lead) => lead.id === leadId);
    const profile = seed?.profile;
    if (!profile) return;
    cancelPreviewRequest();
    const title = String(profile.currentTitle || '').trim();
    const company = String(profile.currentCompany || '').trim();
    const location = String(profile.location || '').trim();
    const industry = String((seed as any)?.companyAccount?.industry || profile.industry || '').trim();
    const prompt = `Find prospects similar to ${title || 'the decision maker'}${company ? ` at ${company}` : ''}${industry ? ` in ${industry}` : ''}${location ? ` around ${location}` : ''}.`;
    setFindQuery(prompt);
    setSearchSpec({
      version: 1,
      mode: 'person_first',
      person: { includeTitles: title ? [title] : [], excludeTitles: [], seniorities: [], locations: location ? [location] : [] },
      company: { industries: industry ? [industry] : [], keywords: [company || industry || title].filter(Boolean), locations: location ? [location] : [] },
      signals: { include: [] },
      exclusions: { companies: company ? [company] : [], domains: [] },
      maxPerCompany
    });
    setDiscoveryMode('person_first');
    setSearchPreview(null);
    setSelectedSavedSearchId('');
  };

  // Helper system to check if user has already scraped are added a prospect
  const checkIsDuplicate = (input: string) => {
    if (!input || !leads) return false;
    const cleanInput = input.trim().toLowerCase();
    
    // We clean up common URL parts to match handle segments accurately
    const getLinkedinHandle = (url: string) => {
      try {
        const parts = url.toLowerCase().replace(/\/$/, "").split("/in/");
        if (parts.length > 1) {
          return parts[1].split(/[?#]/)[0].trim();
        }
      } catch {}
      return url.trim();
    };
    
    const inputHandle = input.includes("linkedin.com/in/") ? getLinkedinHandle(cleanInput) : null;

    return leads.some(lead => {
      const email = lead.profile.contactDetails?.email?.toLowerCase() || '';
      const linkedin = lead.profile.contactDetails?.linkedinUrl?.toLowerCase() || '';
      const name = (lead.profile.fullName || '').toLowerCase();
      
      const leadHandle = linkedin ? getLinkedinHandle(linkedin) : '';

      return (
        (email && email === cleanInput) ||
        (linkedin && linkedin === cleanInput) ||
        (linkedin && linkedin.includes(cleanInput)) ||
        (inputHandle && leadHandle && inputHandle === leadHandle) ||
        (name === cleanInput)
      );
    });
  };

  const handleUrlScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;

    if (checkIsDuplicate(urlInput)) {
      setErrorCode('This prospect is already in Prospects.');
      return;
    }
    
    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);
    setInfoMsg(null);
    setSourceLinks([]);

    const taskId = handleTaskAdd('url', urlInput);

    try {
      const response = await fetch('/api/scrape-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlOrName: urlInput }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.profile || !data.profile.fullName) {
        throw new Error('A complete public profile could not be found. Try a more specific name or URL.');
      }

      // Check duplicate fallback after scrape
      const email = data.profile.contactDetails?.email;
      const name = data.profile.fullName;
      const linkedin = data.profile.contactDetails?.linkedinUrl;
      if (checkIsDuplicate(name) || (email && checkIsDuplicate(email)) || (linkedin && checkIsDuplicate(linkedin))) {
        throw new Error(`Profile for ${name} already exists in your CRM directory.`);
      }

      const addResult = await handleLeadAdded(data.profile);
      if (!addResult.added) {
        throw new Error(`Profile for ${name} already exists in Prospects.`);
      }
      updateTaskStatus(taskId, 'completed', 1);
      setSuccessMsg(`${data.profile.fullName} was added to Prospects. Review the record before enrichment.`);
      if (data.sourceLinks && data.sourceLinks.length > 0) {
        setSourceLinks(data.sourceLinks);
      }
    } catch (err: any) {
      console.error(err);
      setErrorCode(err.message || 'The profile could not be added.');
      updateTaskStatus(taskId, 'failed', 0);
    } finally {
      setLoading(false);
    }
  };

  const handlePasteScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pastedText.trim().length < 20) {
      setErrorCode('Paste at least a name, headline, and current role before continuing.');
      return;
    }

    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);
    setInfoMsg(null);
    setSourceLinks([]);

    const taskId = handleTaskAdd('paste', 'Pasted profile text');

    try {
      const response = await fetch('/api/scrape-pasted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server failed with ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.profile || !data.profile.fullName) {
        throw new Error('The pasted text did not include enough information to build a profile.');
      }

      // Pre-save deduplication check
      const email = data.profile.contactDetails?.email;
      const linkedin = data.profile.contactDetails?.linkedinUrl;
      const name = data.profile.fullName;

      if (checkIsDuplicate(name) || (email && checkIsDuplicate(email)) || (linkedin && checkIsDuplicate(linkedin))) {
        throw new Error(`Profile for ${name} already exists in your CRM directory. Skipped saving duplicate.`);
      }

      const addResult = await handleLeadAdded(data.profile);
      if (!addResult.added) {
        throw new Error(`Profile for ${name} already exists in Prospects.`);
      }
      updateTaskStatus(taskId, 'completed', 1);
      setSuccessMsg(`${data.profile.fullName} was added to Prospects. Review the record before enrichment.`);
      setPastedText('');
    } catch (err: any) {
      console.error(err);
      setErrorCode(err.message || 'The profile could not be created from the pasted text.');
      updateTaskStatus(taskId, 'failed', 0);
    } finally {
      setLoading(false);
    }
  };

  const handleLeadDiscovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!findQuery.trim()) return;

    cancelPreviewRequest();
    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);
    setInfoMsg(null);
    setSourceLinks([]);

    const taskId = handleTaskAdd('search', findQuery);
    const requestController = new AbortController();
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
    const activeDiscovery = {
      controller: requestController,
      sessionId,
      pollController: null as AbortController | null,
      pollTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    activeDiscoveryRef.current = activeDiscovery;

    try {
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Preparing prospect search...`]);
      setLiveTraceEvents([]);

      // Build exclusions list of already scraped identifiers to pass to backend search
      const excludeUrlsAndEmails: string[] = [];
      leads.forEach(l => {
        if (l.profile.contactDetails?.email) {
          excludeUrlsAndEmails.push(l.profile.contactDetails.email);
        }
        if (l.profile.contactDetails?.linkedinUrl) {
          excludeUrlsAndEmails.push(l.profile.contactDetails.linkedinUrl);
        }
        excludeUrlsAndEmails.push(l.profile.fullName);
      });

      // Poll sequentially so a slow response can never land after a newer one.
      const pollLiveStatus = async () => {
        if (activeDiscoveryRef.current?.sessionId !== sessionId) return;
        const pollController = new AbortController();
        activeDiscovery.pollController = pollController;
        try {
          const res = await fetch(`/api/search-logs/${sessionId}/live`, {
            signal: pollController.signal,
          });
          if (res.ok) {
            const data = await res.json();
            if (
              pollController.signal.aborted ||
              activeDiscoveryRef.current?.sessionId !== sessionId
            ) return;
            if (Array.isArray(data.logs) && data.logs.length > 0) {
              setTerminalLogs(data.logs);
            }
            if (Array.isArray(data.traceEvents)) {
              setLiveTraceEvents(data.traceEvents);
            }
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            console.error('Error polling live logs:', error);
          }
        } finally {
          if (
            activeDiscoveryRef.current?.sessionId === sessionId &&
            !requestController.signal.aborted
          ) {
            activeDiscovery.pollTimer = setTimeout(() => void pollLiveStatus(), 2000);
          }
        }
      };
      activeDiscovery.pollTimer = setTimeout(() => void pollLiveStatus(), 0);

      const response = await fetch('/api/find-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: findQuery, 
          limit: leadLimit,
          excludeList: excludeUrlsAndEmails,
          sessionId,
          discoveryMode,
          searchSpec: activeSpec(),
          savedSearchId: selectedSavedSearchId || undefined,
          profileEnrichmentStage: 'on_demand'
        }),
        signal: requestController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Tavily search server returned error ${response.status}`);
      }

      const data = await response.json();
      const fetchedLeads = data.leads || [];

      if (fetchedLeads.length === 0) {
        throw new Error('Search did not yield any new public leads. Try different criteria or industries.');
      }

      const { addedCount, skippedCount } = await handleBulkLeadsAdded(fetchedLeads);
      updateTaskStatus(taskId, 'completed', addedCount);
      const stats = data.stats;
      const tavilyCalls = stats?.queryRuns?.length || stats?.rounds || 0;
      const brightDataCalls = (stats?.brightData?.searchAttempts || 0) + 
                              (stats?.brightData?.profileScrapesAttempted || 0) + 
                              (stats?.brightData?.companyScrapesAttempted || 0) + 
                              (stats?.brightData?.batchScrapesAttempted || 0) + 
                              (stats?.enriched || 0);
      const cacheHits = stats?.cacheHits || 0;
      const metricsInfo = stats ? ` (Tavily calls: ${tavilyCalls} | BrightData calls: ${brightDataCalls} | Cache hits: ${cacheHits})` : '';

      const skippedInfo = skippedCount > 0 ? ` ${skippedCount} duplicate${skippedCount === 1 ? ' was' : 's were'} skipped.` : '';
      if (addedCount === 0) {
        setSuccessMsg(`Discovery completed, but every returned prospect was already saved.${metricsInfo}`);
      } else if (stats?.stopReason === 'target_reached') {
        setSuccessMsg(`Target reached: ${addedCount}/${leadLimit} qualified prospects added.${skippedInfo}${metricsInfo} Prospects are ready for review and manual AI enrichment.`);
      } else if (stats) {
        setSuccessMsg(`Discovery finished with ${addedCount}/${leadLimit} new qualified prospects (stop reason: ${String(stats.stopReason || 'exhausted').replace(/_/g, ' ')}).${skippedInfo}${metricsInfo} Prospects are ready for review and manual AI enrichment.`);
      } else {
        setSuccessMsg(`Discovery complete: ${addedCount} LinkedIn-indexed profile${addedCount === 1 ? '' : 's'} added.${skippedInfo}`);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setErrorCode(null);
        setInfoMsg('Lead discovery was cancelled. No new prospects were added.');
        updateTaskStatus(taskId, 'cancelled', 0);
        triggerToast('Lead discovery cancelled.', 'info');
      } else {
        console.error(err);
        setErrorCode(err.message || 'Lead lookup failed.');
        updateTaskStatus(taskId, 'failed', 0);
      }
    } finally {
      if (activeDiscovery.pollTimer) clearTimeout(activeDiscovery.pollTimer);
      activeDiscovery.pollController?.abort();
      if (activeDiscoveryRef.current?.sessionId === sessionId) {
        activeDiscoveryRef.current = null;
      }
      setLoading(false);
      void refreshScoutWorkspace().catch(() => {});
    }
  };

  const handleCancelDiscovery = () => {
    const activeDiscovery = activeDiscoveryRef.current;
    if (!activeDiscovery) return;
    setTerminalLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Cancellation requested.`]);
    void fetch(`/api/mining-sessions/${activeDiscovery.sessionId}/cancel`, { method: 'POST' })
      .catch(() => undefined);
    if (activeDiscovery.pollTimer) clearTimeout(activeDiscovery.pollTimer);
    activeDiscovery.pollController?.abort();
    activeDiscovery.controller.abort();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Search Input Panels */}
      <Card className="lg:col-span-2 shadow-xl border">
        <CardContent className="p-6">


          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-6 h-12">
              <TabsTrigger value="url" disabled={loading} className="text-xs font-bold"><Globe className="w-4 h-4 mr-2" aria-hidden="true" /> Profile lookup</TabsTrigger>
              <TabsTrigger value="paste" disabled={loading} className="text-xs font-bold"><Clipboard className="w-4 h-4 mr-2" aria-hidden="true" /> Paste profile</TabsTrigger>
              <TabsTrigger value="find" disabled={loading} className="text-xs font-bold"><Search className="w-4 h-4 mr-2" aria-hidden="true" /> Search prospects</TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-4">
              <form
                onSubmit={handleUrlScrape}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="profile-lookup" className="block text-sm font-semibold text-foreground mb-2">
                    LinkedIn URL or professional name
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                      <Globe className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <Input
                        id="profile-lookup"
                        type="text"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="LinkedIn URL or a specific name and company"
                        disabled={loading}
                        aria-describedby="profile-lookup-help"
                        className="pl-10"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={loading || !urlInput.trim()}
                      className="min-w-[140px]"
                    >
                      {loading ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      ) : (
                        <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
                      )}
                      Find profile
                    </Button>
                  </div>
                </div>
              <p id="profile-lookup-help" className="text-sm text-muted-foreground leading-relaxed bg-muted/50 p-3.5 rounded-xl border">
                Apex checks public, LinkedIn-indexed pages and saves supported facts with their sources. It does not sign in to LinkedIn.
              </p>
            </form>
            </TabsContent>

            <TabsContent value="paste" className="space-y-4">
              <form
                onSubmit={handlePasteScrape}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="pasted-profile" className="block text-sm font-semibold text-foreground mb-2">
                    Copied profile or resume text
                  </label>
                  <Textarea
                    id="pasted-profile"
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    placeholder="Paste the person's name, headline, current role, experience, and any contact details."
                    disabled={loading}
                    rows={8}
                    aria-describedby="pasted-profile-help"
                    className="w-full font-sans"
                  />
                  <p id="pasted-profile-help" className="mt-2 text-sm text-muted-foreground">Apex structures the text into a prospect record; you can review it before enrichment.</p>
                </div>
                <div className="flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPastedText('')}
                    disabled={loading || !pastedText}
                  >
                    Clear
                  </Button>
                  <Button
                    type="submit"
                    disabled={loading || pastedText.trim().length < 20}
                  >
                    {loading ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
                    )}
                    Add profile
                  </Button>
                </div>
              </form>
            </TabsContent>

            <TabsContent value="find" className="space-y-4">
              <form
                onSubmit={handleLeadDiscovery}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="prospect-search-brief" className="block text-sm font-semibold text-foreground mb-2">
                    Describe the prospects you want
                  </label>
                  <Textarea
                    id="prospect-search-brief"
                    value={findQuery}
                    onChange={(event) => updateSearchBrief(event.target.value)}
                    placeholder="For example: SaaS founders in Austin at companies with 10-50 employees"
                    disabled={loading}
                    rows={5}
                    aria-describedby="prospect-search-help"
                    className="w-full resize-y leading-relaxed"
                  />
                  <p id="prospect-search-help" className="mt-2 text-sm text-muted-foreground">
                    Apex searches public evidence only. Profile enrichment stays on demand until you review the results.
                  </p>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="w-full sm:max-w-40">
                    <label htmlFor="prospect-count" className="mb-2 block text-sm font-medium text-foreground">Prospects to find</label>
                    <Input
                      id="prospect-count"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={200}
                      value={leadLimit}
                      onChange={(event) => setLeadLimit(Math.max(1, Math.min(200, Number.parseInt(event.target.value, 10) || 1)))}
                      disabled={loading}
                      aria-describedby="prospect-count-help"
                    />
                    <p id="prospect-count-help" className="mt-1 text-xs text-muted-foreground">1-200; smaller searches finish sooner.</p>
                  </div>
                  <Button type="submit" disabled={loading || !findQuery.trim()} className="sm:min-w-44">
                    {loading ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <Search className="w-4 h-4 mr-2" aria-hidden="true" />
                    )}
                    Search prospects
                  </Button>
                </div>

                <div className="rounded-xl border">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedControls((current) => !current)}
                    aria-expanded={showAdvancedControls}
                    aria-controls="advanced-prospect-search"
                    className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-indigo-400" aria-hidden="true" /> Advanced search options</span>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none ${showAdvancedControls ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>

                  {showAdvancedControls && (
                    <div id="advanced-prospect-search" className="space-y-4 border-t p-4">
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => updateSearchBrief(DETAILED_SEARCH_EXAMPLE)} disabled={loading}>
                          <Sparkles className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Use an example
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={handlePreviewScout} disabled={loading || !findQuery.trim()}>
                          <Sparkles className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Preview plan
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={handleSaveSearch} disabled={loading || !findQuery.trim()}>
                          <Save className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Save search
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div>
                          <label htmlFor="discovery-mode" className="mb-1.5 block text-sm font-medium">Search strategy</label>
                          <select id="discovery-mode" value={discoveryMode} onChange={(event) => { cancelPreviewRequest(); setDiscoveryMode(event.target.value as typeof discoveryMode); setSearchPreview(null); }} disabled={loading} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                            <option value="person_first">People first</option>
                            <option value="account_first">Companies first</option>
                            <option value="signal_first">Recent signals first</option>
                            <option value="local_business">Local businesses</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="saved-search-name" className="mb-1.5 block text-sm font-medium">Search name</label>
                          <Input id="saved-search-name" value={savedSearchName} onChange={(event) => setSavedSearchName(event.target.value)} placeholder="Optional name" disabled={loading} />
                        </div>
                        <div>
                          <label htmlFor="max-per-company" className="mb-1.5 block text-sm font-medium">People per company</label>
                          <Input id="max-per-company" type="number" inputMode="numeric" min={1} max={5} value={maxPerCompany} onChange={(event) => { cancelPreviewRequest(); setMaxPerCompany(Math.max(1, Math.min(5, Number(event.target.value) || 1))); setSearchPreview(null); }} disabled={loading} />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label htmlFor="saved-search" className="mb-1.5 block text-sm font-medium">Saved search</label>
                          <select id="saved-search" value={selectedSavedSearchId} onChange={(event) => applySavedSearch(event.target.value)} disabled={loading} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                            <option value="">Choose a saved search</option>
                            {savedSearches.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="lookalike-prospect" className="mb-1.5 block text-sm font-medium">Find similar prospects</label>
                          <select id="lookalike-prospect" value="" onChange={(event) => handleUseLookalike(event.target.value)} disabled={loading || leads.length === 0} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                            <option value="">Choose an existing prospect</option>
                            {leads.slice(0, 100).map((lead) => <option key={lead.id} value={lead.id}>{lead.profile.fullName}{lead.profile.currentCompany ? ` - ${lead.profile.currentCompany}` : ''}</option>)}
                          </select>
                        </div>
                      </div>

                      {providerCapabilities && (
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="Provider usage">
                          <Badge variant="outline">Tavily: {providerCapabilities.tavily?.usage?.units || 0}/{providerCapabilities.tavily?.monthlyLimit || 1000} credits</Badge>
                          <Badge variant="outline">Bright Data: {providerCapabilities.brightData?.usage?.units || 0}/{providerCapabilities.brightData?.monthlyUnitLimit || providerCapabilities.brightData?.monthlyLimit || 5000} requests</Badge>
                          <Badge variant="outline">Profile enrichment on demand</Badge>
                        </div>
                      )}
                      {searchPreview?.spec && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-100 space-y-1" role="status">
                          <div className="font-semibold">Planned paths: {(searchPreview.tasks || []).map((task: any) => task.lane).filter((lane: string, index: number, lanes: string[]) => lanes.indexOf(lane) === index).join(', ') || 'people'}</div>
                          <div>Using: {[...(searchPreview.spec.person?.includeTitles || []), ...(searchPreview.spec.company?.industries || []), ...(searchPreview.spec.signals?.include || [])].slice(0, 6).join(' / ') || 'your brief'}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 text-sm text-indigo-100">
                  <span className="font-semibold">Flow:</span> Discover public prospects here, review them in Prospects, then enrich only the records you choose.
                </div>
            </form>
            </TabsContent>
          </Tabs>

        {loading && activeTab === 'find' && (
          <div className="mt-6 border border-indigo-500/20 bg-slate-950/80 rounded-2xl shadow-2xl overflow-hidden" aria-busy="true">
            <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                <span className="text-sm font-semibold text-slate-200">Live discovery progress</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs bg-indigo-950/60 border border-indigo-500/15 text-indigo-300 px-2 py-0.5 rounded font-semibold animate-pulse motion-reduce:animate-none" role="status">
                  Search active
                </span>
                <Button type="button" variant="outline" size="sm" onClick={handleCancelDiscovery} className="h-8 text-xs">
                  Cancel
                </Button>
              </div>
            </div>

            <div className="p-5 font-mono text-xs text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
              <div className="flex gap-3 items-center mb-1">
                <div className="relative h-4 w-4 shrink-0">
                  <div className="absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent animate-spin motion-reduce:animate-none"></div>
                </div>
                <div className="text-sm text-slate-100 font-semibold">
                  Search details
                </div>
              </div>

              {terminalLogs.length > 0 ? (
                terminalLogs.map((log, i) => {
                  let colorClass = "text-slate-300";
                  if (log.includes("WAITING") || log.includes("FILTERING")) colorClass = "text-amber-400 font-bold";
                  if (log.includes("REQUEST") || log.includes("QUERY") || log.includes("DISCOVERY") || log.includes("EVIDENCE") || log.includes("EXTRACTION")) colorClass = "text-indigo-400 font-bold";
                  return (
                    <motion.div 
                      key={i} 
                      className={`${colorClass} leading-relaxed flex items-start gap-1`}
                      initial={shouldReduceMotion ? false : { opacity: 0, x: -5 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
                    >
                      <span className="shrink-0 text-slate-600 select-none">{">"}</span>
                      <span>{log}</span>
                    </motion.div>
                  );
                })
              ) : (
                <p className="text-slate-500 italic">Starting the search...</p>
              )}
            </div>
            <TraceSummaryViewer traceEvents={liveTraceEvents} />
          </div>
        )}

        <AnimatePresence initial={!shouldReduceMotion}>
          {successMsg && (
            <motion.div
              initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
              className="mt-6 border border-emerald-500/20 bg-emerald-500/5 p-4 rounded-xl flex gap-3 text-emerald-300 text-sm"
              role="status"
              aria-live="polite"
            >
              <Check className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-200">{successMsg}</p>
                {sourceLinks.length > 0 && (
                  <div className="mt-2.5">
                    <span className="text-xs font-semibold text-emerald-400 block mb-1">Sources</span>
                    <div className="flex flex-wrap gap-2">
                      {sourceLinks.slice(0, 3).map((link, i) => (
                        <a
                          key={i}
                          href={link.uri}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors motion-reduce:transition-none text-emerald-200 text-xs px-2.5 py-1 rounded-md flex items-center gap-1 font-medium"
                        >
                          <Globe className="w-3 h-3 text-emerald-400" />
                          {link.title.length > 25 ? link.title.substring(0, 25) + '...' : link.title}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {infoMsg && (
            <motion.div
              initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
              className="mt-6 flex gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-sky-200"
              role="status"
              aria-live="polite"
            >
              <Info className="h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />
              <p className="font-semibold">{infoMsg}</p>
            </motion.div>
          )}

          {errorCode && (
            <motion.div
              initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
              className="mt-6 border border-rose-500/20 bg-rose-500/5 p-4 rounded-xl flex gap-3 text-rose-300 text-sm"
              role="alert"
            >
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold text-rose-200">Could not complete the request</p>
                <p className="mt-0.5 text-rose-300 leading-relaxed text-xs">{errorCode}</p>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </CardContent>
      </Card>

      {/* Task Logger and History Center */}
      <Card className="flex flex-col h-full justify-between shadow-xl">
        <CardContent className="p-6 h-full flex flex-col">
          <div>
            <div className="flex items-center justify-between gap-3 border-b pb-3 mb-4">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-slate-400" aria-hidden="true" />
                <h3 className="text-sm font-bold text-slate-200">Recent activity</h3>
              </div>
              <Badge
                variant="outline"
                aria-live="polite"
                className={providerStatus === 'ready'
                  ? 'border-emerald-500/30 text-emerald-300'
                  : providerStatus === 'missing'
                    ? 'border-amber-500/30 text-amber-300'
                    : providerStatus === 'offline'
                      ? 'border-rose-500/30 text-rose-300'
                      : 'border-slate-700 text-slate-400'}
              >
                {providerStatus === 'ready' ? 'Discovery configured' : providerStatus === 'missing' ? 'Discovery setup needed' : providerStatus === 'offline' ? 'Health check unavailable' : 'Checking discovery setup'}
              </Badge>
            </div>
          
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-8 text-center">
              <History className="mx-auto h-6 w-6 text-slate-500" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium text-slate-300">No activity yet</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">Profile lookups and prospect searches from this session will appear here.</p>
            </div>
          ) : (
            <ul className="space-y-3 max-h-[280px] overflow-y-auto pr-1" aria-label="Current session activity">
              {tasks.map((task) => (
              <li
                key={task.id} 
                className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between text-xs transition-colors motion-reduce:transition-none hover:bg-slate-900"
              >
                <div className="max-w-[70%]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-300">
                    {task.type === 'url' && <Globe className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />}
                    {task.type === 'paste' && <Clipboard className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />}
                    {task.type === 'search' && <Search className="w-3.5 h-3.5 text-blue-400" aria-hidden="true" />}
                    <span className="truncate">{task.query}</span>
                  </div>
                  <span className="text-xs text-slate-500 block mt-1">
                    {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                
                <div>
                  {task.status === 'processing' && (
                    <span className="px-2 py-1 bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20 rounded-md flex items-center gap-1 font-bold text-xs animate-pulse motion-reduce:animate-none">
                      <RefreshCw className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Searching
                    </span>
                  )}
                  {task.status === 'completed' && (
                    <span className="px-2 py-1 bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20 rounded-md flex items-center gap-1 font-bold text-xs">
                      <Check className="w-3 h-3" aria-hidden="true" />
                      {task.resultCount ? `+${task.resultCount} prospects` : 'Done'}
                    </span>
                  )}
                  {task.status === 'failed' && (
                    <span className="px-2 py-1 bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/20 rounded-md flex items-center gap-1 font-bold text-xs">
                      <AlertCircle className="w-3 h-3" aria-hidden="true" /> Failed
                    </span>
                  )}
                  {task.status === 'cancelled' && (
                    <span className="flex items-center gap-1 rounded-md bg-sky-500/10 px-2 py-1 text-xs font-bold text-sky-300 ring-1 ring-sky-500/20">
                      <Info className="h-3 w-3" aria-hidden="true" /> Cancelled
                    </span>
                  )}
                  {task.status === 'idle' && (
                    <span className="px-2 py-1 bg-slate-800 text-slate-400 rounded-md font-bold text-xs">
                      Queued
                    </span>
                  )}
                </div>
              </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800/80">
          <div className="bg-indigo-500/5 p-3.5 rounded-xl flex items-start gap-2.5 text-xs text-indigo-300 border border-indigo-500/15">
            <Database className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <p className="font-semibold text-slate-200">Next: review, then enrich</p>
              <p className="text-slate-400 leading-relaxed mt-0.5">New records go to Prospects first. Review them before running profile enrichment.</p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setShowLogs(true)} className="gap-2 text-slate-300">
            <History className="w-4 h-4" aria-hidden="true" /> View search history
          </Button>
        </div>
        </CardContent>
      </Card>

      <Dialog open={showLogs} onOpenChange={setShowLogs}>
        <DialogContent className="grid max-h-[85vh] max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-slate-700 bg-slate-900 p-0 motion-reduce:animate-none motion-reduce:transition-none">
          <DialogHeader className="border-b border-slate-800 bg-slate-900/50 p-4 pr-12 text-left">
            <DialogTitle className="flex items-center gap-2 text-lg text-slate-200">
              <History className="w-5 h-5 text-indigo-400" aria-hidden="true" /> Search history
            </DialogTitle>
            <DialogDescription className="text-slate-400">Completed and active prospect searches saved by the server.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto p-4 custom-scrollbar">
                {searchLogsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400" role="status">
                    <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading search history...
                  </div>
                ) : searchLogsError ? (
                  <p className="py-10 text-center text-sm text-rose-300" role="alert">{searchLogsError}</p>
                ) : searchLogs.length === 0 ? (
                  <div className="py-10 text-center">
                    <History className="mx-auto h-7 w-7 text-slate-600" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium text-slate-300">No saved searches yet</p>
                    <p className="mt-1 text-xs text-slate-500">Run a prospect search and its real server history will appear here.</p>
                  </div>
                ) : (
                  searchLogs.map(log => (
                    <div key={log.id} className={`p-4 rounded-lg border ${log.status === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' : log.status === 'running' ? 'border-amber-500/20 bg-amber-500/5' : log.status === 'cancelled' ? 'border-sky-500/20 bg-sky-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div className="text-xs text-slate-400">{new Date(log.timestamp).toLocaleString()}</div>
                        <Badge variant="outline" className={log.status === 'success' ? 'text-emerald-400 border-emerald-500/30' : log.status === 'running' ? 'text-amber-400 border-amber-500/30' : log.status === 'cancelled' ? 'text-sky-300 border-sky-500/30' : 'text-rose-400 border-rose-500/30'}>
                          {log.status.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="mb-3">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Search brief</p>
                        <p className="text-sm text-slate-200">{log.prompt}</p>
                      </div>
                      {(log.generatedQueries || []).length > 0 && <div className="mb-3">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Generated search queries</p>
                        <ul className="list-disc pl-5 space-y-1">
                          {(log.generatedQueries || []).map((q, i) => (
                            <li key={i} className="text-xs text-indigo-300 font-mono">{q}</li>
                          ))}
                        </ul>
                      </div>}
                      <div className="flex gap-4 mt-3 pt-3 border-t border-slate-800">
                        {log.status === 'error' ? (
                          <div className="text-xs text-rose-400"><span className="font-semibold text-rose-500">Error:</span> {log.errorMessage}</div>
                        ) : log.status === 'running' ? (
                          <div className="text-xs text-amber-300"><span className="font-semibold text-amber-400">Running:</span> this search is still in progress.</div>
                        ) : (
                          <>
                            <div className="text-xs text-slate-400"><span className="text-slate-300 font-semibold">{log.rawResultsCount}</span> source results</div>
                            <div className="text-xs text-slate-400"><span className="text-emerald-400 font-semibold">{log.leadsFound}</span> prospects found</div>
                          </>
                        )}
                      </div>
                      <TraceSummaryViewer traceSummary={log.traceSummary} traceEvents={log.traceEvents || []} />
                      {log.detailedLogs && (
                        <div className="mt-4 pt-3 border-t border-slate-800/50">
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Detailed progress</p>
                          <pre className="text-xs text-slate-400 font-mono bg-slate-950 p-3 rounded overflow-x-auto border border-slate-800 max-h-64 custom-scrollbar whitespace-pre-wrap">
                            {log.detailedLogs}
                          </pre>
                        </div>
                      )}
                      <DebugLogsViewer debugLogsStr={log.debugLogs} />
                    </div>
                  ))
                )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

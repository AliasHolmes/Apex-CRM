/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { useLeads } from '../context/LeadContext';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Globe, 
  Clipboard, 
  Search, 
  Sparkles, 
  Check, 
  AlertCircle, 
  RefreshCw, 
  ArrowRight,
  Database,
  History,
  FileSpreadsheet,
  Save,
  SlidersHorizontal
} from 'lucide-react';
import { LinkedInProfile, Lead, ScrapingTask, QualifiedLeadProfile, SearchLog, MiningTraceEvent, MiningTraceSummary, ProviderSummary } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

const DebugLogsViewer = ({ debugLogsStr }: { debugLogsStr?: string }) => {
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
        className="text-xs text-indigo-400 hover:text-indigo-300 p-0 h-auto gap-1"
      >
        {expanded ? 'Hide' : 'Show'} Debug Payloads ({events.length} events)
      </Button>
      
      {expanded && (
        <div className="mt-2 space-y-2 max-h-96 overflow-y-auto custom-scrollbar p-2 bg-slate-950/50 rounded border border-slate-800/80">
          {events.map((ev, idx) => (
            <div key={idx} className="text-xs border-b border-slate-900 last:border-0 pb-2 mb-2 last:pb-0 last:mb-0">
              <div className="flex items-center justify-between text-slate-500 font-mono text-[10px]">
                <span>{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}</span>
                <span className="uppercase font-semibold text-indigo-400/80">{ev.type}</span>
              </div>
              <div className="font-semibold text-slate-300 mt-0.5">{ev.label || ev.query || ev.url}</div>
              
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setExpandedEvent(expandedEvent === idx ? null : idx)}
                className="text-[10px] text-slate-400 hover:text-slate-200 p-0 h-auto mt-1"
              >
                {expandedEvent === idx ? 'Collapse details' : 'Expand details'}
              </Button>
              
              {expandedEvent === idx && (
                <pre className="text-[10px] text-slate-300 font-mono bg-slate-950 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap max-h-64 border border-slate-800">
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
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-[10px] uppercase text-slate-500 font-bold">Events</div><div className="text-sm text-slate-200 font-semibold">{traceSummary?.eventCount ?? traceEvents.length}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-[10px] uppercase text-slate-500 font-bold">LLM Tokens</div><div className="text-sm text-indigo-300 font-semibold">{cost?.totalTokens?.toLocaleString?.() || 0}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-[10px] uppercase text-slate-500 font-bold">Est. Cost</div><div className="text-sm text-emerald-300 font-semibold">${(cost?.estimatedUsd || 0).toFixed(4)}</div></div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-md p-2"><div className="text-[10px] uppercase text-slate-500 font-bold">Cost / Lead</div><div className="text-sm text-slate-200 font-semibold">${(cost?.costPerAcceptedLead || 0).toFixed(4)}</div></div>
      </div>
      {providers.length > 0 && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{providers.map(([provider, item]) => (<div key={provider} className="bg-slate-950/50 border border-slate-800 rounded-md p-2 text-xs"><div className="flex items-center justify-between mb-1"><span className="uppercase font-bold text-slate-300">{provider}</span><span className="text-slate-500">avg {formatDuration(item.avgLatencyMs)}</span></div><div className="flex gap-3 text-[11px] text-slate-400"><span>{item.calls} calls</span><span className="text-emerald-400">{item.successes} ok</span><span className="text-rose-400">{item.failures} fail</span>{item.totalTokens > 0 && <span className="text-indigo-300">{item.totalTokens.toLocaleString()} tok</span>}</div></div>))}</div>}
      {phases.length > 0 && <div className="flex flex-wrap gap-1.5">{phases.map(phase => (<span key={phase.phase} className={`px-2 py-1 rounded-md border text-[10px] font-semibold ${phase.status === 'error' ? 'border-rose-500/30 text-rose-300 bg-rose-500/5' : 'border-slate-700 text-slate-300 bg-slate-950/50'}`}>{phase.phase.replace(/_/g, ' ')} - {phase.events} - {formatDuration(phase.durationMs)}</span>))}</div>}
      {recent.length > 0 && <div className="space-y-1">{recent.map(event => (<div key={event.id} className="text-[11px] text-slate-400 font-mono bg-slate-950/40 border border-slate-850 rounded px-2 py-1 flex justify-between gap-2"><span className="truncate">{event.phase}/{event.operation}{event.query ? ` - ${event.query}` : ''}</span><span className={event.status === 'error' ? 'text-rose-400' : event.status === 'success' ? 'text-emerald-400' : 'text-slate-500'}>{event.status}</span></div>))}</div>}
    </div>
  );
};
interface ScrapeWorkspaceProps {
  leads: Lead[];
  handleLeadAdded: (profile: LinkedInProfile) => void;
  handleBulkLeadsAdded: (profiles: QualifiedLeadProfile[]) => void;
}

export default function ScrapeWorkspace() {
  const activeDiscoveryRef = useRef<{ controller: AbortController; sessionId: string } | null>(null);
  const { leads, handleLeadAdded, handleBulkLeadsAdded, rehydrateLeads } = useLeads();
  const { triggerToast } = useToast();
  const [activeTab, setActiveTab] = useState<'url' | 'paste' | 'find'>('url');
  
  // API status detection
  const [apiKeyDetected, setApiKeyDetected] = useState<boolean | null>(null);

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
  
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [sourceLinks, setSourceLinks] = useState<{ title: string; uri: string }[]>([]);

  // Diagnostic Terminal States for Adaptive Scraping & Nudge Logs
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [liveTraceEvents, setLiveTraceEvents] = useState<MiningTraceEvent[]>([]);
  
  const [showLogs, setShowLogs] = useState(false);
  const [searchLogs, setSearchLogs] = useState<SearchLog[]>([]);

  useEffect(() => {
    if (showLogs) {
      fetch('/api/search-logs')
        .then(r => r.json())
        .then(data => setSearchLogs(Array.isArray(data) ? data : (Array.isArray(data.logs) ? data.logs : [])))
        .catch(console.error);
    }
  }, [showLogs]);

  const refreshScoutWorkspace = async () => {
    const [capabilitiesResponse, searchesResponse] = await Promise.all([
      fetch('/api/provider-capabilities'),
      fetch('/api/saved-searches')
    ]);
    if (capabilitiesResponse.ok) setProviderCapabilities(await capabilitiesResponse.json());
    if (searchesResponse.ok) {
      const data = await searchesResponse.json();
      setSavedSearches(Array.isArray(data.searches) ? data.searches : []);
    }
  };

  useEffect(() => {
    void refreshScoutWorkspace().catch(() => {});
  }, []);

  // Live logs are handled directly via active status polling during search execution

  useEffect(() => {
    const checkAuth = () => {
      fetch('/api/health')
        .then(r => r.json())
        .then(data => {
          if (data) {
            setApiKeyDetected(data.hasKey || data.hasOAuth);
          }
        })
        .catch(() => {});
    };
    checkAuth();
    const interval = setInterval(checkAuth, 3000);
    return () => clearInterval(interval);
  }, []);
  const [tasks, setTasks] = useState<ScrapingTask[]>([
    {
      id: 'task-1',
      type: 'url',
      query: 'https://www.linkedin.com/in/siskind/',
      status: 'completed',
      resultCount: 1,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'task-2',
      type: 'search',
      query: 'AI Researchers at Google',
      status: 'completed',
      resultCount: 4,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    }
  ]);

  const handleTaskAdd = (type: 'url' | 'paste' | 'search', query: string) => {
    const newTask: ScrapingTask = {
      id: `task-${Date.now()}`,
      type,
      query: query.length > 50 ? query.substring(0, 50) + '...' : query,
      status: 'idle',
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [newTask, ...prev]);
    return newTask.id;
  };

  const updateTaskStatus = (taskId: string, status: 'completed' | 'failed', resultCount?: number) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, resultCount } : t));
  };

  const activeSpec = () => ({
    ...(searchSpec || {}),
    mode: discoveryMode,
    maxPerCompany
  });

  const handlePreviewScout = async () => {
    if (!findQuery.trim() || loading) return;
    setErrorCode(null);
    try {
      const response = await fetch('/api/lead-search/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: findQuery, discoveryMode, searchSpec: searchSpec ? activeSpec() : undefined })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not plan this scout search.');
      setSearchPreview(data);
      setSearchSpec(data.spec);
      setDiscoveryMode(data.spec?.mode || discoveryMode);
      setMaxPerCompany(data.spec?.maxPerCompany || maxPerCompany);
    } catch (error: any) {
      setErrorCode(error.message || 'Could not plan this scout search.');
    }
  };

  const handleSaveSearch = async () => {
    if (!findQuery.trim()) return;
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
      setErrorCode('Abort: This prospect already exists in your CRM directory.');
      return;
    }
    
    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);
    setSourceLinks([]);

    const taskId = handleTaskAdd('url', urlInput);

    try {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'processing' } : t));
      
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
        throw new Error('Failed to extract profile structured credentials.');
      }

      // Check duplicate fallback after scrape
      const email = data.profile.contactDetails?.email;
      const name = data.profile.fullName;
      const linkedin = data.profile.contactDetails?.linkedinUrl;
      if (checkIsDuplicate(name) || (email && checkIsDuplicate(email)) || (linkedin && checkIsDuplicate(linkedin))) {
        throw new Error(`Profile for ${name} already exists in your CRM directory.`);
      }

      handleLeadAdded(data.profile);
      updateTaskStatus(taskId, 'completed', 1);
      setSuccessMsg(`Successfully scraped and structured: ${data.profile.fullName}`);
      if (data.sourceLinks && data.sourceLinks.length > 0) {
        setSourceLinks(data.sourceLinks);
      }
    } catch (err: any) {
      console.error(err);
      setErrorCode(err.message || 'Search or extraction failed.');
      updateTaskStatus(taskId, 'failed', 0);
    } finally {
      setLoading(false);
    }
  };

  const handlePasteScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pastedText.trim().length < 20) {
      setErrorCode('Please paste a substantial chunk of LinkedIn profile text (e.g., Name, headline, and current achievements).');
      return;
    }

    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);

    const taskId = handleTaskAdd('paste', 'Raw Paste Text Extract');

    try {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'processing' } : t));
      
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
        throw new Error('Could not parsed standard fields from the paste block.');
      }

      // Pre-save deduplication check
      const email = data.profile.contactDetails?.email;
      const linkedin = data.profile.contactDetails?.linkedinUrl;
      const name = data.profile.fullName;

      if (checkIsDuplicate(name) || (email && checkIsDuplicate(email)) || (linkedin && checkIsDuplicate(linkedin))) {
        throw new Error(`Profile for ${name} already exists in your CRM directory. Skipped saving duplicate.`);
      }

      handleLeadAdded(data.profile);
      updateTaskStatus(taskId, 'completed', 1);
      setSuccessMsg(`Extracted profile for ${data.profile.fullName} and saved to CRM.`);
      setPastedText('');
    } catch (err: any) {
      console.error(err);
      setErrorCode(err.message || 'Extraction failed. Make sure content includes structural resume text.');
      updateTaskStatus(taskId, 'failed', 0);
    } finally {
      setLoading(false);
    }
  };

  const handleLeadDiscovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!findQuery.trim()) return;

    setLoading(true);
    setErrorCode(null);
    setSuccessMsg(null);

    const taskId = handleTaskAdd('search', findQuery);
    const requestController = new AbortController();
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeDiscoveryRef.current = { controller: requestController, sessionId };
    let pollInterval: ReturnType<typeof setInterval> | undefined;

    try {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'processing' } : t));
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] Preparing lead discovery request...`]);
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

      // Start live status polling
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/search-logs/${sessionId}/live`);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.logs) && data.logs.length > 0) {
              setTerminalLogs(data.logs);
            }
            if (Array.isArray(data.traceEvents)) {
              setLiveTraceEvents(data.traceEvents);
            }
          }
        } catch (e) {
          console.error('Error polling live logs:', e);
        }
      }, 1000);

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
          profileEnrichmentStage: 'on_demand',
          emailDiscovery: 'off'
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

      await handleBulkLeadsAdded(fetchedLeads);
      await rehydrateLeads();
      updateTaskStatus(taskId, 'completed', fetchedLeads.length);
      const stats = data.stats;
      const tavilyCalls = stats?.queryRuns?.length || stats?.rounds || 0;
      const brightDataCalls = (stats?.brightData?.searchAttempts || 0) + 
                              (stats?.brightData?.profileScrapesAttempted || 0) + 
                              (stats?.brightData?.companyScrapesAttempted || 0) + 
                              (stats?.brightData?.batchScrapesAttempted || 0) + 
                              (stats?.enriched || 0);
      const cacheHits = stats?.cacheHits || 0;
      const metricsInfo = stats ? ` (Tavily calls: ${tavilyCalls} | BrightData calls: ${brightDataCalls} | Cache hits: ${cacheHits})` : '';

      if (stats?.stopReason === 'target_reached') {
        setSuccessMsg(`Target reached: ${fetchedLeads.length}/${leadLimit} qualified prospects added${metricsInfo}. Prospects are ready for review and manual AI enrichment.`);
      } else if (stats) {
        setSuccessMsg(`Discovery finished with ${fetchedLeads.length}/${leadLimit} qualified prospects (Stop reason: ${String(stats.stopReason || 'exhausted').replace(/_/g, ' ')})${metricsInfo}. Prospects are ready for review and manual AI enrichment.`);
      } else {
        setSuccessMsg(`Discovery complete: ${fetchedLeads.length} LinkedIn-indexed profiles added to your CRM for review and manual AI enrichment.`);
      }
    } catch (err: any) {
      console.error(err);
      const message = err?.name === 'AbortError'
        ? 'Lead discovery was cancelled.'
        : (err.message || 'Lead lookup failed.');
      setErrorCode(message);
      updateTaskStatus(taskId, 'failed', 0);
    } finally {
      if (pollInterval) clearInterval(pollInterval);
      activeDiscoveryRef.current = null;
      setLoading(false);
    }
  };

  const handleCancelDiscovery = () => {
    const activeDiscovery = activeDiscoveryRef.current;
    if (!activeDiscovery) return;
    activeDiscovery.controller.abort();
    setTerminalLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Cancellation requested.`]);
    void fetch(`/api/mining-sessions/${activeDiscovery.sessionId}/cancel`, { method: 'POST' });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Search Input Panels */}
      <Card className="lg:col-span-2 shadow-xl border">
        <CardContent className="p-6">


          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-6 h-12">
              <TabsTrigger value="url" className="text-xs font-bold uppercase tracking-wider"><Globe className="w-4 h-4 mr-2" /> URL Lookup</TabsTrigger>
              <TabsTrigger value="paste" className="text-xs font-bold uppercase tracking-wider"><Clipboard className="w-4 h-4 mr-2" /> Raw Paste</TabsTrigger>
              <TabsTrigger value="find" className="text-xs font-bold uppercase tracking-wider"><Search className="w-4 h-4 mr-2" /> Lead Finder</TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-4">
              <form
                onSubmit={handleUrlScrape}
                className="space-y-4"
              >
                <div>
                  <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    LinkedIn URL or Target Professional Name
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Globe className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        type="text"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="e.g. https://www.linkedin.com/in/siskind/ or 'Greg Siskind Immigration'"
                        disabled={loading}
                        className="pl-10"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={loading || !urlInput.trim()}
                      className="min-w-[140px]"
                    >
                      {loading ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4 mr-2" />
                      )}
                      Scrape Details
                    </Button>
                  </div>
                </div>
              <p className="text-xs text-muted-foreground leading-relaxed bg-muted/50 p-3.5 rounded-xl border">
                <strong>How it works:</strong> In the sandbox container, direct scrapers are blocked by LinkedIn's login walls. 
                Instead, Apex searches public LinkedIn-indexed results through <strong>Tavily</strong>, then extracts available facts 
                and references for the target profile or name before consolidating them into a structured CRM record.
              </p>
            </form>
            </TabsContent>

            <TabsContent value="paste" className="space-y-4">
              <form
                onSubmit={handlePasteScrape}
                className="space-y-4"
              >
                <div>
                  <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    Paste LinkedIn Profile Raw Text or HTML Code
                  </label>
                  <Textarea
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    placeholder="Go to any LinkedIn Profile, press Ctrl+A / Cmd+A, copy everything or just copy key sections, and paste them here..."
                    disabled={loading}
                    rows={8}
                    className="w-full font-sans"
                  />
                </div>
                <div className="flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPastedText('')}
                    disabled={loading || !pastedText}
                  >
                    Clear Block
                  </Button>
                  <Button
                    type="submit"
                    disabled={loading || pastedText.trim().length < 20}
                  >
                    {loading ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4 mr-2" />
                    )}
                    Extract Credentials
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
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">
                    Lead Query Criteria
                  </label>
                  <button
                    type="button"
                    onClick={() => setFindQuery(`Job Titles (run all of these)
Founder
Co-Founder
CEO
Owner
Agency Owner
Managing Director
COO
Operations Manager
Practice Owner
Sales Director
Head of Growth
Broker Owner

Industry Terms (pair one with each title above)
Marketing Agency
Lead Generation Agency
Appointment Setting Agency
AI Agency
Real Estate Team
Property Management
Roofing
HVAC
Solar
Home Services
Dental Practice
Med Spa
Immigration Consultancy
Recruiting Agency
Law Firm
Coaching

Scraper Filter Settings
Employees: 5-75
Seniority: Owner, C-Suite, Director, Partner
Company Type: Privately Held
Activity: Posted in last 30 days
Geography: US, UK, Canada, Australia, UAE

Priority Combos (run these first)
Founder + Marketing Agency
Owner + Roofing / HVAC / Solar
Founder + Real Estate Team
Practice Owner + Dental / Med Spa
Founder + Immigration Consultancy
Agency Owner + Appointment Setting
COO + Recruiting Agency

One Rule
Title + Industry + 5-75 employees + active poster = your entire filter.
Everything else is noise.`)}
                    className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/20 px-2 py-1 rounded transition-all cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3 animate-pulse" />
                    Load Complex Spec Template
                  </button>
                </div>
                <div className="space-y-2">
                  <div className="relative">
                    <Textarea
                      value={findQuery}
                      onChange={(e) => setFindQuery(e.target.value)}
                      placeholder="e.g. 'SaaS founders in Austin' or paste a long campaign spec sheet with checkboxes, priority combos, and rules..."
                      disabled={loading}
                      rows={5}
                      className="w-full font-mono text-xs resize-y leading-relaxed"
                    />
                  </div>
                  <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 text-[11px] text-indigo-200 leading-relaxed">
                    Scout mode uses public web evidence only. Deep profile enrichment and email discovery remain separate, manual stages after you review the prospects.
                  </div>

                  <div className="rounded-xl border bg-muted/40 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-bold"><SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" /> Scout controls</div>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={handlePreviewScout} disabled={loading || !findQuery.trim()} className="h-7 text-[10px]">
                          <Sparkles className="w-3 h-3 mr-1" /> Plan search
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={handleSaveSearch} disabled={loading || !findQuery.trim()} className="h-7 text-[10px]">
                          <Save className="w-3 h-3 mr-1" /> Save
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <select value={discoveryMode} onChange={(e) => { setDiscoveryMode(e.target.value as typeof discoveryMode); setSearchPreview(null); }} disabled={loading} className="h-8 rounded-md border bg-background px-2 text-xs">
                        <option value="person_first">People first</option>
                        <option value="account_first">Accounts first</option>
                        <option value="signal_first">Signals first</option>
                        <option value="local_business">Local businesses</option>
                      </select>
                      <Input value={savedSearchName} onChange={(e) => setSavedSearchName(e.target.value)} placeholder="Saved-search name" disabled={loading} className="h-8 text-xs" />
                      <div className="flex items-center gap-2 rounded-md border bg-background px-2">
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">Max/account</span>
                        <Input type="number" min={1} max={5} value={maxPerCompany} onChange={(e) => setMaxPerCompany(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} disabled={loading} className="h-7 border-0 px-1 text-xs" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <select value={selectedSavedSearchId} onChange={(e) => applySavedSearch(e.target.value)} disabled={loading} className="h-8 rounded-md border bg-background px-2 text-xs">
                        <option value="">Load a saved scout search...</option>
                        {savedSearches.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
                      </select>
                      <select value="" onChange={(e) => handleUseLookalike(e.target.value)} disabled={loading || leads.length === 0} className="h-8 rounded-md border bg-background px-2 text-xs">
                        <option value="">More like an existing prospect...</option>
                        {leads.slice(0, 100).map((lead) => <option key={lead.id} value={lead.id}>{lead.profile.fullName}{lead.profile.currentCompany ? ` - ${lead.profile.currentCompany}` : ''}</option>)}
                      </select>
                    </div>
                    {providerCapabilities && (
                      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                        <Badge variant="outline">Tavily free: {providerCapabilities.tavily?.usage?.units || 0}/{providerCapabilities.tavily?.monthlyLimit || 1000} credits</Badge>
                        <Badge variant="outline">Bright Data free: {providerCapabilities.brightData?.usage?.units || 0}/{providerCapabilities.brightData?.monthlyUnitLimit || providerCapabilities.brightData?.monthlyLimit || 5000} requests</Badge>
                        <Badge variant="outline">Scout-only: no automatic email or deep profile scrape</Badge>
                      </div>
                    )}
                    {searchPreview?.spec && (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2 text-[10px] text-emerald-100 space-y-1">
                        <div className="font-bold">Planned lanes: {(searchPreview.tasks || []).map((task: any) => task.lane).filter((lane: string, index: number, lanes: string[]) => lanes.indexOf(lane) === index).join(', ') || 'person'}</div>
                        <div>Criteria: {[...(searchPreview.spec.person?.includeTitles || []), ...(searchPreview.spec.company?.industries || []), ...(searchPreview.spec.signals?.include || [])].slice(0, 6).join(' / ') || 'your brief'}</div>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      disabled={loading || !findQuery.trim()}
                    >
                      {loading ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Globe className="w-4 h-4 mr-2" />
                      )}
                      Find LinkedIn Leads
                    </Button>
                  </div>
                </div>
              </div>

              {/* Lead count toggle selector */}
              <div className="bg-muted border rounded-xl p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <span className="block text-xs font-bold text-foreground">Discovery Lead Quantity (Up to 200)</span>
                    <span className="block text-[10px] text-muted-foreground mt-0.5">Control pipeline discovery depth and synthesis density.</span>
                  </div>
                  <div className="flex items-center gap-2 self-start sm:self-center">
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={leadLimit}
                      onChange={(e) => {
                        const val = Math.max(1, Math.min(200, parseInt(e.target.value) || 1));
                        setLeadLimit(val);
                      }}
                      disabled={loading}
                      className="w-16 h-8 py-1 px-2 text-center"
                    />
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Leads</span>
                  </div>
                </div>

                <div className="grid grid-cols-5 gap-1 p-1 bg-background border rounded-xl">
                  {[
                    { num: 5, label: '5 (Fast)' },
                    { num: 25, label: '25' },
                    { num: 50, label: '50' },
                    { num: 100, label: '100' },
                    { num: 200, label: '200 (Max)' }
                  ].map((opt) => (
                    <button
                      key={opt.num}
                      type="button"
                      disabled={loading}
                      onClick={() => setLeadLimit(opt.num)}
                      className={`py-1.5 rounded-lg text-[10px] font-black transition-all cursor-pointer ${
                        leadLimit === opt.num
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={200}
                    value={leadLimit}
                    disabled={loading}
                    onChange={(e) => setLeadLimit(parseInt(e.target.value) || 1)}
                    className="w-full h-1 bg-border rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                  <span className="text-[10px] text-muted-foreground font-bold shrink-0">{leadLimit} / 200</span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed bg-muted/50 p-3.5 rounded-xl border">
                <strong>Prospect Scout:</strong> Tavily searches public evidence; Bright Data can provide a small corroborating public-web search when needed. The resulting prospects are intentionally held for your manual deep-enrichment and email-discovery decisions.
              </p>
            </form>
            </TabsContent>
          </Tabs>

        {/* Scanner Simulation Status overlay */}
        {loading && (
          <div className="mt-6 border border-indigo-500/20 bg-slate-950/80 rounded-2xl shadow-2xl overflow-hidden">
            {/* Header style */}
            <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-500"></span>
                <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                <span className="text-xs text-slate-400 font-mono ml-2">adaptive_mining_terminal.log</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] bg-indigo-950/60 border border-indigo-500/15 text-indigo-400 px-2 py-0.5 rounded font-bold tracking-widest uppercase animate-pulse">
                  AGENT ACTIVE
                </span>
                <div className="h-3 w-3 bg-indigo-500 rounded-full animate-ping"></div>
                <Button type="button" variant="outline" size="sm" onClick={handleCancelDiscovery} className="h-7 text-[10px]">
                  Cancel
                </Button>
              </div>
            </div>

            <div className="p-5 font-mono text-[11px] text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
              <div className="flex gap-3 items-center mb-1">
                <div className="relative h-4 w-4 shrink-0">
                  <div className="absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent animate-spin"></div>
                </div>
                <div className="text-xs text-slate-100 font-black tracking-tight">
                  Adaptive Discovery Feedback Engine & Auto-Correct Log
                </div>
              </div>

              {terminalLogs.length > 0 ? (
                terminalLogs.map((log, i) => {
                  let colorClass = "text-slate-350";
                  if (log.includes("WAITING") || log.includes("FILTERING")) colorClass = "text-amber-400 font-bold";
                  if (log.includes("REQUEST") || log.includes("QUERY") || log.includes("DISCOVERY") || log.includes("EVIDENCE") || log.includes("EXTRACTION")) colorClass = "text-indigo-400 font-bold";
                  return (
                    <motion.div 
                      key={i} 
                      className={`${colorClass} leading-relaxed flex items-start gap-1`}
                      initial={{ opacity: 0, x: -5 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <span className="shrink-0 text-slate-600 select-none">{">"}</span>
                      <span>{log}</span>
                    </motion.div>
                  );
                })
              ) : (
                <p className="text-slate-500 italic">Initiating diagnostic agent subroutines...</p>
              )}
            </div>
            <TraceSummaryViewer traceEvents={liveTraceEvents} />
          </div>
        )}

        {/* Feedback results */}
        <AnimatePresence>
          {successMsg && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mt-6 border border-emerald-500/20 bg-emerald-500/5 p-4 rounded-xl flex gap-3 text-emerald-300 text-sm"
            >
              <Check className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-200">{successMsg}</p>
                {sourceLinks.length > 0 && (
                  <div className="mt-2.5">
                    <span className="text-xs font-semibold text-emerald-400 block mb-1">Sources Grounding References:</span>
                    <div className="flex flex-wrap gap-2">
                      {sourceLinks.slice(0, 3).map((link, i) => (
                        <a
                          key={i}
                          href={link.uri}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all text-emerald-200 text-xs px-2.5 py-1 rounded-md flex items-center gap-1 font-medium"
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

          {errorCode && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mt-6 border border-rose-500/20 bg-rose-500/5 p-4 rounded-xl flex gap-3 text-rose-300 text-sm"
            >
              <AlertCircle className="w-5 h-5 text-rose-450 shrink-0" />
              <div>
                <p className="font-semibold text-rose-200">Operation Failed</p>
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
            <div className="flex items-center gap-2 border-b pb-3 mb-4">
            <History className="w-5 h-5 text-slate-400" />
            <h3 className="text-sm font-bold text-slate-200">Scraping Task Status Center</h3>
          </div>
          
          <div className="space-y-3 max-h-[280px] overflow-y-auto pr-1">
            {tasks.map((task) => (
              <div 
                key={task.id} 
                className="p-3 bg-slate-950/60 rounded-xl border border-slate-850 flex items-center justify-between text-xs transition-colors hover:bg-slate-900"
              >
                <div className="max-w-[70%]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-300">
                    {task.type === 'url' && <Globe className="w-3.5 h-3.5 text-indigo-400" />}
                    {task.type === 'paste' && <Clipboard className="w-3.5 h-3.5 text-cyan-400" />}
                    {task.type === 'search' && <Search className="w-3.5 h-3.5 text-blue-450" />}
                    <span className="truncate">{task.query}</span>
                  </div>
                  <span className="text-[10px] text-slate-550 block mt-1">
                    {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                
                <div>
                  {task.status === 'processing' && (
                    <span className="px-2 py-1 bg-amber-500/10 text-amber-350 ring-1 ring-amber-500/20 rounded-md flex items-center gap-1 font-bold text-[10px] animate-pulse">
                      <RefreshCw className="w-2.5 h-2.5 animate-spin" /> Mining
                    </span>
                  )}
                  {task.status === 'completed' && (
                    <span className="px-2 py-1 bg-emerald-500/10 text-emerald-450 ring-1 ring-emerald-500/20 rounded-md flex items-center gap-1 font-bold text-[10px]">
                      <Check className="w-2.5 h-2.5" /> 
                      {task.resultCount ? `+${task.resultCount} leads` : 'Done'}
                    </span>
                  )}
                  {task.status === 'failed' && (
                    <span className="px-2 py-1 bg-rose-505/10 text-rose-400 ring-1 ring-rose-500/20 rounded-md flex items-center gap-1 font-bold text-[10px]">
                      <AlertCircle className="w-2.5 h-2.5" /> Blocked
                    </span>
                  )}
                  {task.status === 'idle' && (
                    <span className="px-2 py-1 bg-slate-800 text-slate-400 rounded-md font-bold text-[10px]">
                      Queued
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800/80">
          <div className="bg-indigo-500/5 p-3.5 rounded-xl flex items-start gap-2.5 text-xs text-indigo-300 border border-indigo-500/15">
            <Database className="w-4.5 h-4.5 text-indigo-400 shrink-0 mt-0.5 animate-pulse" />
            <div>
              <p className="font-semibold text-slate-200">CRM Pipeline Synced</p>
              <p className="text-slate-400 leading-relaxed mt-0.5">Scraped profiles are directly integrated and formatted as clean database records in your CRM dashboard below.</p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setShowLogs(true)} className="gap-2 text-slate-300">
            <History className="w-4 h-4" /> View Search Session Logs
          </Button>
        </div>
        </CardContent>
      </Card>

      <AnimatePresence>
        {showLogs && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
                <h3 className="font-bold text-lg text-slate-200 flex items-center gap-2">
                  <History className="w-5 h-5 text-indigo-400" /> Agentic Search Session Logs
                </h3>
                <Button variant="ghost" size="sm" onClick={() => setShowLogs(false)}>Close</Button>
              </div>
              <div className="p-4 overflow-y-auto flex-1 space-y-4 custom-scrollbar">
                {searchLogs.length === 0 ? (
                  <p className="text-slate-500 text-center py-8">No search logs found.</p>
                ) : (
                  searchLogs.map(log => (
                    <div key={log.id} className={`p-4 rounded-lg border ${log.status === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' : log.status === 'running' ? 'border-amber-500/20 bg-amber-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div className="text-xs text-slate-400">{new Date(log.timestamp).toLocaleString()}</div>
                        <Badge variant="outline" className={log.status === 'success' ? 'text-emerald-400 border-emerald-500/30' : log.status === 'running' ? 'text-amber-400 border-amber-500/30' : 'text-rose-400 border-rose-500/30'}>
                          {log.status.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="mb-3">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Original Prompt</p>
                        <p className="text-sm text-slate-200 italic">"{log.prompt}"</p>
                      </div>
                      <div className="mb-3">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">LLM Generated Queries</p>
                        <ul className="list-disc pl-5 space-y-1">
                          {log.generatedQueries.map((q, i) => (
                            <li key={i} className="text-xs text-indigo-300 font-mono">{q}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex gap-4 mt-3 pt-3 border-t border-slate-800">
                        {log.status === 'error' ? (
                          <div className="text-xs text-rose-400"><span className="font-semibold text-rose-500">Error:</span> {log.errorMessage}</div>
                        ) : log.status === 'running' ? (
                          <div className="text-xs text-amber-300"><span className="font-semibold text-amber-400">Running:</span> backend search session started; refresh logs for progress or completion.</div>
                        ) : (
                          <>
                            <div className="text-xs text-slate-400"><span className="text-slate-300 font-semibold">{log.rawResultsCount}</span> raw results found</div>
                            <div className="text-xs text-slate-400"><span className="text-emerald-400 font-semibold">{log.leadsFound}</span> leads extracted</div>
                          </>
                        )}
                      </div>
                      <TraceSummaryViewer traceSummary={log.traceSummary} traceEvents={log.traceEvents || []} />
                      {log.detailedLogs && (
                        <div className="mt-4 pt-3 border-t border-slate-800/50">
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Adaptive Terminal Output</p>
                          <pre className="text-[10px] sm:text-xs text-slate-400 font-mono bg-slate-950 p-3 rounded overflow-x-auto border border-slate-800 max-h-64 custom-scrollbar whitespace-pre-wrap">
                            {log.detailedLogs}
                          </pre>
                        </div>
                      )}
                      <DebugLogsViewer debugLogsStr={log.debugLogs} />
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

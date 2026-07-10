/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useState } from 'react';
import { LeadProvider, useLeads } from './context/LeadContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sparkles, 
  Layers, 
  FolderLock, 
  TableProperties, 
  FileBadge2, 
  Gauge, 
  Wand2, 
  Plus, 
  ArrowRight, 
  User, 
  Briefcase, 
  MapPin, 
  Mail, 
  Tag, 
  X, 
  Database,
  Search,
  ChevronRight,
  Check
} from 'lucide-react';
import { LinkedInProfile, Lead } from './types';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Large workspaces load only when the user opens their tab.
const ScrapeWorkspace = lazy(() => import('./components/ScrapeWorkspace'));
const CrmPipeline = lazy(() => import('./components/CrmPipeline'));
const LeadTable = lazy(() => import('./components/LeadTable'));
const OutreachStudio = lazy(() => import('./components/OutreachStudio'));
const CrmOverview = lazy(() => import('./components/CrmOverview'));
const CrmCopilot = lazy(() => import('./components/CrmCopilot'));

class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
          <section className="mx-auto max-w-xl rounded-xl border border-rose-500/30 bg-slate-900 p-6 shadow-2xl">
            <p className="text-sm font-semibold text-rose-300">Apex CRM could not render this workspace.</p>
            <p className="mt-2 text-sm text-slate-300">
              Reload the app to recover. If this repeats, the browser console contains the underlying error.
            </p>
            <button
              type="button"
              className="mt-5 rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400"
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
  <div className="min-h-56 grid place-items-center text-sm text-slate-400" role="status">
    Loading workspace...
  </div>
);

import { predictiveScoreFromComposite, scoreLeadDeterministically } from './utils/leadScore';

/* Removed demo seed records. Real CRM state is loaded from SQLite or an explicit legacy-browser migration.
const seedLeads: Lead[] = [
  {
    id: 'seed-siskind',
    profile: {
      id: 'gregory-siskind',
      fullName: 'Gregory Siskind',
      headline: 'Award-winning Immigration Attorney, Legal AI Pioneer & Co-founder of Siskind Susser PC',
      currentCompany: 'Siskind Susser PC / Visalaw AI',
      currentTitle: 'Founding Partner & Chief Legal AI Innovator',
      seniorityLevel: 'Founder',
      companySizeEst: '51-200',
      location: 'Memphis, TN',
      industry: 'Legal Services',
      summary: 'Gregory Siskind is a nationally recognized immigration lawyer, co-author of several major treatises, and a leading legal technology innovator. He co-founded Siskind Susser PC in 1994 (Tennessee\'s first legal web page) and is the vanguard of Visalaw AI, building generative AI legal tools.',
      contactDetails: {
        email: 'gsiskind@visalaw.com',
        phone: '+1 (901) 682-6455',
        linkedinUrl: 'https://www.linkedin.com/in/siskind/',
        website: 'https://www.visalaw.com'
      },
      experiences: [
        {
          title: 'Founding Partner & Attorney',
          company: 'Siskind Susser PC',
          duration: '1994 - Present',
          location: 'Memphis, TN',
          description: 'Managing one of the largest immigration law firms in the USA. Pioneer internet legal marketing and digital workflows for visa processing and corporate compliance.'
        },
        {
          title: 'Co-founder & Chief Product Officer',
          company: 'Visalaw AI',
          duration: '2022 - Present',
          location: 'Memphis, TN',
          description: 'Overseeing product strategy for GenAI-powered search grounding engines, compliance validators, and chat-based legal research assistants for immigration specialists.'
        }
      ],
      education: [
        {
          school: 'Vanderbilt University Law School',
          degree: 'Juris Doctor (JD)',
          duration: '1987 - 1990'
        },
        {
          school: 'The College of William & Mary',
          degree: 'Bachelor of Arts',
          fieldOfStudy: 'Political Science',
          duration: '1983 - 1987'
        }
      ],
      skills: ['Immigration Law', 'Legal Technology', 'Product Architecture', 'GenAI', 'Digital Marketing']
    },
    stage: 'ENRICHED',
    notes: 'Primary targeted lead directly matching requested lookup details. High interest sector, expert in legal LLM tooling.',
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    tags: ['Key Target', 'Legal AI Pioneer', 'Premium Account'],
    fitScore: 9,
    intentScore: 8,
    timingScore: 7,
    compositeScore: 8.2,
    tier: 'TIER 1: PRIORITY'
  },
  {
    id: 'seed-aris',
    profile: {
      id: 'aris-thompson',
      fullName: 'Aris Thompson',
      headline: 'Founder & CEO of Lexic AI - Generative Legal Intelligence Workspace',
      currentCompany: 'Lexic AI',
      currentTitle: 'Founder & CEO',
      seniorityLevel: 'Founder',
      companySizeEst: '11-50',
      location: 'San Francisco, CA',
      industry: 'Software Engineering',
      summary: 'Aris is a software engineer and serial entrepreneur building advanced document-reasoning graphs for commercial litigation and law operations. Ex-Stripe staff architect.',
      contactDetails: {
        email: 'aris@lexic.ai',
        linkedinUrl: 'https://www.linkedin.com/in/aris-thompson-mock/',
        website: 'https://lexic.ai'
      },
      experiences: [
        {
          title: 'Founder & CEO',
          company: 'Lexic AI',
          duration: '2023 - Present',
          location: 'San Francisco, CA',
          description: 'Architecting vectors database structures and search grounding middleware to help enterprise litigators mine 100M+ corporate emails safely.'
        },
        {
          title: 'Staff Software Engineer',
          company: 'Stripe',
          duration: '2019 - 2023',
          location: 'San Francisco, CA',
          description: 'Led core billing systems optimization. Built scalable ledger structures processing upwards of 2B daily transactional logs.'
        }
      ],
      education: [
        {
          school: 'Stanford University',
          degree: 'B.S.',
          fieldOfStudy: 'Computer Science',
          duration: '2015 - 2019'
        }
      ],
      skills: ['Distributed Systems', 'PostgreSQL', 'LegalTech', 'Vector Databases', 'Startups']
    },
    stage: 'MEETING BOOKED',
    notes: 'Intro schedule set for next Wednesday at 2 PM PST. They are looking to leverage our direct CSV integration models.',
    createdAt: new Date(Date.now() - 3600000 * 48).toISOString(),
    tags: ['Founder', 'Warm Intro', 'SF Based'],
    fitScore: 8,
    intentScore: 9,
    timingScore: 8,
    compositeScore: 8.4,
    tier: 'TIER 1: PRIORITY'
  },
  {
    id: 'seed-julia',
    profile: {
      id: 'julia-chen',
      fullName: 'Julia Chen',
      headline: 'VP of Recruit & Human Talents at CloudTech Global',
      currentCompany: 'CloudTech Global',
      currentTitle: 'VP of Human Talents',
      seniorityLevel: 'VP',
      companySizeEst: '500+',
      location: 'Austin, TX',
      industry: 'Human Resources',
      summary: 'Experienced executive recruiter leading talent strategy across North America and APAC markets. Focused on tech hiring scaling vectors.',
      contactDetails: {
        email: 'jchen@cloudtech-global.com',
        phone: '+1 (512) 555-8832',
        linkedinUrl: 'https://www.linkedin.com/in/julia-chen-mock/'
      },
      experiences: [
        {
          title: 'VP of Human Talents',
          company: 'CloudTech Global',
          duration: '2021 - Present',
          location: 'Austin, TX',
          description: 'Scaling engineering and go-to-market teams. Built a global recruitment structure hiring 500+ professionals annually.'
        }
      ],
      education: [
        {
          school: 'University of Texas at Austin',
          degree: 'B.B.A.',
          fieldOfStudy: 'Business & Management',
          duration: '2008 - 2012'
        }
      ],
      skills: ['Executive Search', 'Org Design', 'Scaling HR', 'Sourcing Platforms']
    },
    stage: 'SEQUENCE ACTIVE',
    notes: 'Outreach campaign initiated using our Conversational Tone email pitch sequence on June 4th. Awaiting feedback loop.',
    createdAt: new Date(Date.now() - 3600000 * 72).toISOString(),
    tags: ['Recruiting Executive', 'Outbound Pipe'],
    fitScore: 7,
    intentScore: 5,
    timingScore: 4,
    compositeScore: 5.6,
    tier: 'TIER 3: WATCH'
  }
]; */
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
  const response = await fetch('/api/leads', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads })
  });

  if (!response.ok) {
    throw new Error(`Failed to save leads: ${response.status}`);
  }
}

function Dashboard() {
  const { leads, saveLeadsToStorage, handleUpdateLeadStage, handleUpdateLeadNotes, handleUpdateLeadTags, handleDeleteLead } = useLeads();
  const { triggerToast } = useToast();
  const [activeTab, setActiveTab] = useState<'overview' | 'workspace' | 'pipeline' | 'inventory' | 'outreach'>('overview');
  
  const [selectedLeadForOutreach, setSelectedLeadForOutreach] = useState<Lead | null>(null);
  // Manual Lead Creation Form states
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualIndustry, setManualIndustry] = useState('Tech');
  const [manualSummary, setManualSummary] = useState('');

  // 9. Manual Creation Dispatch
  const handleManualLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualName.trim()) return;

    const newProfile: LinkedInProfile = {
      id: `manual-p-${Date.now()}`,
      fullName: manualName,
      headline: manualTitle ? `${manualTitle} @ ${manualCompany || 'Independent'}` : 'Professional',
      currentCompany: manualCompany || 'Independent',
      currentTitle: manualTitle || 'Professional',
      location: 'Undisclosed Location',
      industry: manualIndustry,
      summary: manualSummary || 'Manually loaded prospect details.',
      contactDetails: {
        email: manualEmail,
        linkedinUrl: manualUrl || undefined
      },
      experiences: manualTitle ? [{ title: manualTitle, company: manualCompany }] : []
    };

    saveLeadsToStorage(currentLeads => {
      // Manual creation duplicates protection
      const isDup = currentLeads.some(l => {
        const e1 = l.profile.contactDetails?.email?.toLowerCase();
        const e2 = (manualEmail || '').toLowerCase();
        const l1 = l.profile.contactDetails?.linkedinUrl?.toLowerCase();
        const l2 = (manualUrl || '')?.toLowerCase();
        const n1 = (l.profile.fullName || '').toLowerCase();
        const n2 = (manualName || '').toLowerCase();
        const comp1 = (l.profile.currentCompany || '').toLowerCase();
        const comp2 = (manualCompany || '').toLowerCase();

        return (
          (e1 && e2 && e1 === e2) ||
          (l1 && l2 && l1 === l2) ||
          (n1 === n2 && comp1 === comp2)
        );
      });

      if (isDup) {
        console.warn(`A profile for ${manualName} already exists in your CRM.`);
        return currentLeads;
      }

      const compositeScore = scoreLeadDeterministically(newProfile);
      const predictiveScore = predictiveScoreFromComposite(compositeScore);
      const newLead: Lead = {
        id: `lead-manual-${Date.now()}`,
        profile: newProfile,
        stage: 'SCRAPED',
        notes: 'Manually logged contact card.',
        createdAt: new Date().toISOString(),
        tags: ['Manual Entry'],
        compositeScore,
        predictiveScore
      };

      // Reset inputs
      setManualName('');
      setManualTitle('');
      setManualCompany('');
      setManualEmail('');
      setManualUrl('');
      setManualIndustry('Tech');
      setManualSummary('');
      setShowManualModal(false);

      return [newLead, ...currentLeads];
    });
  };

  // Trigger outbound writer navigation shortcut
  const handleSelectLeadForOutreach = (lead: Lead) => {
    setSelectedLeadForOutreach(lead);
    setActiveTab('outreach');
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 font-sans flex flex-col justify-between selection:bg-indigo-500/30 selection:text-white">
      
      {/* Ambient glow grids */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
      </div>

      {/* Dynamic Header */}
      <header className="bg-background/80 backdrop-blur-md border-b sticky top-0 z-40 relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-between">
          
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-primary text-primary-foreground rounded-xl flex items-center justify-center shadow">
              <Database className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="font-extrabold text-foreground text-sm tracking-tight">
                Apex CRM
              </h1>
              <Badge variant="secondary" className="text-[9px] mt-0.5 uppercase tracking-wider font-extrabold">
                CRM Active
              </Badge>
            </div>
          </div>

          {/* Navigation Controls */}
          <nav className="hidden lg:flex items-center gap-1.5">
            {[
              { id: 'overview', label: 'Overview', icon: Gauge },
              { id: 'workspace', label: 'Scraper Hub', icon: Sparkles },
              { id: 'pipeline', label: 'Kanban Pipeline', icon: Layers },
              { id: 'inventory', label: 'CRM Inventory', icon: TableProperties },
              { id: 'outreach', label: 'Outreach Studio', icon: Wand2 }
            ].map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <Button
                  key={tab.id}
                  variant={isSelected ? "secondary" : "ghost"}
                  onClick={() => setActiveTab(tab.id as any)}
                  className="flex items-center gap-2 h-9 px-3"
                >
                  <Icon className={`w-4 h-4 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                  {tab.label}
                </Button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setShowManualModal(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              Manual Contact
            </Button>
          </div>
        </div>

        {/* Responsive Mobile Nav Selector tab */}
        <div className="lg:hidden border-t border-slate-800/80 bg-slate-950/60 backdrop-blur-md px-4 py-2 flex gap-1.5 overflow-x-auto select-none">
          {[
            { id: 'overview', label: 'Overview', icon: Gauge },
            { id: 'workspace', label: 'Miner', icon: Sparkles },
            { id: 'pipeline', label: 'Pipeline', icon: Layers },
            { id: 'inventory', label: 'CRM', icon: TableProperties },
            { id: 'outreach', label: 'Outreach', icon: Wand2 }
          ].map(tab => {
            const Icon = tab.icon;
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-2 rounded-lg text-[11px] font-bold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer border ${
                  isSelected
                    ? 'bg-indigo-600 text-white border-indigo-550 shadow-md'
                    : 'bg-slate-900/40 border-slate-800/60 text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10">
        
        {/* Dynamic Navigation Content Layout */}
        <div className="space-y-6">
          {activeTab === 'workspace' && (
            <div>
            <div className="mb-6">
              <h2 className="text-xl font-extrabold text-white tracking-tight">Lead Extraction Terminal</h2>
              <p className="text-xs text-slate-400 mt-1">Acquire prospective detail schemas using direct URL mapping, raw text clipboard extraction, or general criteria discoverers.</p>
            </div>
              <Suspense fallback={<TabLoading />}><ScrapeWorkspace /></Suspense>
            </div>
          )}
<AnimatePresence mode="wait">
            {activeTab === 'overview' && (
              <motion.div
                key="tab-overview"
                initial={{ opacity: 0, y: 15, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -15, scale: 0.98 }}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              >
                <Suspense fallback={<TabLoading />}><CrmOverview leads={leads} /></Suspense>
              </motion.div>
            )}
            {activeTab === 'pipeline' && (
              <motion.div
                key="tab-pipeline"
                initial={{ opacity: 0, y: 15, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -15, scale: 0.98 }}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              >
                <div className="mb-6 flex justify-between items-center">
                  <div>
                    <h2 className="text-xl font-extrabold text-white tracking-tight">Visual Pipeline Workflow</h2>
                    <p className="text-xs text-slate-400 mt-1">Supervise outbound status stages and analyze qualification indexes.</p>
                  </div>
                </div>
                <Suspense fallback={<TabLoading />}><CrmPipeline
                  leads={leads}
                  onUpdateLeadStage={handleUpdateLeadStage}
                  onUpdateLeadNotes={handleUpdateLeadNotes}
                  onUpdateLeadTags={handleUpdateLeadTags}
                  onDeleteLead={handleDeleteLead}
                  onSelectLeadForOutreach={handleSelectLeadForOutreach}
                /></Suspense>
              </motion.div>
            )}

            {activeTab === 'inventory' && (
              <motion.div
                key="tab-inventory"
                initial={{ opacity: 0, y: 15, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -15, scale: 0.98 }}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              >
                <Suspense fallback={<TabLoading />}><LeadTable onAddManualLead={() => setShowManualModal(true)} /></Suspense>
              </motion.div>
            )}

            {activeTab === 'outreach' && (
              <motion.div
                key="tab-outreach"
                initial={{ opacity: 0, y: 15, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -15, scale: 0.98 }}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              >
                <div className="mb-6">
                  <h2 className="text-xl font-extrabold text-white tracking-tight">Outbound Copywriter Studio</h2>
                  <p className="text-xs text-slate-400 mt-1">Harness advanced model synthesis to write context-aware connection pitches and sequence campaigns.</p>
                </div>
                <Suspense fallback={<TabLoading />}><OutreachStudio
                  selectedLeadForOutreach={selectedLeadForOutreach}
                  leads={leads}
                /></Suspense>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <Suspense fallback={null}><CrmCopilot /></Suspense>

      {/* Manual log Contact Modal overlay */}
      <Dialog open={showManualModal} onOpenChange={setShowManualModal}>
        <DialogContent className="max-w-lg bg-slate-900 border-slate-800 text-slate-100">
          <DialogHeader className="border-b border-slate-800 pb-4">
            <DialogTitle>Manual Add Prospect</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleManualLeadSubmit} className="space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar pr-2 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-slate-400">Full Name</Label>
                <Input
                  type="text"
                  required
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="e.g. John Smith"
                  className="bg-slate-950 border-slate-850"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-slate-400">Sector/Industry</Label>
                <select
                  value={manualIndustry}
                  onChange={(e) => setManualIndustry(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="Legal Services">Legal Services</option>
                  <option value="Software Engineering">Software Engineering</option>
                  <option value="Human Resources">Human Resources</option>
                  <option value="Finance & Venture">Finance & Venture</option>
                  <option value="Healthcare">Healthcare</option>
                  <option value="Marketing">Marketing</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-slate-400">Current Job Title</Label>
                <Input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="e.g. Managing Director"
                  className="bg-slate-950 border-slate-850"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-slate-400">Company Name</Label>
                <Input
                  type="text"
                  value={manualCompany}
                  onChange={(e) => setManualCompany(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="bg-slate-950 border-slate-850"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-slate-400">Contact Email</Label>
              <Input
                type="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                placeholder="e.g. jsmith@acme.com"
                className="bg-slate-950 border-slate-850"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-slate-400">LinkedIn Profile URL</Label>
              <Input
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="e.g. https://linkedin.com/in/johnsmith"
                className="bg-slate-950 border-slate-850"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-slate-400">Biography Summary</Label>
              <Textarea
                value={manualSummary}
                onChange={(e) => setManualSummary(e.target.value)}
                placeholder="Provide a quick bio summary or intro logs for this lead..."
                rows={3}
                className="bg-slate-950 border-slate-850 resize-y"
              />
            </div>

            <DialogFooter className="pt-4 border-t border-slate-800">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowManualModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                Create Lead
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Styled Footer */}
      <footer className="bg-slate-900/40 border-t border-indigo-500/10 text-slate-500 text-[10px] text-center py-4">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2.5">
          <span>LinkedIn Scraper & Lead Discovery Platform - Built on Cloud Containers</span>
          <span className="font-semibold text-slate-400">Structured CRM Integration Suite - Active</span>
        </div>
      </footer>

    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <LeadProvider>
        <Dashboard />
      </LeadProvider>
    </ToastProvider>
  );
}

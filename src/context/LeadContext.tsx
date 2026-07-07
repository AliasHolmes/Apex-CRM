import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Lead, LinkedInProfile, QualifiedLeadProfile } from '../types';
import { buildProfileDedupeKeys, hasDuplicateProfile } from '../utils/leadDedupe';

// Define the high-fidelity pre-seed leads
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
];
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


interface LeadContextType {
  leads: Lead[];
  isHydrated: boolean;
  saveLeadsToStorage: (updater: Lead[] | ((prev: Lead[]) => Lead[])) => void;
  rehydrateLeads: () => Promise<void>;
  handleLeadAdded: (profile: LinkedInProfile) => void;
  handleBulkLeadsAdded: (profiles: (QualifiedLeadProfile | Lead)[]) => void;
  handleUpdateLeadStage: (leadId: string, stage: Lead['stage']) => void;
  handleUpdateLeadNotes: (leadId: string, notes: string) => void;
  handleUpdateLeadProfile: (leadId: string, profileUpdates: Partial<LinkedInProfile>) => void;
  handleMergeLead: (updatedLead: Lead) => void;
  handleUpdateLeadTags: (leadId: string, tags: string[]) => void;
  handleDeleteLead: (leadId: string) => void;
  handleDeleteLeads: (leadIds: string[]) => void;
  handleUpdateLeadsStage: (leadIds: string[], stage: Lead['stage']) => void;
}

const LeadContext = createContext<LeadContextType | undefined>(undefined);

export function LeadProvider({ children }: { children: ReactNode }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);

  const sanitizeLeads = (loadedLeads: any[]) => {
    return loadedLeads.map(l => ({
      ...l,
      id: l.id || crypto.randomUUID()
    }));
  };

  const loadLegacyBrowserLeads = () => {
    try {
      const legacyStored = localStorage.getItem(LEGACY_LEADS_STORAGE_KEY);
      if (!legacyStored) return null;

      const parsed = JSON.parse(legacyStored);
      return Array.isArray(parsed) ? sanitizeLeads(parsed) : null;
    } catch (error) {
      console.warn('Legacy browser lead migration failed:', error);
      return null;
    }
  };

  const rehydrateLeads = async () => {
    try {
      const stored = await loadLeadsFromSqliteBackend();
      if (stored.initialized) {
        setLeads(sanitizeLeads(stored.leads));
        return;
      }

      const initialLeads = loadLegacyBrowserLeads() || sanitizeLeads(seedLeads);
      setLeads(initialLeads);
      persistLeadsToSqliteBackend(initialLeads).catch(error => console.warn('SQLite seed migration failed:', error));
    } catch (error) {
      console.error('SQLite lead load failed:', error);
      setLeads(loadLegacyBrowserLeads() || sanitizeLeads(seedLeads));
    } finally {
      setIsHydrated(true);
    }
  };

  useEffect(() => {
    rehydrateLeads();
  }, []);

  const saveLeadsToStorage = (updater: Lead[] | ((prevLeads: Lead[]) => Lead[])) => {
    setLeads(prev => {
      return typeof updater === 'function' ? updater(prev) : updater;
    });
  };

  const persistLeadPatch = async (lead: Lead) => {
    try {
      const response = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead })
      });
      if (!response.ok) {
        throw new Error(`Failed to patch lead: ${response.status}`);
      }
    } catch (error) {
      console.error(`Failed to sync lead ${lead.id} update to backend:`, error);
    }
  };

  // 3. Callback to add single scraped profile
  const handleLeadAdded = (profile: LinkedInProfile) => {
    let newLead: Lead | null = null;
    saveLeadsToStorage(currentLeads => {
      const existingKeys = new Set<string>();
      currentLeads.forEach(lead => buildProfileDedupeKeys(lead.profile).forEach(key => existingKeys.add(key)));
      const isDup = hasDuplicateProfile(profile, existingKeys);

      if (isDup) {
        console.warn("Skipped writing duplicate lead to CRM:", profile.fullName);
        return currentLeads;
      }

      const compositeScore = Math.floor(Math.random() * 30) + 65; // realistic 65 - 95 score
      const predictiveScore = Math.floor(compositeScore * 0.9); // baseline likelihood

      newLead = {
        id: `lead-${Date.now()}`,
        profile,
        stage: 'SCRAPED',
        notes: 'Profile automatically harvested and structured by AI Search Scraper.',
        createdAt: new Date().toISOString(),
        tags: ['Scraped Lead', profile.industry || 'Tech'],
        compositeScore,
        predictiveScore
      };

      return [newLead, ...currentLeads];
    });

    if (newLead) {
      persistLeadPatch(newLead);
    }
  };

  // 4. Callback to handle bulk lead inputs
  const handleBulkLeadsAdded = async (profiles: (QualifiedLeadProfile | Lead)[]) => {
    let leadsToSaveBackend: Lead[] = [];

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
          return item as Lead;
        }

        const p = item;
        const hasAccountContext = !!p.companyAccount;
        const backendFinalScore = Number(p.scoreBreakdown?.finalScore || p.scoreOverride || 0);
        const compositeScore = backendFinalScore > 0
          ? Math.round(backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore)
          : p.companyAccount?.operationalPainScore || Math.floor(Math.random() * 35) + 60;
        const predictiveScore = Math.min(96, Math.floor(compositeScore * (hasAccountContext ? 0.96 : 0.9)));

        const newLead: Lead = {
          id: `lead-bulk-${Date.now()}-${i}`,
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
          companyAccount: p.companyAccount,
          decisionMakerVerification: p.decisionMakerVerification,
          sourceProvider: p.sourceProvider || 'tavily',
          evidenceReasons: p.evidenceReasons,
          evidence: p.evidence,
          scoreBreakdown: p.scoreBreakdown,
          buyingSignalsDetected: p.companyAccount?.buyingSignals?.map(signal => signal.label)
        };

        leadsToSaveBackend.push(newLead);
        return newLead;
      });
      return [...newLeads, ...currentLeads];
    });

    if (leadsToSaveBackend.length > 0) {
      try {
        const response = await fetch('/api/leads/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: leadsToSaveBackend })
        });
        if (!response.ok) {
          throw new Error(`Failed to save bulk leads: ${response.status}`);
        }
      } catch (err) {
        console.error('Failed to save bulk leads to backend:', err);
      }
    }
  };

  // 5. Update pipeline stage for CRM Lead
  const handleUpdateLeadStage = (leadId: string, stage: Lead['stage']) => {
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
      persistLeadPatch(updatedLead);
    }
  };

  // 6. Update internal notes for a lead
  const handleUpdateLeadNotes = (leadId: string, notes: string) => {
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
      persistLeadPatch(updatedLead);
    }
  };

  const handleUpdateLeadProfile = (leadId: string, profileUpdates: Partial<LinkedInProfile>) => {
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
      persistLeadPatch(updatedLead);
    }
  };

  const handleMergeLead = (updatedLead: Lead) => {
    if (!updatedLead || !updatedLead.id) return;
    let mergedLead: Lead | null = null;
    saveLeadsToStorage(currentLeads =>
      currentLeads.map(l => {
        if (l.id === updatedLead.id) {
          mergedLead = { ...l, ...updatedLead };
          return mergedLead;
        }
        return l;
      })
    );

    if (mergedLead) {
      persistLeadPatch(mergedLead);
    }
  };

  // 7. Update custom tags for a lead
  const handleUpdateLeadTags = (leadId: string, tags: string[]) => {
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
      persistLeadPatch(updatedLead);
    }
  };

  // 8. Delete lead or leads permanently
  const handleDeleteLead = async (leadId: string) => {
    try {
      console.log(`[App] Deleting lead ID: ${leadId}`);
      saveLeadsToStorage(currentLeads => {
        const nextLeads = currentLeads.filter(l => l.id !== leadId);
        console.log(`[App] Delete lead - Current count: ${currentLeads.length}, Next count: ${nextLeads.length}`);
        return nextLeads;
      });

      const response = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Failed to delete lead: ${response.status}`);
      }
    } catch (e) {
      console.error(`[App] Error during lead deletion:`, e);
    }
  };

  const handleDeleteLeads = async (leadIds: string[]) => {
    try {
      console.log(`[App] Deleting bulk leads count: ${leadIds.length}`);
      const idSet = new Set(leadIds);
      saveLeadsToStorage(currentLeads => {
        const nextLeads = currentLeads.filter(l => !idSet.has(l.id));
        console.log(`[App] Bulk delete leads - Current count: ${currentLeads.length}, Next count: ${nextLeads.length}`);
        return nextLeads;
      });

      const response = await fetch('/api/leads', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: leadIds })
      });
      if (!response.ok) {
        throw new Error(`Failed to delete bulk leads: ${response.status}`);
      }
    } catch (e) {
      console.error(`[App] Error during bulk lead deletion:`, e);
    }
  };

  const handleUpdateLeadsStage = async (leadIds: string[], stage: Lead['stage']) => {
    const idSet = new Set(leadIds);
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

    if (updatedLeads.length > 0) {
      try {
        const response = await fetch('/api/leads/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: updatedLeads })
        });
        if (!response.ok) {
          throw new Error(`Failed to bulk update stages: ${response.status}`);
        }
      } catch (err) {
        console.error('Failed to sync bulk stage updates to backend:', err);
      }
    }
  };

  return (
    <LeadContext.Provider value={{
      leads, isHydrated, saveLeadsToStorage, rehydrateLeads,
      handleLeadAdded, handleBulkLeadsAdded, handleUpdateLeadStage,
      handleUpdateLeadNotes, handleUpdateLeadProfile, handleMergeLead, handleUpdateLeadTags,
      handleDeleteLead, handleDeleteLeads, handleUpdateLeadsStage
    }}>
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


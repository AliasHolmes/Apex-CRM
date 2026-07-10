/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Briefcase, 
  MapPin, 
  Mail, 
  Phone, 
  Link2,
  Globe, 
  GraduationCap, 
  Tag, 
  FileText, 
  Trash2, 
  ChevronRight, 
  FolderLock, 
  Filter, 
  Search, 
  ExternalLink,
  ChevronLeft,
  X,
  Plus,
  Compass,
  Sparkles,
  RefreshCw,
  Check,
  Wand2
} from 'lucide-react';
import { Lead, LinkedInProfile } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface CrmPipelineProps {
  leads: Lead[];
  onUpdateLeadStage: (leadId: string, stage: Lead['stage']) => void;
  onUpdateLeadNotes: (leadId: string, notes: string) => void;
  onUpdateLeadTags: (leadId: string, tags: string[]) => void;
  onDeleteLead: (leadId: string) => void;
  onSelectLeadForOutreach: (lead: Lead) => void;
}

const pipelineStages: { id: Lead['stage']; label: string; bg: string; text: string; dot: string }[] = [
  { id: 'SCRAPED', label: '1. Scraped', bg: 'bg-slate-900/40', text: 'text-slate-200', dot: 'bg-indigo-400 font-extrabold animate-pulse' },
  { id: 'ENRICHED', label: '2. Enriched', bg: 'bg-slate-900/60', text: 'text-purple-200', dot: 'bg-purple-400' },
  { id: 'SEQUENCE ACTIVE', label: '3. Sequence Active', bg: 'bg-amber-950/20', text: 'text-amber-200', dot: 'bg-amber-400 font-bold' },
  { id: 'REPLIED', label: '4. Replied', bg: 'bg-orange-950/20', text: 'text-orange-200', dot: 'bg-orange-400' },
  { id: 'MEETING BOOKED', label: '5. Meeting Booked', bg: 'bg-emerald-950/20', text: 'text-emerald-200', dot: 'bg-emerald-400' },
  { id: 'NEGOTIATING', label: '6. Negotiating', bg: 'bg-emerald-950/30', text: 'text-emerald-300', dot: 'bg-emerald-500' },
  { id: 'CONVERTED', label: '7. Converted', bg: 'bg-emerald-900/50', text: 'text-emerald-400', dot: 'bg-emerald-500' },
  { id: 'NURTURE', label: 'Nurture', bg: 'bg-slate-800/40', text: 'text-slate-400', dot: 'bg-slate-500' },
  { id: 'LOST', label: 'Lost', bg: 'bg-red-950/20', text: 'text-red-300', dot: 'bg-red-500' }
];

const nextStageByCurrentStage: Partial<Record<Lead['stage'], Lead['stage']>> = {
  SCRAPED: 'ENRICHED',
  ENRICHED: 'SEQUENCE ACTIVE',
  'SEQUENCE ACTIVE': 'REPLIED',
  REPLIED: 'MEETING BOOKED',
  'MEETING BOOKED': 'NEGOTIATING',
  NEGOTIATING: 'CONVERTED',
  NURTURE: 'SEQUENCE ACTIVE'
};

export default function CrmPipeline({
  leads,
  onUpdateLeadStage,
  onUpdateLeadNotes,
  onUpdateLeadTags,
  onDeleteLead,
  onSelectLeadForOutreach
}: CrmPipelineProps) {
  // Local state for detailed view drawer
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndustry, setSelectedIndustry] = useState<string>('All');

  // One-Click AI Icebreaker Feature
  const [icebreaker, setIcebreaker] = useState<string>('');
  const [loadingIcebreaker, setLoadingIcebreaker] = useState(false);
  const [icebreakerError, setIcebreakerError] = useState('');
  const [copiedIcebreaker, setCopiedIcebreaker] = useState(false);

  React.useEffect(() => {
    setIcebreaker('');
    setIcebreakerError('');
  }, [selectedLeadId]);

  const handleGenerateIcebreaker = async (profile: LinkedInProfile) => {
    setLoadingIcebreaker(true);
    setIcebreakerError('');
    setIcebreaker('');
    try {
      const response = await fetch('/api/generate-outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile,
          tone: 'High-Value',
          pitchType: 'Short 1-Sentence Intro Hook Icebreaker'
        }),
      });
      if (!response.ok) {
        throw new Error(`Personalize database returned error status ${response.status}`);
      }
      const data = await response.json();
      setIcebreaker(data.text || '');
    } catch (err: any) {
      console.error(err);
      setIcebreakerError(err.message || 'Personalized icebreaker failed.');
    } finally {
      setLoadingIcebreaker(false);
    }
  };

  const selectedLead = leads.find(l => l.id === selectedLeadId);

  // Compute industries for filter
  const industries = ['All', ...Array.from(new Set(leads.map(l => l.profile.industry || 'Tech').filter(Boolean)))];

  // Filtering filter logic
  const filteredLeads = leads.filter(lead => {
    const profile = lead.profile || ({} as Partial<any>);
    const matchesSearch = 
      (profile.fullName || '').toLowerCase().includes(searchQuery.toLowerCase()) || 
      (profile.currentTitle || '').toLowerCase().includes(searchQuery.toLowerCase()) || 
      (profile.currentCompany || '').toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesIndustry = selectedIndustry === 'All' || (profile.industry || 'Tech') === selectedIndustry;
    
    return matchesSearch && matchesIndustry;
  });

  const getLeadScoreColor = (score?: number) => {
    if (!score) return 'bg-slate-800 text-slate-400';
    if (score >= 80) return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    if (score >= 50) return 'bg-blue-500/10 text-blue-300 border border-blue-500/20';
    return 'bg-amber-500/10 text-amber-300 border border-amber-500/20';
  };

  const handleCopy = (text?: string, label?: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    // Silent notification instead of iframe problematic native alerts
  };

  const handleAddTag = (leadId: string) => {
    if (!tagInput.trim() || !selectedLead) return;
    const currentTags = selectedLead.tags || [];
    if (!currentTags.includes(tagInput.trim())) {
      onUpdateLeadTags(leadId, [...currentTags, tagInput.trim()]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (leadId: string, tagToRemove: string) => {
    if (!selectedLead) return;
    const currentTags = selectedLead.tags || [];
    onUpdateLeadTags(leadId, currentTags.filter(t => t !== tagToRemove));
  };

  return (
    <div className="space-y-6">
      {/* Search & Filter Bar */}
      <Card className="shadow-lg mb-6">
        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-3.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search leads name, title, or employer..."
              className="pl-10"
            />
          </div>

          <div className="flex gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0 scrollbar-none items-center">
            <span className="text-muted-foreground text-xs font-bold flex items-center gap-1.5 uppercase shrink-0 py-2">
              <Filter className="w-3.5 h-3.5" /> Industry:
            </span>
            {industries.map(ind => (
              <Button
                key={ind}
                variant={selectedIndustry === ind ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedIndustry(ind)}
                className="h-8 shrink-0"
              >
                {ind}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Kanban Board Grid */}
      <div className="flex overflow-x-auto gap-6 pb-6 snap-x w-full">
        {pipelineStages.map(stage => {
          const stageLeads = filteredLeads.filter(l => l.stage === stage.id);
          
          return (
            <div key={stage.id} className="flex flex-col bg-slate-900/25 rounded-2xl p-4 border border-slate-800/70 min-h-[500px] min-w-[280px] w-80 snap-start shrink-0">
              {/* Header */}
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-800/50">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${stage.dot}`} />
                  <h4 className="font-extrabold text-slate-200 text-sm whitespace-nowrap">{stage.label}</h4>
                </div>
                <span className="bg-slate-950 border border-slate-800 text-slate-400 text-[10px] font-black px-2.5 py-0.5 rounded-full">
                  {stageLeads.length}
                </span>
              </div>

              {/* Lead Cards List */}
              <div className="space-y-4 flex-1 overflow-y-auto max-h-[600px] pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                <AnimatePresence mode="popLayout">
                  {stageLeads.length === 0 ? (
                    <div className="border border-dashed border-slate-800/80 rounded-xl p-6 text-center text-xs text-slate-500 font-medium my-4">
                      Empty
                    </div>
                  ) : (
                    stageLeads.map(lead => (
                      <motion.div
                        key={lead.id}
                        layoutId={`lead-${lead.id}`}
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        whileHover={{ y: -2 }}
                        className="cursor-pointer"
                        onClick={() => setSelectedLeadId(lead.id)}
                      >
                        <Card className="p-4 shadow-md hover:border-primary/30 transition-all focus-within:ring-1 focus-within:ring-primary/20 relative">
                          {/* Title Info */}
                          <div>
                            <div className="flex justify-between items-start gap-1">
                              <h5 className="font-extrabold text-foreground text-sm hover:text-primary transition-colors">
                                {lead.profile.fullName}
                              </h5>
                              {lead.compositeScore && (
                                <div className="flex flex-col gap-1 items-end">
                                  <Badge variant={lead.compositeScore >= 80 ? "default" : lead.compositeScore >= 60 ? "secondary" : "outline"} className="text-[9px] px-1.5 py-0.5">
                                    ICP: {lead.compositeScore}
                                  </Badge>
                                  {lead.predictiveScore && (
                                    <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-indigo-500/30 text-indigo-400">
                                      {lead.predictiveScore}% Close
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            
                            <p className="text-muted-foreground text-xs mt-0.5 font-bold truncate">
                              {lead.profile.currentTitle || 'Professional'}
                            </p>
                            <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] mt-2">
                              <Briefcase className="w-3.5 h-3.5 shrink-0 opacity-60" />
                              <span className="truncate">{lead.profile.currentCompany || 'Independent'}</span>
                            </div>
                            {lead.companyAccount && (
                              <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-emerald-300">
                                <Compass className="w-3.5 h-3.5" />
                                <span>{lead.companyAccount.buyingSignals.length} company signals - Pain {lead.companyAccount.operationalPainScore}</span>
                              </div>
                            )}
                            {lead.profile.location && (
                              <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] mt-1">
                                <MapPin className="w-3.5 h-3.5 shrink-0 opacity-60" />
                                <span className="truncate">{lead.profile.location}</span>
                              </div>
                            )}
                          </div>

                          {/* Custom Tags */}
                          {lead.tags && lead.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-3">
                              {lead.tags.slice(0, 2).map(tag => (
                                <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0.5 font-bold">
                                  {tag}
                                </Badge>
                              ))}
                              {lead.tags.length > 2 && (
                                <span className="text-[9px] text-muted-foreground self-center font-bold">
                                  +{lead.tags.length - 2} more
                                </span>
                              )}
                            </div>
                          )}

                          {/* Outbound Quick CTA */}
                          <div className="flex justify-between items-center mt-4 pt-3 border-t">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectLeadForOutreach(lead);
                              }}
                              className="text-[10px] h-6 px-2"
                            >
                              Create Pitch
                              <ChevronRight className="w-3 h-3 ml-1" />
                            </Button>

                            {/* Swap Stage buttons */}
                            <div className="flex items-center gap-1">
                              {stage.id !== 'SCRAPED' && (
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="w-6 h-6"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const idx = pipelineStages.findIndex(s => s.id === stage.id);
                                    onUpdateLeadStage(lead.id, pipelineStages[idx - 1].id);
                                  }}
                                  title="Move Back"
                                >
                                  <ChevronLeft className="w-3 h-3" />
                                </Button>
                              )}
                              {nextStageByCurrentStage[stage.id] && (
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="w-6 h-6"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const nextStage = nextStageByCurrentStage[stage.id];
                                    if (nextStage) onUpdateLeadStage(lead.id, nextStage);
                                  }}
                                  title="Advance Stage"
                                >
                                  <ChevronRight className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detailed Slide-Over Drawer Modal */}
      <AnimatePresence>
        {selectedLeadId && selectedLead && (
          <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.4 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedLeadId(null)}
              className="absolute inset-0 bg-black"
            />

            {/* Slide block Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="relative w-full max-w-2xl bg-slate-950 border-l border-slate-850 h-full shadow-2xl flex flex-col justify-between"
            >
              {/* Header Title / Actions */}
              <div className="p-6 border-b border-slate-850 flex items-center justify-between">
                <div>
                  <span className="px-2.5 py-1 text-[10px] font-bold rounded bg-indigo-500/10 text-indigo-300 border border-indigo-550/20 uppercase tracking-wide">
                    {selectedLead.profile.industry || 'Tech Sector'} Lead
                  </span>
                  <h3 className="font-extrabold text-white text-xl mt-1.5 flex items-center gap-2">
                    {selectedLead.profile.fullName}
                  </h3>
                </div>
                
                <div className="flex items-center gap-2">
                  <Button 
                    onClick={() => {
                      onSelectLeadForOutreach(selectedLead);
                      setSelectedLeadId(null);
                    }}
                    size="sm"
                    className="flex items-center gap-1.5"
                  >
                    AI Outreach Studio
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      onDeleteLead(selectedLead.id);
                      setSelectedLeadId(null);
                    }}
                    title="Remove Lead"
                    className="hover:border-destructive/30 hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelectedLeadId(null)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Scrollable Body */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-slate-850">
                {/* Headline Bio */}
                <div>
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-2">
                    <Compass className="w-4 h-4 text-indigo-400" />
                    Headline & Contact details
                  </h4>
                  <div className="bg-slate-900/60 rounded-xl p-4 border border-slate-850 space-y-3">
                    <p className="text-slate-200 text-sm font-bold leading-snug">
                      {selectedLead.profile.headline || 'No headline found.'}
                    </p>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      {selectedLead.profile.summary || 'Summary profile bio was not captured.'}
                    </p>
                    
                    {/* Contact details list */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-slate-800 text-xs">
                      {selectedLead.profile.contactDetails?.email && (
                        <div className="flex items-center gap-2 text-slate-300">
                          <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="truncate">{selectedLead.profile.contactDetails.email}</span>
                          <button
                            onClick={() => handleCopy(selectedLead.profile.contactDetails?.email, 'Email')}
                            className="ml-auto text-[10px] text-indigo-400 hover:underline cursor-pointer"
                          >
                            Copy
                          </button>
                        </div>
                      )}
                      {selectedLead.profile.contactDetails?.phone && (
                        <div className="flex items-center gap-2 text-slate-300">
                          <Phone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="truncate">{selectedLead.profile.contactDetails.phone}</span>
                        </div>
                      )}
                      {selectedLead.profile.contactDetails?.linkedinUrl && (
                        <div className="flex items-center gap-2 text-slate-350 col-span-1 md:col-span-2">
                          <Link2 className="w-3.5 h-3.5 text-slate-550 shrink-0" />
                          <a
                            href={selectedLead.profile.contactDetails.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-indigo-400 hover:underline flex items-center gap-1"
                          >
                            {selectedLead.profile.contactDetails.linkedinUrl}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {selectedLead.companyAccount && (
                  <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-bold text-emerald-200 flex items-center gap-2">
                          <Compass className="w-4 h-4 text-emerald-400" />
                          Company Pain Qualification
                        </h4>
                        <p className="text-xs text-slate-400 mt-1">{selectedLead.companyAccount.painSummary}</p>
                      </div>
                      <Badge variant="outline" className="border-emerald-500/30 text-emerald-300 shrink-0">
                        Pain {selectedLead.companyAccount.operationalPainScore}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {selectedLead.companyAccount.buyingSignals.map((signal, i) => (
                        <div key={i} className="bg-slate-950/50 border border-slate-800 rounded-xl p-3">
                          <div className="text-[11px] font-black text-slate-200">{signal.label}</div>
                          <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">{signal.evidence}</p>
                        </div>
                      ))}
                    </div>
                    {selectedLead.decisionMakerVerification && (
                      <p className="text-[11px] text-emerald-300 font-semibold">
                        {selectedLead.decisionMakerVerification.reason}
                      </p>
                    )}
                  </div>
                )}
                {/* Improvement 2: AI-Powered Intro Hook Icebreaker Card */}
                <div className="bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/25 rounded-2xl p-4.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h5 className="text-xs font-extrabold text-indigo-300 uppercase tracking-widest flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                      1-Click AI Personalization
                    </h5>
                    {icebreaker && (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(icebreaker);
                          setCopiedIcebreaker(true);
                          setTimeout(() => setCopiedIcebreaker(false), 2000);
                        }}
                        className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/15 px-2.5 py-1 rounded-md transition-all cursor-pointer"
                      >
                        {copiedIcebreaker ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-450 animate-pulse" />
                            Copied!
                          </>
                        ) : (
                          'Copy Hook'
                        )}
                      </button>
                    )}
                  </div>

                  {icebreaker ? (
                    <p className="text-xs text-slate-200 leading-relaxed italic bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80 font-mono">
                      "{icebreaker.replace(/^"|"$/g, '')}"
                    </p>
                  ) : icebreakerError ? (
                    <p className="text-xs text-rose-350 bg-rose-500/10 p-3 rounded-lg border border-rose-500/20">{icebreakerError}</p>
                  ) : (
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Leverage this profile's experiences and exact credentials to formulate a hyper-personalized CRM outbound intro line immediately.
                    </p>
                  )}

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      disabled={loadingIcebreaker}
                      onClick={() => handleGenerateIcebreaker(selectedLead.profile)}
                      className="bg-indigo-600/90 hover:bg-indigo-600 disabled:bg-slate-800 text-white font-bold text-[10px] px-3.5 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm cursor-pointer border border-indigo-500/20"
                    >
                      {loadingIcebreaker ? (
                        <>
                          <RefreshCw className="w-3 h-3 animate-spin text-indigo-300" />
                          Formulating hook...
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-3 h-3 text-indigo-300" />
                          Synthesize Hook Line
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Experiences timeline */}
                <div>
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-3">
                    <Briefcase className="w-4 h-4 text-indigo-400" />
                    Professional Work Experience
                  </h4>
                  {selectedLead.profile.experiences && selectedLead.profile.experiences.length > 0 ? (
                    <div className="space-y-4 border-l-2 border-slate-800 pl-4 ml-2">
                      {selectedLead.profile.experiences.map((exp, i) => (
                        <div key={i} className="relative">
                          {/* Chronological Dot badge */}
                          <div className="absolute -left-[25px] top-1.5 w-3 h-3 rounded-full border-2 border-slate-950 bg-indigo-500" />
                          <div>
                            <div className="flex flex-wrap items-baseline gap-1.5">
                              <h5 className="text-sm font-bold text-slate-200">{exp.title}</h5>
                              <span className="text-xs text-slate-500 font-medium">@ {exp.company}</span>
                            </div>
                            <span className="text-[9px] bg-slate-900 text-indigo-300 border border-slate-800 px-1.5 py-0.5 rounded font-mono block w-fit mt-1">
                              {exp.duration || 'Period undisclosed'}
                            </span>
                            {exp.description && (
                              <p className="text-slate-400 text-xs mt-2 leading-relaxed whitespace-pre-line">
                                {exp.description}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 bg-slate-900/40 p-4 rounded-xl border border-dashed border-slate-800">
                      No matching experience logs found on this profile card.
                    </p>
                  )}
                </div>

                {/* Education Section */}
                <div>
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-3">
                    <GraduationCap className="w-4 h-4 text-indigo-400" />
                    Education & Credentials
                  </h4>
                  {selectedLead.profile.education && selectedLead.profile.education.length > 0 ? (
                    <div className="space-y-3">
                      {selectedLead.profile.education.map((edu, i) => (
                        <div key={i} className="bg-slate-905 border border-slate-850 p-3 rounded-xl">
                          <h5 className="font-extrabold text-slate-200 text-xs">{edu.school}</h5>
                          {(edu.degree || edu.fieldOfStudy) && (
                            <p className="text-slate-450 text-xs mt-0.5 font-bold">
                              {edu.degree} {edu.fieldOfStudy ? `in ${edu.fieldOfStudy}` : ''}
                            </p>
                          )}
                          {edu.duration && (
                            <span className="text-[10px] text-slate-500 font-semibold block mt-1">
                              Class: {edu.duration}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">Academic background not loaded.</p>
                  )}
                </div>

                {/* Skills Cloud */}
                {selectedLead.profile.skills && selectedLead.profile.skills.length > 0 && (
                  <div>
                    <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-2">
                      <Tag className="w-4 h-4 text-indigo-400" />
                      Extracted Skills Cloud
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedLead.profile.skills.map(skill => (
                        <span key={skill} className="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 text-xs px-2.5 py-1 rounded border border-indigo-500/15 font-semibold">
                          {skill}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom tags editor */}
                <div>
                  <h4 className="text-sm font-bold text-slate-205 flex items-center gap-2 mb-2">
                    <Tag className="w-4 h-4 text-indigo-400" />
                    Lead Metadata Tags
                  </h4>
                  <div className="flex flex-wrap gap-1.5 p-3 bg-slate-900/60 rounded-xl border border-slate-850">
                    {selectedLead.tags?.map(tag => (
                      <span key={tag} className="bg-slate-950 border border-slate-800 text-slate-300 text-xs pl-2.5 pr-1.5 py-1 rounded-md flex items-center gap-1 font-semibold">
                        {tag}
                        <button
                          onClick={() => handleRemoveTag(selectedLead.id, tag)}
                          className="hover:bg-slate-850 text-slate-500 hover:text-white rounded p-0.5 cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <div className="flex gap-1 items-center bg-muted border rounded px-2 py-1">
                      <Input
                        type="text"
                        placeholder="Add tag"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTag(selectedLead.id);
                          }
                        }}
                        className="bg-transparent border-none h-6 w-20 text-xs px-1 shadow-none focus-visible:ring-0"
                      />
                      <button
                        onClick={() => handleAddTag(selectedLead.id)}
                        className="text-primary hover:text-primary/80 text-xs cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Internal Pipeline Memo notes */}
                <div>
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4 text-indigo-400" />
                    Internal CRM Notes & Logs
                  </h4>
                  <Textarea
                    value={selectedLead.notes || ''}
                    onChange={(e) => onUpdateLeadNotes(selectedLead.id, e.target.value)}
                    placeholder="Log interactions, pricing notes, or key takeaways for this lead..."
                    rows={4}
                    className="w-full mt-2 resize-y"
                  />
                  <span className="text-[10px] text-slate-550 block mt-1.5">
                    Saved automatically to internal browser storage.
                  </span>
                </div>
              </div>

              {/* Footer selection change */}
              <div className="p-4 border-t border-slate-850 bg-slate-950 text-xs flex flex-wrap gap-2 justify-between items-center">
                <span className="text-slate-500">Created: {new Date(selectedLead.createdAt).toLocaleDateString()}</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-400 font-bold mr-2">Lead Status:</span>
                  {pipelineStages.map(st => (
                    <button
                      key={st.id}
                      onClick={() => onUpdateLeadStage(selectedLead.id, st.id)}
                      className={`px-2 py-1.5 text-[10px] font-bold rounded cursor-pointer transition-colors ${
                        selectedLead.stage === st.id
                           ? 'bg-indigo-650 text-white border border-indigo-500 shadow-sm'
                           : 'bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-400'
                      }`}
                    >
                      {st.label.replace('Newly ', '').replace(' Leads', '')}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

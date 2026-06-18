/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sparkles, 
  Send, 
  FileText, 
  Clipboard, 
  RefreshCw, 
  Mail, 
  Linkedin, 
  Settings, 
  HelpCircle,
  Check,
  AlertTriangle,
  Layers,
  Type,
  UserCheck,
  PenTool,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Wand2,
  Gauge
} from 'lucide-react';
import { Lead } from '../types';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface OutreachStudioProps {
  selectedLeadForOutreach: Lead | null;
  leads: Lead[];
}

export default function OutreachStudio({ selectedLeadForOutreach, leads }: OutreachStudioProps) {
  const [currentLeadId, setCurrentLeadId] = useState<string>('');
  const [tone, setTone] = useState<string>('High-Value');
  const [medium, setMedium] = useState<string>('Cold Email');
  const [loading, setLoading] = useState(false);
  const [outreachCopy, setOutreachCopy] = useState<string>('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Expanded Personalization Fields
  const [senderName, setSenderName] = useState<string>('Arnob');
  const [senderCompany, setSenderCompany] = useState<string>('Lead-Finder Pro');
  const [valueProposition, setValueProposition] = useState<string>(
    'building customized search-grounded workflows to automate verified prospect routing directly into active CRMs'
  );
  const [sequenceStep, setSequenceStep] = useState<string>('Step 1: First Touch');
  const [customInstruction, setCustomInstruction] = useState<string>('');
  const [showSenderConfig, setShowSenderConfig] = useState<boolean>(false);

  const stepsList = [
    { id: 'Step 1: First Touch', label: 'Step 1: Initial Pitch', icon: Sparkles },
    { id: 'Step 2: Value Demonstration', label: 'Step 2: Case Study', icon: Layers },
    { id: 'Step 3: Friendly Bump', label: 'Step 3: Quick Bump', icon: Send }
  ];

  // Synchronize selection changes from parent or select first lead
  useEffect(() => {
    if (selectedLeadForOutreach) {
      setCurrentLeadId(selectedLeadForOutreach.id);
    } else if (leads.length > 0 && !currentLeadId) {
      setCurrentLeadId(leads[0].id);
    }
  }, [selectedLeadForOutreach, leads]);

  const targetLead = leads.find(l => l.id === currentLeadId);

  const handleGeneratePitch = async (appliedMacroDirective?: string) => {
    if (!targetLead) {
      setErrorCode('Please select a lead first.');
      return;
    }

    setLoading(true);
    setErrorCode(null);
    setOutreachCopy('');

    const activeInstruction = appliedMacroDirective !== undefined ? appliedMacroDirective : customInstruction;
    if (appliedMacroDirective !== undefined) {
      setCustomInstruction(appliedMacroDirective);
    }

    try {
      const response = await fetch('/api/generate-outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: targetLead.profile,
          tone,
          pitchType: medium,
          valueProposition,
          senderName,
          senderCompany,
          sequenceStep,
          customInstruction: activeInstruction
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Outbound engine failed with Status ${response.status}`);
      }

      const data = await response.json();
      setOutreachCopy(data.text || '');
    } catch (err: any) {
      console.error(err);
      setErrorCode(err.message || 'Error generating campaign pitch.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyToClipboard = () => {
    if (!outreachCopy) return;
    navigator.clipboard.writeText(outreachCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getMailToLink = () => {
    if (!targetLead || !outreachCopy) return '#';
    const email = targetLead.profile.contactDetails?.email || '';
    
    // Extract subject line if possible
    let subject = 'Connecting with you';
    const lines = outreachCopy.split('\n');
    const subjLine = lines.find(l => l.toLowerCase().includes('subject:'));
    if (subjLine) {
      subject = subjLine.replace(/subject:/i, '').trim();
    }
    
    // Escape email body text
    const cleanBody = outreachCopy
      .replace(/subject:.*\n/i, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
      
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cleanBody)}`;
  };

  // Real-time Text Copywriting Assessments
  const checkSpamTriggers = (text: string) => {
    const spamKeywords = [
      'guarantee', 'guaranteed', '100% free', 'risk-free', 'miracle', 'make money', 
      'make cash', 'earn cash', 'double your sales', 'no obligation', 'winning', 
      'secrets', 'act now', 'limited time', 'winner', 'millionaire', 'buy now'
    ];
    return spamKeywords.filter(word => text.toLowerCase().includes(word));
  };

  const getPersonalizationScore = (text: string) => {
    if (!targetLead || !text) return { score: 0, items: [] as string[] };
    
    const items = [];
    const lowerText = text.toLowerCase();
    
    const firstName = targetLead.profile.fullName.split(' ')[0].toLowerCase();
    if (lowerText.includes(firstName)) items.push('First Name');
    
    const org = (targetLead.profile.currentCompany || '').toLowerCase();
    if (org && lowerText.includes(org)) items.push('Company Link');
    
    const title = (targetLead.profile.currentTitle || '').toLowerCase();
    if (title && lowerText.includes(title)) items.push('Role Context');
    
    const score = items.length === 3 ? 'High' : items.length === 2 ? 'Medium' : items.length === 1 ? 'Low' : 'None';
    return { score, matches: items };
  };

  const wordCount = outreachCopy ? outreachCopy.trim().split(/\s+/).filter(Boolean).length : 0;
  const spamMatches = outreachCopy ? checkSpamTriggers(outreachCopy) : [];
  const personalizationCheck = outreachCopy ? getPersonalizationScore(outreachCopy) : { score: 'None', matches: [] };
  const readingTimeSeconds = Math.ceil((wordCount / 130) * 60);

  const polishMacros = [
    { label: 'Shorten Draft ⏱️', directive: 'Please make the pitch extremely punchy, energetic, and under 90 words.' },
    { label: 'Soften Call-To-Action 🤝', directive: 'Change the CTA portion to be low-friction, interest-based (e.g. open to seeing a 20s video on this?).' },
    { label: 'Emphasize ROI & Metrics 📈', directive: 'Introduce a realistic business performance value point or metrics (e.g. 44% lift in bookings).' },
    { label: 'Casual & Conversational ☕', directive: 'Rewrite using a highly casual, warm tone resembling a peer-to-peer slack chat instead of generic cold outbound.' }
  ];

  return (
    <Card className="shadow-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x border-0 relative">
      {/* Parameters Panel */}
      <div className="lg:col-span-2 p-6 space-y-6 bg-slate-950/45 max-h-[850px] overflow-y-auto custom-scrollbar">
        <div>
          <h3 className="font-extrabold text-white text-base flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-indigo-400 animate-pulse animate-duration-1000" id="campaign-title-icon" />
            AI Sequence outbound Studio
          </h3>
          <p className="text-xs text-slate-400 mt-1">Configure hyper-targeted prospect touches with multi-step sequencer alignment grounded in scraped background facts.</p>
        </div>

        {/* Selected Lead Selector */}
        <div className="space-y-1.5">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Target Prospect</label>
          <select
            value={currentLeadId}
            onChange={(e) => setCurrentLeadId(e.target.value)}
            disabled={loading || leads.length === 0}
            className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 text-slate-205 rounded-xl px-3.5 py-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/50 font-semibold cursor-pointer transition-all"
            id="lead-selector"
          >
            {leads.length === 0 ? (
              <option value="">No Leads Scraped Yet</option>
            ) : (
              leads.map(lead => (
                <option key={lead.id} value={lead.id}>
                  {lead.profile.fullName} ({lead.profile.currentCompany || 'Independent'})
                </option>
              ))
            )}
          </select>
        </div>

        {/* Sender details Accordion */}
        <div className="border border-slate-850 rounded-xl overflow-hidden bg-slate-950/30">
          <button 
            type="button"
            onClick={() => setShowSenderConfig(!showSenderConfig)}
            className="w-full p-3.5 flex items-center justify-between text-left text-xs font-bold text-slate-350 hover:text-white hover:bg-slate-900/40 transition-all cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-emerald-400" />
              Your Sender Signature Details
            </span>
            {showSenderConfig ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          <AnimatePresence>
            {showSenderConfig && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden border-t border-slate-850 bg-slate-950/80 p-4 space-y-3"
              >
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="block text-[9px] font-bold text-muted-foreground">My Name</label>
                    <Input 
                      type="text"
                      value={senderName}
                      onChange={(e) => setSenderName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[9px] font-bold text-muted-foreground">My Company / Tool</label>
                    <Input 
                      type="text"
                      value={senderCompany}
                      onChange={(e) => setSenderCompany(e.target.value)}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Value Proposition / Offer Input */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center">
            <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Our Core Value Prop / Offer</label>
            <span className="text-[10px] text-primary font-mono">Steers outreach hooks</span>
          </div>
          <Textarea
            value={valueProposition}
            onChange={(e) => setValueProposition(e.target.value)}
            disabled={loading}
            rows={2}
            className="resize-y"
            placeholder="E.g., building custom booking triggers or introducing a free marketing assessment audits..."
          />
        </div>

        {/* Tone Configuration */}
        <div className="space-y-1.5">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Outbound Tone Profile</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'Professional', desc: 'Authoritative & Solid' },
              { id: 'High-Value', desc: 'Case proof & ROI pitch' },
              { id: 'Conversational', desc: 'Casual, peer-like vibe' },
              { id: 'Bold', desc: 'Direct, challenge-driven' },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setTone(t.id)}
                disabled={loading}
                className={`p-3 rounded-xl border text-left transition-all duration-200 cursor-pointer ${
                  tone === t.id
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.1)]'
                    : 'border-slate-850 bg-slate-950 hover:bg-slate-900 text-slate-400'
                }`}
              >
                <div className="font-extrabold text-xs">{t.id}</div>
                <div className="text-[9px] text-slate-500 mt-0.5">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Medium Selector */}
        <div className="space-y-1.5">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Delivery Channel Channel</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'Cold Email', icon: Mail, label: 'Email' },
              { id: 'LinkedIn Connection Request', icon: Linkedin, label: 'Connect' },
              { id: 'Detailed InMail Pitch', icon: Settings, label: 'InMail' },
            ].map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  onClick={() => setMedium(m.id)}
                  disabled={loading}
                  className={`p-2.5 rounded-xl border text-center flex flex-col items-center justify-center gap-1.5 transition-all text-[11px] font-semibold cursor-pointer ${
                    medium === m.id
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.1)]'
                      : 'border-slate-850 bg-slate-950 hover:bg-slate-900 text-slate-450'
                  }`}
                >
                  <Icon className="w-4 h-4 text-indigo-400/80" />
                  <span className="leading-tight text-[10px]">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom AI Refines Instructions */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center">
            <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Custom Polish Directives</label>
            <span className="text-[10px] text-muted-foreground font-mono">Optional tweaks</span>
          </div>
          <Input
            type="text"
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            disabled={loading}
            placeholder="E.g. Focus on their specific state, or mention we guarantee 30 leads"
          />
        </div>

        <Button
          onClick={() => handleGeneratePitch()}
          disabled={loading || !targetLead}
          className="w-full py-6 text-xs shadow-md shadow-primary/10"
        >
          {loading ? (
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4 mr-2" />
          )}
          Generate High-Converting Pitch
        </Button>
      </div>

      {/* Editor / Output Panel */}
      <div className="lg:col-span-3 p-6 flex flex-col justify-between h-full bg-slate-900/5 space-y-5 min-h-[650px]">
        <div className="space-y-4">
          
          {/* Sequencer step tabs */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
            <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-850/80 rounded-xl">
              {stepsList.map(st => {
                const Icon = st.icon;
                const isActive = sequenceStep === st.id;
                return (
                  <button
                    key={st.id}
                    onClick={() => setSequenceStep(st.id)}
                    disabled={loading}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50 cursor-pointer ${
                      isActive 
                        ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30' 
                        : 'text-slate-400 hover:text-slate-205 hover:bg-slate-900/50 border border-transparent'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 text-indigo-400/80" />
                    <span>{st.label}</span>
                  </button>
                );
              })}
            </div>
            
            <span className="text-[10px] text-slate-500 font-extrabold tracking-widest uppercase">Sequence Stages</span>
          </div>

          {/* Quick Edit Control / Status Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PenTool className="w-4 h-4 text-slate-500" />
              <h4 className="font-bold text-slate-350 text-xs uppercase tracking-wider">Dynamic Composer Playground</h4>
            </div>
            
            {outreachCopy && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyToClipboard}
                  className="flex items-center gap-1.5"
                >
                  <Clipboard className="w-3.5 h-3.5" />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                
                {medium === 'Cold Email' && targetLead?.profile.contactDetails?.email && (
                  <Button
                    variant="secondary"
                    size="sm"
                    asChild
                  >
                    <a href={getMailToLink()} className="flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5" />
                      Mail in App
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Primary Textarea Composer Area */}
          <div className="min-h-[290px] border border-slate-850 bg-slate-950/80 rounded-2xl relative flex flex-col focus-within:ring-1 focus-within:ring-indigo-500/40 transition-all">
            <AnimatePresence mode="wait">
              {loading && (
                <div className="absolute inset-0 bg-slate-950/90 rounded-2xl z-20 flex flex-col items-center justify-center gap-3.5 shadow-2xl">
                  <div className="h-9 w-9 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"></div>
                  <div className="text-center space-y-1">
                    <p className="text-xs text-slate-205 font-bold animate-pulse">Personalizing outbound sequence hook using back-facts...</p>
                    <p className="text-[10px] text-slate-500">Injecting your value proposition and signature coordinates</p>
                  </div>
                </div>
              )}
            </AnimatePresence>

            {outreachCopy ? (
              <Textarea
                value={outreachCopy}
                onChange={(e) => setOutreachCopy(e.target.value)}
                disabled={loading}
                className="w-full flex-1 min-h-[300px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 resize-y whitespace-pre-wrap rounded-t-2xl custom-scrollbar"
                placeholder="Compose your personalized pitch copy details here..."
              />
            ) : errorCode ? (
              <div className="p-8 text-rose-450 flex items-start gap-2.5 font-bold text-xs bg-rose-950/10 border-b border-rose-950/30 rounded-t-2xl">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>Error generating sequence copy: {errorCode}. Verify that your parameters or connection triggers are mapped correctly.</span>
              </div>
            ) : (
              <div className="h-full flex-1 flex flex-col items-center justify-center text-center py-20 min-h-[300px]">
                <Send className="w-10 h-10 text-slate-700/60 mb-3" />
                <p className="font-extrabold text-xs text-slate-350">No touch point generated.</p>
                <p className="max-w-xs text-[10px] text-slate-500 mt-1.5 leading-relaxed">Select a lead and hit generate, or select any of the Sequence Tabs to synthesize professional customized outreach templates.</p>
              </div>
            )}
            
            {/* Interactive Quality Stats Ribbon */}
            {outreachCopy && (
              <div className="flex border-t border-slate-900 bg-slate-950/90 rounded-b-2xl p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-slate-400">
                <div className="space-y-0.5 border-r border-slate-900 pr-2">
                  <div className="text-[9px] uppercase tracking-wider font-extrabold text-slate-500">Word Count</div>
                  <div className={`text-xs font-bold ${wordCount > 150 && medium === 'Cold Email' ? 'text-amber-400' : 'text-slate-200'}`}>
                    {wordCount} words {wordCount > 150 && medium === 'Cold Email' && '⚠️'}
                  </div>
                </div>

                <div className="space-y-0.5 border-r border-slate-900 px-2">
                  <div className="text-[9px] uppercase tracking-wider font-extrabold text-slate-500">Read Time</div>
                  <div className="text-xs font-bold text-slate-200">{readingTimeSeconds} seconds</div>
                </div>

                <div className="space-y-0.5 border-r border-slate-900 px-2">
                  <div className="text-[9px] uppercase tracking-wider font-extrabold text-slate-500 flex items-center gap-1">
                    <Gauge className="w-3 h-3 text-emerald-400" /> Grounding Index
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant={
                      personalizationCheck.score === 'High' ? 'default' :
                      personalizationCheck.score === 'Medium' ? 'secondary' :
                      'outline'
                    } className="text-[10px] px-1.5 py-0.5">
                      {personalizationCheck.score}
                    </Badge>
                    <span className="text-[9px] text-muted-foreground">{personalizationCheck.matches.length}/3 tags</span>
                  </div>
                </div>

                <div className="space-y-0.5 pl-2">
                  <div className="text-[9px] uppercase tracking-wider font-extrabold text-slate-500">Spam Check</div>
                  <div className={`text-xs font-bold ${spamMatches.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {spamMatches.length === 0 ? '0 Triggers Safe' : `${spamMatches.length} Triggers ⚠️`}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Spam Warnings Card & Quick Macros Row */}
        <div className="space-y-4">
          
          {/* Quick Refinement Macro Directives */}
          <div className="space-y-2">
            <span className="text-[9px] uppercase tracking-wider font-extrabold text-slate-400 block">AI Micro-Polish Macros (Trigger dynamic regenerations)</span>
            <div className="flex flex-wrap gap-1.5">
              {polishMacros.map(macro => (
                <Button
                  key={macro.label}
                  variant="outline"
                  size="sm"
                  disabled={loading || !targetLead}
                  onClick={() => handleGeneratePitch(macro.directive)}
                  className="text-[10px]"
                >
                  {macro.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Real-time details alerting alerts */}
          <AnimatePresence>
            {outreachCopy && spamMatches.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="bg-amber-500/5 border border-amber-500/15 p-3 rounded-xl flex gap-2.5 text-xs text-amber-200/90 font-medium"
              >
                <ShieldAlert className="w-4.5 h-4.5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-extrabold text-amber-300">Outbound Copy carries spam danger keywords:</span>
                  <p className="text-[10px] mt-0.5 leading-tight text-slate-400">
                    Your sequence touch contains these filter triggers: <span className="font-semibold text-amber-400">{spamMatches.join(', ')}</span>. Consider replacing them in the workspace editor above so the campaign matches high delivery standards.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {targetLead && (
            <div className="bg-indigo-500/5 p-3.5 rounded-xl border border-indigo-500/10 text-xs text-slate-450 flex items-center justify-between gap-4">
              <div>
                <span className="font-bold text-indigo-300 block mb-1">🎯 Prospect Grounding Info:</span>
                <span className="text-slate-350">
                  Target: <span className="font-bold text-slate-200">{targetLead.profile.fullName}</span> | Industry: <span className="font-bold text-slate-200">{targetLead.profile.industry || 'B2B'}</span> | Email: <span className="font-bold text-slate-200">{targetLead.profile.contactDetails?.email || 'N/A'}</span>
                </span>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <Badge variant="outline" className="text-[10px] font-mono font-bold">
                  {(targetLead.profile.experiences || []).length} Exps
                </Badge>
                <Badge variant="outline" className="text-[10px] font-mono font-bold">
                  {(targetLead.profile.skills || []).length} Skills
                </Badge>
              </div>
            </div>
          )}
        </div>

      </div>
    </Card>
  );
}

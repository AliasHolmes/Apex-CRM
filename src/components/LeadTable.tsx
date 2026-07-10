/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { useLeads } from '../context/LeadContext';
import Papa from 'papaparse';
import { 
  FileDown, 
  Trash2, 
  Layers, 
  Mail, 
  Link2,
  Compass, 
  Search, 
  Sparkles, 
  Check, 
  UserPlus2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  X,
  UploadCloud,
  Loader2
} from 'lucide-react';
import { Lead, LinkedInProfile } from '../types';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";

interface LeadTableProps {
  leads: Lead[];
  handleUpdateLeadStage: (leadId: string, stage: Lead['stage']) => void;
  handleUpdateLeadsStage?: (leadIds: string[], stage: Lead['stage']) => void;
  handleDeleteLead: (leadId: string) => void;
  handleDeleteLeads?: (leadIds: string[]) => void;
  onAddManualLead: () => void;
  handleBulkLeadsAdded?: (profiles: LinkedInProfile[]) => void;
  handleUpdateLeadProfile?: (leadId: string, profileUpdates: Partial<LinkedInProfile>) => void;
}

export default function LeadTable({ onAddManualLead }: { onAddManualLead: () => void }) {
  const { leads, handleUpdateLeadStage, handleUpdateLeadsStage, handleDeleteLead, handleDeleteLeads, handleUpdateLeadProfile, handleBulkLeadsAdded, handleMergeLead } = useLeads();
  const { triggerToast } = useToast();
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('All');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  
  // High-fidelity custom toast message state
  const [showConfirmBulkDelete, setShowConfirmBulkDelete] = useState(false);
  const [showConfirmPurgeDuplicates, setShowConfirmPurgeDuplicates] = useState(false);
  const [duplicateIdsToDelete, setDuplicateIdsToDelete] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Enrichment step states
  const [enrichmentQueue, setEnrichmentQueue] = useState<Lead[]>([]);
  const [enrichmentStep, setEnrichmentStep] = useState<string>('');
  const [discoveringEmailIds, setDiscoveringEmailIds] = useState<string[]>([]);

  React.useEffect(() => {
    if (enrichmentQueue.length === 0) {
      setEnrichmentStep('');
      return;
    }

    let isCancelled = false;
    const item = enrichmentQueue[0];

    const processItem = async () => {
      setEnrichmentStep(`Targeting ${item.profile.fullName}: Scraping Bright Data & discovering email...`);
      try {
        const response = await fetch(`/api/leads/${item.id}/enrich-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            forceProfileScrape: true,
            forceEmailDiscovery: true
          })
        });

        if (isCancelled) return;

        if (response.ok) {
          const data = await response.json();
          if (data.lead && handleMergeLead) {
            handleMergeLead(data.lead);
            const outcome = data.profileEnrichment?.status || 'completed';
            triggerToast(`Enrichment ${outcome.replace(/_/g, ' ')} for ${item.profile.fullName}.`);
          } else if (data.lead && handleUpdateLeadProfile) {
            handleUpdateLeadProfile(item.id, data.lead.profile);
            triggerToast(`Successfully verified & enriched record for ${item.profile.fullName}.`);
          }
        } else {
          const errData = await response.json().catch(() => ({}));
          console.warn(`Enrichment failed for ${item.profile.fullName}:`, errData.error || response.statusText);
          triggerToast(`Failed to enrich ${item.profile.fullName}: ${errData.error || 'Server error'}`);
        }
      } catch (err: any) {
        if (!isCancelled) {
          console.error(`Error enriching ${item.profile.fullName}:`, err);
          triggerToast(`Error enriching ${item.profile.fullName}`);
        }
      } finally {
        if (!isCancelled) {
          setEnrichmentQueue(prev => prev.slice(1));
        }
      }
    };

    processItem();

    return () => {
      isCancelled = true;
    };
  }, [enrichmentQueue, handleMergeLead, handleUpdateLeadProfile]);


  const handleTriggerPurgeDuplicates = () => {
    const toDelete: string[] = [];
    const seenEmails = new Set<string>();
    const seenLinks = new Set<string>();
    const seenNames = new Set<string>();

    filteredLeads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase();
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      let isRedundant = false;

      if (email && seenEmails.has(email)) isRedundant = true;
      else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
      else if (nameKey !== '::' && seenNames.has(nameKey)) isRedundant = true;

      if (isRedundant) {
        toDelete.push(lead.id);
      } else {
        if (email) seenEmails.add(email);
        if (linkedin) seenLinks.add(linkedin);
        if (nameKey !== '::') seenNames.add(nameKey);
      }
    });

    if (toDelete.length > 0) {
      setDuplicateIdsToDelete(toDelete);
      setShowConfirmPurgeDuplicates(true);
    } else {
      triggerToast('No redundant duplicates found.');
    }
  };

  const handleExecutePurgeDuplicates = async () => {
    if (duplicateIdsToDelete.length === 0) return;
    try {
      if (handleDeleteLeads) {
        await handleDeleteLeads(duplicateIdsToDelete);
      } else {
        duplicateIdsToDelete.forEach(id => handleDeleteLead(id));
      }
      triggerToast(`Successfully purged ${duplicateIdsToDelete.length} duplicate leads.`);
      setDuplicateIdsToDelete([]);
      setShowConfirmPurgeDuplicates(false);
    } catch (error: any) {
      triggerToast(error.message || 'Could not delete duplicate leads. The CRM was reloaded.');
    }
  };

  // Helper to identify potential duplicates in the table
  const duplicateIds = React.useMemo(() => {
    const dupeIds = new Set<string>();
    const emailMap = new Map<string, string[]>();
    const linkMap = new Map<string, string[]>();
    const nameMap = new Map<string, string[]>();

    leads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase() || '';
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase() || '';
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      if (email) {
        if (!emailMap.has(email)) emailMap.set(email, []);
        emailMap.get(email)!.push(lead.id);
      }
      if (linkedin) {
        if (!linkMap.has(linkedin)) linkMap.set(linkedin, []);
        linkMap.get(linkedin)!.push(lead.id);
      }
      if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
      nameMap.get(nameKey)!.push(lead.id);
    });

    for (const ids of emailMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }
    for (const ids of linkMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }
    for (const ids of nameMap.values()) {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    }

    return dupeIds;
  }, [leads]);

  // Filter lists
  const filteredLeads = leads.filter(lead => {
    const p = lead.profile || ({} as Partial<any>);
    const matchesSearch = 
      (p.fullName || '').toLowerCase().includes(tableSearch.toLowerCase()) ||
      (p.currentTitle || '').toLowerCase().includes(tableSearch.toLowerCase()) ||
      (p.currentCompany || '').toLowerCase().includes(tableSearch.toLowerCase());
    
    const matchesStage = stageFilter === 'All' || lead.stage === stageFilter;
    return matchesSearch && matchesStage;
  });

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / pageSize));
  const activePage = Math.min(currentPage, totalPages);
  const currentPageStartIndex = (activePage - 1) * pageSize;
  const paginatedLeads = filteredLeads.slice(currentPageStartIndex, currentPageStartIndex + pageSize);
  const visibleLeadIds = paginatedLeads.map(l => l.id);
  const selectedVisibleLeadIds = visibleLeadIds.filter(id => selectedLeadIds.includes(id));
  const pageStart = filteredLeads.length === 0 ? 0 : currentPageStartIndex + 1;
  const pageEnd = Math.min(currentPageStartIndex + paginatedLeads.length, filteredLeads.length);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [tableSearch, stageFilter]);

  React.useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages));
  }, [totalPages]);

  // Toggle selection
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedLeadIds(prev => Array.from(new Set([...prev, ...visibleLeadIds])));
    } else {
      setSelectedLeadIds(prev => prev.filter(id => !visibleLeadIds.includes(id)));
    }
  };

  const handleSelectRow = (leadId: string, checked: boolean) => {
    if (checked) {
      setSelectedLeadIds(prev => [...prev, leadId]);
    } else {
      setSelectedLeadIds(prev => prev.filter(id => id !== leadId));
    }
  };

  const handleSelectDuplicates = () => {
    const toSelect = new Set<string>();
    const seenEmails = new Set<string>();
    const seenLinks = new Set<string>();
    const seenNames = new Set<string>();

    filteredLeads.forEach(lead => {
      const p = lead.profile || ({} as Partial<any>);
      const email = p.contactDetails?.email?.toLowerCase();
      const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
      const comp = (p.currentCompany || '').toLowerCase();
      const nameKey = `${(p.fullName || '').toLowerCase()}::${comp}`;

      let isRedundant = false;

      if (email && seenEmails.has(email)) isRedundant = true;
      else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
      else if (nameKey !== '::' && seenNames.has(nameKey)) isRedundant = true;

      if (isRedundant) {
        toSelect.add(lead.id);
      } else {
        if (email) seenEmails.add(email);
        if (linkedin) seenLinks.add(linkedin);
        if (nameKey !== '::') seenNames.add(nameKey);
      }
    });

    if (toSelect.size > 0) {
      setSelectedLeadIds(Array.from(toSelect));
      triggerToast(`Selected ${toSelect.size} redundant duplicate leads.`);
      // Optional auto-deletion, though UI select will let them review and use bulk delete
    } else {
      triggerToast('No redundant duplicates found.');
    }
  };

  // Bulk operators
  const handleBulkStageChange = async (stage: Lead['stage']) => {
    if (selectedLeadIds.length === 0) return;
    try {
      if (handleUpdateLeadsStage) {
        await handleUpdateLeadsStage(selectedLeadIds, stage);
      } else {
        selectedLeadIds.forEach(id => handleUpdateLeadStage(id, stage));
      }
      triggerToast(`Updated ${selectedLeadIds.length} lead stages to ${stage.toUpperCase()}!`);
      setSelectedLeadIds([]);
    } catch (error: any) {
      triggerToast(error.message || 'Could not update stages. The CRM was reloaded.');
    }
  };

  const handleFindEmail = async (lead: Lead) => {
    if (discoveringEmailIds.includes(lead.id)) return;
    setDiscoveringEmailIds(prev => [...prev, lead.id]);
    try {
      const response = await fetch(`/api/leads/${lead.id}/find-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Email discovery failed');
      if (data.lead && handleMergeLead) {
        handleMergeLead(data.lead);
      } else if (data.lead?.profile && handleUpdateLeadProfile) {
        handleUpdateLeadProfile(lead.id, data.lead.profile);
      }
      const status = data.emailDiscovery?.status || 'not_found';
      triggerToast(data.emailDiscovery?.bestEmail
        ? `Email discovery found ${data.emailDiscovery.bestEmail} (${status}).`
        : `Email discovery finished: ${status}.`);
    } catch (error: any) {
      triggerToast(error.message || 'Email discovery failed.');
    } finally {
      setDiscoveringEmailIds(prev => prev.filter(id => id !== lead.id));
    }
  };

  const handleStartEnrichment = () => {
    if (selectedLeadIds.length === 0) {
      triggerToast('Please select one or more leads using the checkboxes first.');
      return;
    }
    
    const targetLeads = leads.filter(l => selectedLeadIds.includes(l.id));
      
    if (targetLeads.length === 0) {
      triggerToast('No valid leads selected.');
      return;
    }
    
    setEnrichmentQueue(targetLeads);
    setSelectedLeadIds([]);
    triggerToast(`Queued ${targetLeads.length} lead(s) for AI background enrichment & email discovery.`);
  };

  const handleBulkDeleteAction = async () => {
    if (selectedLeadIds.length === 0) return;
    try {
      if (handleDeleteLeads) {
        await handleDeleteLeads(selectedLeadIds);
      } else {
        selectedLeadIds.forEach(id => handleDeleteLead(id));
      }
      triggerToast(`Successfully purged ${selectedLeadIds.length} leads.`);
      setSelectedLeadIds([]);
      setShowConfirmBulkDelete(false);
    } catch (error: any) {
      triggerToast(error.message || 'Could not delete leads. The CRM was reloaded.');
    }
  };

  const handleBulkDelete = () => {
    if (selectedLeadIds.length === 0) return;
    setShowConfirmBulkDelete(true);
  };

  // Compile and format CSV string
  const handleCsvExport = (exportAll: boolean) => {
    const targets = exportAll ? leads : leads.filter(l => selectedLeadIds.includes(l.id));
    
    if (targets.length === 0) {
      triggerToast('No leads selected. Check row circles to enable export.');
      return;
    }

    // Define CSV Headings
    const headings = [
      'ID',
      'First Name',
      'Last Name',
      'Full Name',
      'Pipeline Stage',
      'Current Title',
      'Current Company',
      'Corporate Email',
      'Phone Number',
      'LinkedIn Profile URL',
      'Industry Segment',
      'Geographic Location',
      'Skills Keywords',
      'Biography Summary',
      'Log Internal Notes',
      'Created Date'
    ];

    // Map each lead into a clean row array
    const csvRows = targets.map(lead => {
      const parts = lead.profile.fullName.trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const skillsStr = (lead.profile.skills || []).join('; ');
      
      const row = [
        lead.id,
        firstName,
        lastName,
        lead.profile.fullName,
        lead.stage,
        lead.profile.currentTitle || '',
        lead.profile.currentCompany || '',
        lead.profile.contactDetails?.email || '',
        lead.profile.contactDetails?.phone || '',
        lead.profile.contactDetails?.linkedinUrl || '',
        lead.profile.industry || 'Tech',
        lead.profile.location || '',
        skillsStr,
        lead.profile.summary || '',
        lead.notes || '',
        new Date(lead.createdAt).toLocaleDateString()
      ];

      // Escape quotes and double quotes for clean CSV syntax
      return row.map(v => {
        const value = String(v);
        const formulaSafeValue = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
        const escaped = formulaSafeValue.replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(',');
    });

    const csvContent = [headings.join(','), ...csvRows].join('\n');
    
    // Create Blob URL trigger download in browser safely
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `linkedin_crm_leads_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCsvImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const rows = results.data as Record<string, string>[];
          
          const newProfiles = rows.flatMap((row, i): LinkedInProfile[] => {
            // Flexible heuristic field mapping
            const getField = (keys: string[]) => {
              const matchingKey = Object.keys(row).find(k => keys.some(key => k.toLowerCase().includes(key)));
              return matchingKey ? row[matchingKey].trim() : '';
            };

            const fName = getField(['first', 'fn']);
            const lName = getField(['last', 'ln']);
            let fullName = getField(['full name', 'name', 'contact']);
            if (!fullName && (fName || lName)) {
              fullName = `${fName} ${lName}`.trim();
            }
            if (!fullName) return [];

            const company = getField(['company', 'employer', 'org']);
            const title = getField(['title', 'role', 'position']);
            const email = getField(['email']);
            const phone = getField(['phone', 'mobile']);
            const linkedinUrl = getField(['linkedin', 'profile url', 'url']);

            const industry = getField(['industry', 'sector']) || 'Tech';
            const location = getField(['location', 'country', 'city']);
            const summary = getField(['summary', 'bio', 'notes']);
            const skillsStr = getField(['skills', 'tags']);
            const skills = skillsStr ? skillsStr.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];

            return [{
              id: `imported-${Date.now()}-${i}`,
              fullName,
              headline: title ? `${title} @ ${company}` : 'Professional',
              currentCompany: company || 'Independent',
              currentTitle: title || 'Professional',
              location: location || 'Undisclosed Location',
              industry,
              summary: summary || 'Imported via bulk CSV upload.',
              contactDetails: {
                email,
                phone,
                linkedinUrl
              },
              skills
            }];
          });

          if (newProfiles.length === 0) {
            triggerToast('No valid named contacts found in the CSV. Nothing was imported.');
          } else if (handleBulkLeadsAdded) {
            await handleBulkLeadsAdded(newProfiles);
            const skipped = rows.length - newProfiles.length;
            triggerToast(`Imported ${newProfiles.length} contact${newProfiles.length === 1 ? '' : 's'} without synthetic enrichment.${skipped ? ` Skipped ${skipped} unnamed row${skipped === 1 ? '' : 's'}.` : ''}`);
          }
        } catch (err) {
          console.error(err);
          triggerToast('Failed to parse CSV effectively. Invalid format.');
        } finally {
          setIsImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      },
      error: (error) => {
        setIsImporting(false);
        triggerToast(`CSV Import Error: ${error.message}`);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    });
  };

  const getEmailStatusMeta = (status?: string) => {
    switch (status) {
      case 'confirmed_public': return { label: 'Public exact', className: 'border-emerald-500/30 text-emerald-400' };
      case 'company_public': return { label: 'Company public', className: 'border-sky-500/30 text-sky-400' };
      case 'pattern_likely': return { label: 'Pattern likely', className: 'border-amber-500/30 text-amber-400' };
      case 'domain_only': return { label: 'Domain only', className: 'border-slate-500/30 text-slate-400' };
      case 'not_found': return { label: 'Not found', className: 'border-slate-700/50 text-slate-500' };
      case 'not_searched': return { label: 'Not searched', className: 'border-slate-700/50 text-slate-400 font-mono' };
      default: return { label: 'Unscored', className: 'border-slate-700/50 text-slate-500' };
    }
  };

  const getStageBadgeColor = (stage: Lead['stage']) => {
    switch (stage) {
      case 'SCRAPED': return 'bg-slate-500/10 text-slate-300 border border-slate-500/20';
      case 'ENRICHED': return 'bg-purple-500/10 text-purple-300 border border-purple-500/20';
      case 'SEQUENCE ACTIVE': return 'bg-amber-500/10 text-amber-300 border border-amber-500/20 cursor-pointer hover:bg-amber-500/20';
      case 'REPLIED': return 'bg-orange-500/10 text-orange-300 border border-orange-500/20 font-bold cursor-pointer hover:bg-orange-500/20';
      case 'MEETING BOOKED': return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-bold';
      case 'NEGOTIATING': return 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 font-bold';
      case 'CONVERTED': return 'bg-emerald-500/30 text-emerald-400 border border-emerald-500/50 font-bold shadow-[0_0_10px_rgba(16,185,129,0.2)]';
      case 'LOST': return 'bg-red-500/10 text-red-300 border border-red-500/20';
      case 'NURTURE': return 'bg-slate-600/10 text-slate-400 border border-slate-600/20';
      default: return 'bg-slate-800/50 text-slate-400 border border-slate-700/50';
    }
  };

  return (
    <Card className="shadow-2xl relative">
      <CardContent className="p-6 space-y-6">


      {/* Modern, stylish inline relative verification modal for deletions */}
      {showConfirmBulkDelete && (
        <div className="absolute inset-0 bg-background/90 backdrop-blur-sm z-40 flex items-center justify-center p-4">
          <Card className="max-w-md w-full p-6 shadow-2xl text-center space-y-4">
            <h4 className="text-sm font-black text-foreground tracking-tight">Purge Confirmation</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Are you sure you want to permanently delete these <strong className="text-destructive">{selectedLeadIds.length} leads</strong> from your active CRM systems? This pipeline step is irreversible.
            </p>
            <div className="flex justify-center gap-2.5 pt-2">
              <Button
                variant="outline"
                onClick={() => setShowConfirmBulkDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleBulkDeleteAction}
              >
                Permanently Delete
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Modern, stylish inline relative verification modal for purging duplicates */}
      {showConfirmPurgeDuplicates && (
        <div className="absolute inset-0 bg-background/90 backdrop-blur-sm z-40 flex items-center justify-center p-4">
          <Card className="max-w-md w-full p-6 shadow-2xl text-center space-y-4">
            <h4 className="text-sm font-black text-foreground tracking-tight flex items-center justify-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Purge Redundant Duplicates
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Are you sure you want to permanently remove <strong className="text-destructive">{duplicateIdsToDelete.length} duplicate leads</strong>? This will leave exactly one unique record of each prospect and instantly sanitize your CRM. This action is irreversible.
            </p>
            <div className="flex justify-center gap-2.5 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowConfirmPurgeDuplicates(false);
                  setDuplicateIdsToDelete([]);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleExecutePurgeDuplicates}
              >
                Purge All Duplicates
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Table Title Block & Exporters */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div>
            <h3 className="font-extrabold text-foreground text-base flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              CRM Lead Inventory Directory
            </h3>
            <p className="text-xs text-muted-foreground mt-1">Multi-purpose spreadsheet structure for CRM syncing. Check any target rows to trigger batch activities.</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {selectedLeadIds.length > 0 && (
              <div className="flex gap-1.5 border-r pr-3 mr-1">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDelete}
                  className="flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Selected ({selectedLeadIds.length})
                </Button>
                
                <select
                  onChange={(e) => handleBulkStageChange(e.target.value as Lead['stage'])}
                  className="bg-background border rounded-xl text-xs text-foreground px-3 py-2 outline-none"
                  defaultValue=""
                >
                  <option value="" disabled>Change Stage To...</option>
                  <option value="SCRAPED">1. Scraped</option>
                  <option value="ENRICHED">2. Enriched</option>
                  <option value="SEQUENCE ACTIVE">3. Sequence Active</option>
                  <option value="REPLIED">4. Replied</option>
                  <option value="MEETING BOOKED">5. Meeting Booked</option>
                  <option value="NEGOTIATING">6. Negotiating</option>
                  <option value="CONVERTED">7. Converted</option>
                  <option value="NURTURE">Nurture</option>
                  <option value="LOST">Lost</option>
                </select>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={handleStartEnrichment}
              disabled={selectedLeadIds.length === 0 || enrichmentQueue.length > 0}
              title={selectedLeadIds.length === 0 ? "Select leads using checkboxes to run AI enrichment" : "Run AI Enrichment & Email Discovery on selected leads"}
            >
              {enrichmentQueue.length > 0 ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
              {enrichmentQueue.length > 0 ? `Enriching (${enrichmentQueue.length})...` : `AI Enrich Pipeline (${selectedLeadIds.length})`}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleSelectDuplicates}
              disabled={leads.length === 0}
            >
              <Layers className="w-4 h-4 mr-2" />
              Select Duplicates
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleTriggerPurgeDuplicates}
              disabled={leads.length === 0}
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="w-4 h-4 mr-2 text-destructive" />
              Purge Duplicates
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCsvExport(false)}
              disabled={selectedLeadIds.length === 0}
            >
              <FileDown className="w-4 h-4 mr-2" />
              Export Checked ({selectedLeadIds.length})
            </Button>
            
            <Button
              size="sm"
              onClick={() => handleCsvExport(true)}
              disabled={leads.length === 0}
            >
              <FileDown className="w-4 h-4 mr-2" />
              Export All ({leads.length})
            </Button>
            
            <input 
              type="file" 
              accept=".csv" 
              ref={fileInputRef} 
              onChange={handleCsvImport} 
              className="hidden" 
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              {isImporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2" />}
              {isImporting ? 'Ingesting...' : 'Import CSV'}
            </Button>
          </div>
        </div>
      </div>

      {enrichmentStep && (
        <div className="bg-indigo-900/30 border border-indigo-500/30 rounded-xl px-4 py-3 flex items-center justify-between animate-pulse">
           <div className="flex items-center gap-3">
             <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
             <div className="flex flex-col">
               <span className="text-xs font-bold text-indigo-200">AI Enrichment actively processing {enrichmentQueue.length} records...</span>
               <span className="text-[10px] text-indigo-400 font-mono tracking-tight">{enrichmentStep}</span>
             </div>
           </div>
        </div>
      )}

      {/* Spreadsheet Controller */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between border-t border-slate-800/60 pt-4">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            placeholder="Search spreadsheet rows..."
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <SlidersHorizontal className="w-4 h-4 text-slate-400" />
          <span className="text-slate-450 text-xs font-bold uppercase">Stage filter:</span>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 px-3 py-1.5 font-medium outline-none"
          >
            <option value="All">All Stages</option>
            <option value="SCRAPED">1. Scraped</option>
            <option value="ENRICHED">2. Enriched</option>
            <option value="SEQUENCE ACTIVE">3. Sequence Active</option>
            <option value="REPLIED">4. Replied</option>
            <option value="MEETING BOOKED">5. Meeting Booked</option>
            <option value="NEGOTIATING">6. Negotiating</option>
            <option value="CONVERTED">7. Converted</option>
            <option value="NURTURE">Nurture</option>
            <option value="LOST">Lost</option>
          </select>
        </div>
      </div>

      {/* Real Table Grid scrollable container */}
      <div className="border rounded-xl mb-16">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-center">
                <input
                  type="checkbox"
                  checked={paginatedLeads.length > 0 && selectedVisibleLeadIds.length === paginatedLeads.length}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="rounded cursor-pointer"
                />
              </TableHead>
              <TableHead>Contact Profile Name</TableHead>
              <TableHead>Primary Title</TableHead>
              <TableHead>Employer / Company Name</TableHead>
              <TableHead>Corporate Outreach Email</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-center">Predictive Score</TableHead>
              <TableHead className="text-center">Pipeline status</TableHead>
              <TableHead className="text-right">Delete</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLeads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground font-medium py-8">
                  No records stored matching your current directory queries.
                </TableCell>
              </TableRow>
            ) : (
              paginatedLeads.map((lead) => {
                const isDuplicate = duplicateIds.has(lead.id);
                const addedAt = lead.createdAt ? new Date(lead.createdAt) : null;
                const hasValidAddedAt = !!addedAt && !Number.isNaN(addedAt.getTime());
                const addedDate = hasValidAddedAt ? addedAt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
                const addedTime = hasValidAddedAt ? addedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const emailStatus = getEmailStatusMeta(lead.emailDiscovery?.status || lead.profile.contactDetails?.emailStatus || 'not_searched');
                const isDiscoveringEmail = discoveringEmailIds.includes(lead.id);

                return (
                  <TableRow 
                    key={lead.id} 
                    className={`${selectedLeadIds.includes(lead.id) ? 'bg-muted/50' : ''} ${isDuplicate ? 'border-l-2 border-l-amber-500 bg-amber-500/5' : ''}`}
                  >
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        checked={selectedLeadIds.includes(lead.id)}
                        onChange={(e) => handleSelectRow(lead.id, e.target.checked)}
                        className="rounded cursor-pointer"
                      />
                    </TableCell>
                    <TableCell className="font-bold">
                      <div className="flex items-center gap-2">
                        {isDuplicate && (
                          <div title="Potential Duplicate Profile" className="text-amber-500">
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </div>
                        )}
                        <span>{lead.profile.fullName}</span>
                        {lead.lastEnrichedAt && (
                          <div title={`Enriched by AI on ${new Date(lead.lastEnrichedAt).toLocaleDateString()}`} className="text-primary">
                            <Sparkles className="w-3.5 h-3.5" />
                          </div>
                        )}
                        {lead.profile.contactDetails?.linkedinUrl && (
                          <a
                            href={lead.profile.contactDetails.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                            title="Open LinkedIn"
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                  <TableCell className="text-muted-foreground truncate max-w-[200px]" title={lead.profile.currentTitle}>
                    {lead.profile.currentTitle || 'Professional'}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[190px]">
                    <div className="truncate">{lead.profile.currentCompany || 'Independent'}</div>
                    {lead.companyAccount && (
                      <div className="text-[10px] text-emerald-400 font-bold mt-1 truncate">
                        {lead.companyAccount.buyingSignals.length} signals - Pain {lead.companyAccount.operationalPainScore}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1.5 min-w-[190px]">
                      {lead.profile.contactDetails?.email ? (
                        <div className="flex items-center gap-1.5 font-semibold">
                          <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="truncate max-w-[190px]" title={lead.profile.contactDetails.email}>{lead.profile.contactDetails.email}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">No emails available</span>
                      )}
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-[9px] ${emailStatus.className}`}>
                          {emailStatus.label}
                          {lead.profile.contactDetails?.emailConfidence ? ` ${lead.profile.contactDetails.emailConfidence}%` : ''}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleFindEmail(lead)}
                          disabled={isDiscoveringEmail}
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-primary"
                        >
                          {isDiscoveringEmail ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    <div className="text-xs font-medium text-slate-300">{addedDate}</div>
                    {addedTime && <div className="text-[10px] text-slate-500 mt-0.5">{addedTime}</div>}
                  </TableCell>
                  <TableCell className="text-center">
                    {lead.predictiveScore ? (
                      <Badge variant="outline" className="border-indigo-500/30 text-indigo-400">
                        {lead.predictiveScore}% Close
                      </Badge>
                    ) : <span className="text-slate-600 text-[10px]">--</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={`text-[9px] ${getStageBadgeColor(lead.stage)}`}>
                      {lead.stage.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        handleDeleteLead(lead.id);
                        setSelectedLeadIds(prev => prev.filter(id => id !== lead.id));
                      }}
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        {filteredLeads.length > pageSize && (
          <div className="flex flex-col gap-3 border-t bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-medium text-muted-foreground">
              Showing <span className="text-foreground">{pageStart}-{pageEnd}</span> of <span className="text-foreground">{filteredLeads.length}</span> matching prospects
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={activePage === 1}
                className="h-8 px-2"
                title="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Previous page</span>
              </Button>
              <span className="min-w-24 text-center text-xs font-bold text-slate-300">
                Page {activePage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={activePage === totalPages}
                className="h-8 px-2"
                title="Next page"
              >
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">Next page</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Floating Action Bar */}
      <div 
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 bg-background border shadow-2xl rounded-2xl px-6 py-3 flex items-center gap-4 md:gap-6 z-50 transition-all duration-300 ${
          selectedLeadIds.length > 0 
            ? 'opacity-100 translate-y-0 pointer-events-auto' 
            : 'opacity-0 translate-y-12 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-3">
          <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">
            {selectedLeadIds.length}
          </Badge>
          <span className="text-foreground font-bold text-sm tracking-tight hidden sm:block">Leads Selected</span>
        </div>
        
        <div className="w-px h-8 bg-border"></div>
        
        <div className="flex items-center gap-2 md:gap-3">
           <span className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-widest hidden md:block">Move to:</span>
           <select
             className="bg-background border text-xs font-bold text-foreground rounded-lg px-2 md:px-3 py-2 outline-none focus:border-primary cursor-pointer"
             onChange={(e) => {
                if(e.target.value) {
                  handleBulkStageChange(e.target.value as Lead['stage']);
                  e.target.value = ""; // reset
                }
             }}
             defaultValue=""
           >
              <option value="" disabled>Select stage...</option>
              <option value="SCRAPED">1. Scraped</option>
              <option value="ENRICHED">2. Enriched</option>
              <option value="SEQUENCE ACTIVE">3. Sequence Active</option>
              <option value="REPLIED">4. Replied</option>
              <option value="MEETING BOOKED">5. Meeting Booked</option>
              <option value="NEGOTIATING">6. Negotiating</option>
              <option value="CONVERTED">7. Converted</option>
              <option value="NURTURE">Nurture</option>
              <option value="LOST">Lost</option>
           </select>
        </div>

        <div className="w-px h-8 bg-border"></div>

        <Button
          variant="destructive"
          onClick={handleBulkDelete}
          className="flex items-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          <span className="hidden sm:block">Delete</span>
        </Button>
        
        <Button
           variant="ghost"
           size="icon"
           onClick={() => setSelectedLeadIds([])}
           title="Clear selection"
        >
           <X className="w-4 h-4" />
        </Button>
      </div>
      </CardContent>
    </Card>
  );
}

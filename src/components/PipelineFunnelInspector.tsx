import { useState, useMemo } from 'react';
import type { MiningTraceEvent } from '@/types';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Filter,
  UserX,
  AlertTriangle,
  CheckCircle2,
  Search,
} from 'lucide-react';

export type DroppedCandidateInfo = {
  candidateId?: string;
  candidateName?: string;
  company?: string;
  reasonCode: string;
  reasonDetails?: string;
  stage: string;
  timestamp: string;
};

export type FunnelStageMetrics = {
  id: string;
  name: string;
  inCount: number;
  outCount: number;
  dropCount: number;
  dropReasons: Record<string, number>;
  candidates: DroppedCandidateInfo[];
};

export const REASON_CODE_LABELS: Record<string, string> = {
  crm_duplicate: 'CRM Duplicate',
  seen_session_key: 'Duplicate in Session',
  missing_linkedin_url: 'Missing Profile URL',
  missing_identity: 'Missing Identity',
  missing_role_context: 'Role Context Missing',
  missing_identity_anchor: 'Missing Identity Anchor',
  missing_company_entity: 'Missing Company Entity',
  not_decision_maker: 'Not Decision Maker',
  score_below_minimum: 'Below Score Threshold',
  candidate_budget_truncation: 'Budget Truncation',
  prejudge_role_triage: 'Pre-judge Role Triage',
  cached_disqualification: 'Cached Rejection',
  primary_admission_withheld: 'Primary Criteria Unproven',
  attribution_contradiction: 'Company Model Contradiction',
  target_cushion_batch_cut: 'Target Cushion Cut',
  per_company_cap_exceeded: 'Per-Company Cap Exceeded',
  pareto_skyline_cut: 'Pareto Skyline Cut',
};

export function formatReasonLabel(code: string): string {
  if (REASON_CODE_LABELS[code]) return REASON_CODE_LABELS[code];
  return code
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface PipelineFunnelInspectorProps {
  traceEvents?: MiningTraceEvent[];
  className?: string;
}

export function PipelineFunnelInspector({
  traceEvents = [],
  className = '',
}: PipelineFunnelInspectorProps) {
  const [selectedDropReason, setSelectedDropReason] = useState<{
    stageId: string;
    stageName: string;
    reasonCode: string;
    candidates: DroppedCandidateInfo[];
  } | null>(null);

  const [filterSearch, setFilterSearch] = useState('');

  const { funnelStages, totalDropped, allDropCounts } = useMemo(() => {
    const dropsByStage: Record<string, DroppedCandidateInfo[]> = {
      retrieve: [],
      fuse: [],
      pre_filter: [],
      extract: [],
      verify: [],
      enrich: [],
      judge: [],
      select: [],
    };

    let rawCandidateTotal = 0;
    let fusedTotal = 0;
    let preFilteredTotal = 0;
    let extractedTotal = 0;
    let verifiedTotal = 0;
    let enrichedTotal = 0;
    let judgedTotal = 0;
    let selectedTotal = 0;

    const allDropCounts: Record<string, number> = {};

    for (const ev of traceEvents) {
      if (ev.operation === 'candidate_dropped') {
        const metadata = (ev.metadata || {}) as Record<string, any>;
        const reasonCode = String(metadata.reasonCode || 'unknown');
        const candidate: DroppedCandidateInfo = {
          candidateId: metadata.candidateId ? String(metadata.candidateId) : undefined,
          candidateName: metadata.candidateName ? String(metadata.candidateName) : undefined,
          company: metadata.company ? String(metadata.company) : undefined,
          reasonCode,
          reasonDetails: metadata.reasonDetails ? String(metadata.reasonDetails) : undefined,
          stage: String(ev.phase || 'pipeline'),
          timestamp: ev.timestamp,
        };

        allDropCounts[reasonCode] = (allDropCounts[reasonCode] || 0) + 1;

        if (ev.phase === 'fusion') {
          dropsByStage.fuse.push(candidate);
        } else if (ev.phase === 'extraction' && reasonCode.startsWith('prefilter_')) {
          dropsByStage.pre_filter.push(candidate);
        } else if (ev.phase === 'extraction') {
          dropsByStage.extract.push(candidate);
        } else if (ev.phase === 'verification') {
          dropsByStage.verify.push(candidate);
        } else if (ev.phase === 'filtering') {
          dropsByStage.judge.push(candidate);
        } else if (ev.phase === 'selection') {
          dropsByStage.select.push(candidate);
        } else {
          dropsByStage.extract.push(candidate);
        }
      }

      // Count candidate volume at stage boundaries
      if (ev.counts?.rawCandidates) {
        rawCandidateTotal += Number(ev.counts.rawCandidates);
      }
      if (ev.phase === 'fusion' && ev.operation === 'stage_complete' && ev.counts?.personObservations) {
        fusedTotal = Math.max(fusedTotal, Number(ev.counts.personObservations));
      }
      if (ev.phase === 'extraction' && ev.counts?.extracted) {
        extractedTotal += Number(ev.counts.extracted);
      }
      if (ev.phase === 'verification' && ev.operation === 'stage_complete' && ev.counts?.admitted) {
        verifiedTotal += Number(ev.counts.admitted);
      }
      if (ev.phase === 'filtering' && ev.counts?.qualified) {
        judgedTotal += Number(ev.counts.qualified);
      }
      if (ev.phase === 'selection' && ev.counts?.finalLeads) {
        selectedTotal = Math.max(selectedTotal, Number(ev.counts.finalLeads));
      }
      if (ev.phase === 'persistence' && ev.counts?.persisted) {
        selectedTotal = Math.max(selectedTotal, Number(ev.counts.persisted));
      }
    }

    // Calibrate fallbacks based on drop counts if stage start/complete events were sparse
    if (fusedTotal === 0 && rawCandidateTotal > 0) {
      fusedTotal = Math.max(0, rawCandidateTotal - dropsByStage.fuse.length);
    }
    if (preFilteredTotal === 0 && fusedTotal > 0) {
      preFilteredTotal = Math.max(0, fusedTotal - dropsByStage.pre_filter.length);
    }
    if (extractedTotal === 0 && preFilteredTotal > 0) {
      extractedTotal = Math.max(0, preFilteredTotal - dropsByStage.extract.length);
    }
    if (verifiedTotal === 0 && extractedTotal > 0) {
      verifiedTotal = Math.max(0, extractedTotal - dropsByStage.verify.length);
    }
    if (enrichedTotal === 0 && verifiedTotal > 0) {
      enrichedTotal = Math.max(0, verifiedTotal - dropsByStage.enrich.length);
    }
    if (judgedTotal === 0 && enrichedTotal > 0) {
      judgedTotal = Math.max(0, enrichedTotal - dropsByStage.judge.length);
    }
    if (selectedTotal === 0 && judgedTotal > 0) {
      selectedTotal = Math.max(0, judgedTotal - dropsByStage.select.length);
    }

    const stages: FunnelStageMetrics[] = [
      {
        id: 'retrieve',
        name: '1. Retrieval',
        inCount: rawCandidateTotal,
        outCount: rawCandidateTotal,
        dropCount: 0,
        dropReasons: {},
        candidates: [],
      },
      {
        id: 'fuse',
        name: '2. Fusion',
        inCount: rawCandidateTotal,
        outCount: fusedTotal || rawCandidateTotal,
        dropCount: dropsByStage.fuse.length,
        dropReasons: aggregateReasons(dropsByStage.fuse),
        candidates: dropsByStage.fuse,
      },
      {
        id: 'extract',
        name: '3. Extraction',
        inCount: fusedTotal || rawCandidateTotal,
        outCount: extractedTotal || fusedTotal,
        dropCount: dropsByStage.extract.length + dropsByStage.pre_filter.length,
        dropReasons: aggregateReasons([...dropsByStage.pre_filter, ...dropsByStage.extract]),
        candidates: [...dropsByStage.pre_filter, ...dropsByStage.extract],
      },
      {
        id: 'verify',
        name: '4. Verification',
        inCount: extractedTotal || fusedTotal,
        outCount: verifiedTotal || extractedTotal,
        dropCount: dropsByStage.verify.length,
        dropReasons: aggregateReasons(dropsByStage.verify),
        candidates: dropsByStage.verify,
      },
      {
        id: 'judge',
        name: '5. Finalist Judge',
        inCount: verifiedTotal || extractedTotal,
        outCount: judgedTotal || verifiedTotal,
        dropCount: dropsByStage.judge.length,
        dropReasons: aggregateReasons(dropsByStage.judge),
        candidates: dropsByStage.judge,
      },
      {
        id: 'select',
        name: '6. Selection',
        inCount: judgedTotal || verifiedTotal,
        outCount: selectedTotal || judgedTotal,
        dropCount: dropsByStage.select.length,
        dropReasons: aggregateReasons(dropsByStage.select),
        candidates: dropsByStage.select,
      },
    ];

    let totalDropped = 0;
    for (const s of stages) {
      totalDropped += s.dropCount;
    }

    return { funnelStages: stages, totalDropped, allDropCounts };
  }, [traceEvents]);

  if (traceEvents.length === 0) {
    return null;
  }

  const filteredCandidates = selectedDropReason
    ? selectedDropReason.candidates.filter((c) => {
        if (!filterSearch) return true;
        const s = filterSearch.toLowerCase();
        return (
          (c.candidateName && c.candidateName.toLowerCase().includes(s)) ||
          (c.company && c.company.toLowerCase().includes(s)) ||
          (c.candidateId && c.candidateId.toLowerCase().includes(s)) ||
          (c.reasonDetails && c.reasonDetails.toLowerCase().includes(s))
        );
      })
    : [];

  return (
    <div className={`rounded-xl border border-border bg-card/80 p-4 shadow-sm space-y-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-primary" />
          <h4 className="text-sm font-semibold text-foreground">Pipeline Funnel Drop-off Inspector</h4>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs font-mono border-primary/30 text-primary">
            {totalDropped} Filtered Candidates
          </Badge>
          <Badge variant="outline" className="text-xs font-mono border-border text-muted-foreground">
            {funnelStages[funnelStages.length - 1]?.outCount || 0} Admitted
          </Badge>
        </div>
      </div>

      {/* Conversion Flow Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {funnelStages.map((stage, idx) => {
          const prevStage = idx > 0 ? funnelStages[idx - 1] : null;
          const conversionRate =
            prevStage && prevStage.outCount > 0
              ? Math.min(100, Math.round((stage.outCount / prevStage.outCount) * 100))
              : 100;

          return (
            <div
              key={stage.id}
              className="rounded-lg border border-border bg-background/60 p-3 flex flex-col justify-between space-y-2 relative"
            >
              <div>
                <div className="text-xs font-bold text-foreground/80 truncate mb-1">
                  {stage.name}
                </div>
                <div className="text-lg font-bold font-mono text-foreground flex items-baseline justify-between">
                  <span>{stage.outCount}</span>
                  {idx > 0 && (
                    <span
                      className={`text-xs font-semibold ${
                        conversionRate >= 75
                          ? 'text-success'
                          : conversionRate >= 40
                          ? 'text-warning'
                          : 'text-danger'
                      }`}
                    >
                      {conversionRate}%
                    </span>
                  )}
                </div>
              </div>

              {stage.dropCount > 0 ? (
                <div className="space-y-1 pt-1.5 border-t border-border/60">
                  <div className="text-[10px] uppercase font-bold text-danger flex items-center gap-1">
                    <UserX className="w-3 h-3" />
                    <span>-{stage.dropCount} dropped</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(stage.dropReasons).map(([code, count]) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() =>
                          setSelectedDropReason({
                            stageId: stage.id,
                            stageName: stage.name,
                            reasonCode: code,
                            candidates: stage.candidates.filter((c) => c.reasonCode === code),
                          })
                        }
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-danger/10 hover:bg-danger/20 text-danger border border-danger/30 transition-colors flex items-center gap-1"
                        title={`Click to inspect ${count} candidates dropped for ${formatReasonLabel(code)}`}
                      >
                        <span className="truncate max-w-[80px]">{formatReasonLabel(code)}</span>
                        <span className="font-bold">({count})</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="pt-1.5 border-t border-border/60 text-[10px] text-muted-foreground flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-success" />
                  <span>100% passed</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Aggregate Drop Reason Summary Badges */}
      {Object.keys(allDropCounts).length > 0 && (
        <div className="pt-2 border-t border-border/60">
          <div className="text-xs uppercase font-bold text-muted-foreground tracking-wider mb-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            <span>Drop Reason Breakdown (click to inspect candidates)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(allDropCounts).map(([code, count]) => {
              const matchingCandidates: DroppedCandidateInfo[] = [];
              for (const stage of funnelStages) {
                for (const c of stage.candidates) {
                  if (c.reasonCode === code) matchingCandidates.push(c);
                }
              }

              return (
                <button
                  key={code}
                  type="button"
                  onClick={() =>
                    setSelectedDropReason({
                      stageId: 'all',
                      stageName: 'Entire Pipeline',
                      reasonCode: code,
                      candidates: matchingCandidates,
                    })
                  }
                  className="px-2 py-1 rounded bg-card hover:bg-card/90 text-xs font-mono border border-border/80 hover:border-primary/60 transition-all flex items-center gap-2 group"
                >
                  <span className="text-foreground group-hover:text-primary">{formatReasonLabel(code)}</span>
                  <Badge variant="outline" className="bg-danger/10 text-danger border-danger/30 text-[10px] py-0 px-1.5">
                    {count}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Dropped Candidate Inspection Modal */}
      <Dialog
        open={Boolean(selectedDropReason)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedDropReason(null);
            setFilterSearch('');
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6 gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base text-foreground">
              <UserX className="w-5 h-5 text-danger" />
              <span>
                Dropped Candidates: {selectedDropReason ? formatReasonLabel(selectedDropReason.reasonCode) : ''}
              </span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Showing candidates filtered out at {selectedDropReason?.stageName}. Click candidate handle to view context.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Filter by name, company, or handle..."
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-md border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[50vh]">
            {filteredCandidates.length > 0 ? (
              filteredCandidates.map((c, idx) => (
                <div
                  key={`${c.candidateId || c.candidateName || idx}-${idx}`}
                  className="p-3 rounded-lg border border-border bg-card/60 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">
                      {c.candidateName || c.candidateId || 'Unknown Candidate'}
                    </span>
                    <Badge variant="outline" className="text-[10px] border-danger/30 text-danger bg-danger/5">
                      {c.stage}
                    </Badge>
                  </div>

                  {c.company && (
                    <div className="text-muted-foreground text-xs flex items-center gap-1.5">
                      <span className="text-foreground/70 font-medium">Company:</span>
                      <span>{c.company}</span>
                    </div>
                  )}

                  {c.reasonDetails && (
                    <div className="text-xs font-mono text-danger/90 bg-danger/5 p-1.5 rounded border border-danger/20 leading-relaxed">
                      {c.reasonDetails}
                    </div>
                  )}

                  <div className="text-[10px] text-muted-foreground font-mono">
                    Timestamp: {new Date(c.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No matching dropped candidates found.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function aggregateReasons(candidates: DroppedCandidateInfo[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const c of candidates) {
    result[c.reasonCode] = (result[c.reasonCode] || 0) + 1;
  }
  return result;
}

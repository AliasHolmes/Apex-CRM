import type { ProspectContract } from "./prospectContract.js";
import type { MiningTelemetryRecorder, MiningTraceEvent } from "./telemetry.js";
import type { QueryRunStats } from "./strategist.js";
import type { RejectionReason } from "./rejections.js";
import type { LLMSessionCircuitBreaker } from "../services/llm.js";
import type { ScoutFreeTierBudget } from "./freeTier.js";
import type { CollectionCapacity } from "./collectionCapacity.js";
import type {
  BrightDataSearchOptions,
  BrightDataSearchResult,
} from "../services/brightdata.js";

export type StageName =
  | "plan"
  | "retrieve"
  | "fuse"
  | "extract"
  | "verify"
  | "enrich"
  | "judge"
  | "select"
  | "persist";

export type SessionConfig = {
  sessionId: string;
  promptQuery: string;
  targetLimit: number;
  minScore: number;
  ttlDays: number;
  startedAt: number;
  contract: ProspectContract;
  capacity: CollectionCapacity;
  maxRounds: number;
  creditReservationEnabled: boolean;
  companyIntentEnabled: boolean;
  companyIntentMaxPerSearch: number;
  companyIntentMinScore: number;
  linkedinPostIntentEnabled: boolean;
  profileEnrichmentStage: string;
  profileConcurrency: number;
  profileMaxPerSearch: number;
  extractionConcurrency: number;
  judgeConcurrency: number;
};

export type PipelinePorts = {
  brightDataSearch: (
    query: string,
    options?: BrightDataSearchOptions,
    phaseLabel?: string,
  ) => Promise<BrightDataSearchResult[]>;
  tavilySearch: (
    query: string,
    options?: Record<string, any>,
  ) => Promise<{
    text: string;
    sources: { title: string; uri: string }[];
    items: any[];
  }>;
  scrapeMarkdown: (url: string) => Promise<string | null>;
  scrapeBatchMarkdown: (urls: string[]) => Promise<any>;
};

export type PipelineSessionState = {
  round: number;
  stopReason?: string;
  seenCandidateKeys: Set<string>;
  existingKeys: Set<string>;
  queryRuns: QueryRunStats[];
  acceptedLeads: any[];
  qualifiedLeads: any[];
  finalLeads: any[];
  rejectionCounts: Record<RejectionReason | string, number>;
  failureCounts: Record<string, number>;
  brightDataStats: any;
  freeTierBudget: ScoutFreeTierBudget;
  llmCircuitBreaker: LLMSessionCircuitBreaker;
  abortController: AbortController;
  telemetry: MiningTelemetryRecorder;
  debugLogs: any[];
  urlRetryQueue?: Set<string>;
  previousRoundSummary?: any;
};

export type SessionContext = {
  config: SessionConfig;
  state: PipelineSessionState;
  ports: PipelinePorts;
  logEvent: (msg: string) => void;
  recordTrace: (
    event: Omit<MiningTraceEvent, "id" | "timestamp"> & { timestamp?: string },
  ) => MiningTraceEvent;
};

export type MiningSessionCheckpoint = {
  sessionId: string;
  round: number;
  stage: string;
  promptQuery: string;
  targetLimit: number;
  contract: ProspectContract;
  searchSpec?: any;
  queryRuns: QueryRunStats[];
  acceptedLeads: any[];
  qualifiedLeads: any[];
  finalLeads: any[];
  rejectionCounts: Record<string, number>;
  failureCounts: Record<string, number>;
  brightDataStats: any;
  previousRoundSummary?: any;
  evidenceByUrl?: Record<string, any>;
  leadQueryRunMap?: Record<string, any>;
  /** Runs added since the previous checkpoint (delta serialization). */
  queryRunsDelta?: QueryRunStats[];
  /** Last N debug-log entries, persisted so crash context survives resume. */
  debugLogsTail?: any[];
  updatedAt: string;
};

export class LeadQueryRunTracker {
  private map = new Map<string, QueryRunStats>();

  /**
   * Canonical identity key matching the fuseStage candidateKey convention
   * ("linkedin:<username>"). Identity-based keys survive checkpoint/restore:
   * a lead object reconstructed from a checkpoint resolves to the same map
   * entry as the original in-memory object did.
   */
  private getKey(lead: any): string {
    if (!lead) return "";
    const url =
      lead.contactDetails?.linkedinUrl ||
      lead.profile?.contactDetails?.linkedinUrl ||
      lead.sourceUrl ||
      "";
    const usernameMatch = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (usernameMatch?.[1]) return `linkedin:${usernameMatch[1].toLowerCase()}`;
    if (lead.id) return `id:${lead.id}`;
    const name = (lead.fullName || lead.profile?.fullName || "")
      .trim()
      .toLowerCase();
    const company = (
      lead.currentCompany ||
      lead.company ||
      lead.profile?.currentCompany ||
      ""
    )
      .trim()
      .toLowerCase();
    if (name && company) return `text:${name}@${company}`;
    if (name) return `text:${name}`;
    return "";
  }

  get(lead: any): QueryRunStats | undefined {
    const key = this.getKey(lead);
    return key ? this.map.get(key) : undefined;
  }

  set(lead: any, queryRun: QueryRunStats): void {
    const key = this.getKey(lead);
    if (key) this.map.set(key, queryRun);
  }

  toJSON(): Record<string, QueryRunStats> {
    return Object.fromEntries(this.map.entries());
  }

  fromJSON(data?: Record<string, QueryRunStats>): void {
    if (!data || typeof data !== "object") return;
    for (const [key, run] of Object.entries(data)) {
      this.map.set(key, run);
    }
  }
}

export type StageResult<T = void> = {
  stage: StageName;
  round?: number;
  status: "completed" | "skipped" | "stopped";
  data?: T;
  error?: Error;
  stopReason?: string;
};

export type PipelineStage<TInput = void, TOutput = void> = {
  name: StageName;
  execute: (
    ctx: SessionContext,
    input: TInput,
  ) => Promise<StageResult<TOutput>>;
};

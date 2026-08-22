import type { ProspectContract } from './prospectContract.js';
import type { MiningTelemetryRecorder, MiningTraceEvent } from './telemetry.js';
import type { QueryRunStats } from './strategist.js';
import type { RejectionReason } from './rejections.js';
import type { LLMSessionCircuitBreaker } from '../services/llm.js';
import type { ScoutFreeTierBudget } from './freeTier.js';
import type { CollectionCapacity } from './collectionCapacity.js';
import type { BrightDataSearchOptions, BrightDataSearchResult } from '../services/brightdata.js';

export type StageName =
  | 'plan'
  | 'retrieve'
  | 'fuse'
  | 'extract'
  | 'verify'
  | 'enrich'
  | 'judge'
  | 'select'
  | 'persist';

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
    phaseLabel?: string
  ) => Promise<BrightDataSearchResult[]>;
  tavilySearch: (
    query: string,
    options?: Record<string, any>
  ) => Promise<{ text: string; sources: { title: string; uri: string }[]; items: any[] }>;
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
  recordTrace: (event: Omit<MiningTraceEvent, 'id' | 'timestamp'> & { timestamp?: string }) => MiningTraceEvent;
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
  updatedAt: string;
};

export type StageResult<T = void> = {
  stage: StageName;
  round?: number;
  status: 'completed' | 'skipped' | 'stopped';
  data?: T;
  error?: Error;
  stopReason?: string;
};

export type PipelineStage<TInput = void, TOutput = void> = {
  name: StageName;
  execute: (ctx: SessionContext, input: TInput) => Promise<StageResult<TOutput>>;
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContactDetails {
  email?: string; // Manually entered, imported, or explicitly published in profile evidence.
  phone?: string;
  linkedinUrl?: string;
  twitter?: string;
  website?: string;
}

export interface Experience {
  title: string;
  company: string;
  duration?: string;
  location?: string;
  description?: string;
}

export interface Education {
  school: string;
  degree?: string;
  fieldOfStudy?: string;
  duration?: string;
}

export interface LinkedInProfile {
  id: string;
  fullName: string;
  headline?: string;
  currentCompany?: string;
  currentTitle?: string;
  seniorityLevel?: string; // C-Suite / Founder-Owner / VP / Head / Director / Manager / IC / Assistant / Student / Unknown
  companySizeEst?: string; // New: 1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN
  location?: string;
  summary?: string;
  contactDetails?: ContactDetails;
  experiences?: Experience[];
  education?: Education[];
  skills?: string[];
  industry?: string;
  yearsInRole?: string; // New
  careerSignals?: string[]; // New: notable transitions, promotions
  techStackHints?: string[]; // New: tools/software mentioned
  painIndicators?: string[]; // New: specific quoted phrases or inferred needs
  enrichmentGaps?: string[]; // New
}


export interface BuyingSignal {
  type: 'LEAD_FLOW' | 'OPERATIONAL_COMPLEXITY' | 'GROWTH_SIGNAL' | 'DECISION_MAKER' | 'DISQUALIFIER';
  label: string;
  evidence: string;
  sourceUrl?: string;
  confidence: number;
}

export interface CompanyAccount {
  id: string;
  name: string;
  website?: string;
  industry?: string;
  location?: string;
  sizeEstimate?: 'solo' | 'small-team' | 'mid-market' | 'enterprise' | 'unknown';
  buyingSignals: BuyingSignal[];
  disqualifiers?: BuyingSignal[];
  operationalPainScore: number;
  qualificationStatus: 'DISCOVERED' | 'QUALIFIED' | 'REJECTED' | 'NEEDS_REVIEW';
  painSummary?: string;
}

export interface DecisionMakerVerification {
  titleMatched: boolean;
  companyMatched: boolean;
  ignoredTitle: boolean;
  confidence: number;
  reason: string;
}

export type EvidenceQuality = 'weak' | 'partial' | 'good';
export type LeadSourceProvider = 'tavily' | 'brightdata' | 'cache' | 'manual' | 'import';

export interface LeadEvidence {
  sourceUrl: string;
  sourceProvider: LeadSourceProvider;
  sourceQuery: string;
  sourceRound: number;
  evidenceQuality: EvidenceQuality;
  snippets: string[];
  whyThisLead?: string;
}

export interface ScoreBreakdown {
  fitScore: number;
  intentScore: number;
  timingScore: number;
  evidenceQualityScore: number;
  sourceConfidenceScore: number;
  finalScore: number;
}

export interface ScoutEvidence {
  matchedCriteria: string[];
  sourceCount: number;
  sourceProviders: string[];
  lanes: string[];
  criteriaCoverageScore: number;
  corroborationScore: number;
  evidenceCoverageScore: number;
  uncertainties: string[];
}

export interface QualifiedLeadProfile extends LinkedInProfile {
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  scoreOverride?: number;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
  scout?: ScoutEvidence;
  finalSelectionScore?: number;
  discoveryLane?: string;
}

export const LEAD_STAGES = ['SCRAPED', 'ENRICHED', 'SEQUENCE ACTIVE', 'REPLIED', 'MEETING BOOKED', 'NEGOTIATING', 'CONVERTED', 'LOST', 'NURTURE'] as const;
export const REVIEW_STATUSES = ['UNREVIEWED', 'KEEP', 'MAYBE', 'REJECT'] as const;
export const NEXT_ACTIONS = ['NONE', 'OPEN_LINKEDIN', 'RESEARCH', 'CONNECT', 'MESSAGE'] as const;

export type LeadStage = typeof LEAD_STAGES[number];
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export type NextAction = typeof NEXT_ACTIONS[number];

export const LEAD_STAGE_SET = new Set<string>(LEAD_STAGES);
export const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUSES);
export const NEXT_ACTION_SET = new Set<string>(NEXT_ACTIONS);

export interface Lead {
  id: string;
  /** Incremented by SQLite on every write; included in mutations to reject stale edits. */
  revision?: number;
  profile: LinkedInProfile;
  stage: LeadStage;
  notes?: string;
  createdAt: string;
  lastActive?: string;
  lastEnrichedAt?: string;
  tags?: string[];
  reviewStatus?: ReviewStatus;
  nextAction?: NextAction;
  
  // Analytics & Scoring from System Prompt
  icpScoreReasoning?: string; // 1-10 rating rationale
  fitScore?: number; // ICP match based on title, industry, company size
  intentScore?: number; // Buying signals
  timingScore?: number; // Recent role change, funding event
  compositeScore?: number; // (Fit * 0.4) + (Intent * 0.4) + (Timing * 0.2)
  predictiveScore?: number;
  qualificationScore?: number;
  tier?: 'TIER 1: PRIORITY' | 'TIER 2: ACTIVE' | 'TIER 3: WATCH' | 'TIER 4: DEPRIORITIZE';
  
  buyingSignalsDetected?: string[];
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
  scout?: ScoutEvidence;
  finalSelectionScore?: number;
  discoveryLane?: string;
}

export interface ScrapingTask {
  id: string;
  type: 'url' | 'paste' | 'search';
  query: string;
  status: 'idle' | 'processing' | 'completed' | 'failed' | 'cancelled';
  resultCount?: number;
  createdAt: string;
}

export type MiningProvider = 'llm' | 'tavily' | 'brightdata' | 'sqlite' | 'system';
export type MiningPhase = 'session' | 'strategy' | 'search' | 'candidate_processing' | 'extraction' | 'filtering' | 'enrichment' | 'persistence';
export type MiningEventStatus = 'started' | 'success' | 'error' | 'skipped' | 'info';

export interface MiningTraceEvent {
  id: string;
  timestamp: string;
  phase: MiningPhase;
  operation: string;
  status: MiningEventStatus;
  provider?: MiningProvider;
  round?: number;
  query?: string;
  chunk?: { index: number; total: number; inputChars?: number };
  latencyMs?: number;
  counts?: Record<string, number>;
  llm?: {
    purpose?: string;
    model?: string;
    route?: string;
    fallbackUsed?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    finishReason?: string;
    parseRetries?: number;
  };
  tavily?: { searchDepth?: string; maxResults?: number; includeDomains?: string[] };
  brightData?: { transport?: string; target?: string; targetCount?: number; circuitOpen?: boolean; cooldownMsRemaining?: number; disabledReason?: string | null };
  email?: { status?: string; cacheHit?: boolean; evidenceCount?: number; sourceTypes?: string[] };
  error?: { message: string; code?: string };
  metadata?: Record<string, unknown>;
}

export interface ProviderSummaryItem {
  calls: number;
  successes: number;
  failures: number;
  skipped: number;
  latencyMs: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  fallbackUses: number;
}

export type ProviderSummary = Record<string, ProviderSummaryItem>;

export interface CostSummary {
  estimatedUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costPerAcceptedLead?: number;
  tokensPerAcceptedLead?: number;
}

export interface TargetEffortStats {
  mode: 'exhaustive_bounded';
  requested: number;
  selectableQualified: number;
  shortfall: number;
  waves: number;
  queryExecutions: number;
  maxQueryExecutions: number;
  acceptedCandidates: number;
  candidateCeiling: number;
  emptyWaves: number;
  estimatedQualificationYield: number;
  terminationReason: string;
}

export interface FinalistJudgeStats {
  autoQualified: number;
  reviewed: number;
  qualified: number;
  hardFailed: number;
  unknown: number;
  unjudged: number;
  batchesRun: number;
  batchesSkipped: number;
  retries: number;
  rescued: number;
}

export interface PhaseTimelineItem {
  phase: MiningPhase;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: MiningEventStatus;
  events: number;
}

export interface MiningTraceSummary {
  sessionId?: string;
  query?: string;
  requested?: number;
  status?: 'running' | 'success' | 'error';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  stopReason?: string;
  returned?: number;
  eventCount: number;
  providerSummary: ProviderSummary;
  costSummary: CostSummary;
  phaseTimeline: PhaseTimelineItem[];
  targetEffort?: TargetEffortStats;
  finalistJudge?: FinalistJudgeStats;
  schemaVersion?: number;
}
export interface SearchLog {
  id: string;
  timestamp: string;
  prompt: string;
  generatedQueries: string[];
  status: 'success' | 'error' | 'running' | 'cancelled';
  errorMessage?: string;
  rawResultsCount: number;
  leadsFound: number;
  detailedLogs?: string;
  debugLogs?: string;
  rejectionReasons?: Record<string, number>;
  queryRuns?: unknown[];
  traceSummary?: MiningTraceSummary;
  traceEvents?: MiningTraceEvent[];
  providerSummary?: ProviderSummary;
  costSummary?: CostSummary;
  phaseTimeline?: PhaseTimelineItem[];
  schemaVersion?: number;
}

export type MiningSessionStatus = 'running' | 'cancellation_requested' | 'success' | 'error' | 'cancelled' | 'interrupted';

export interface MiningSession {
  id: string;
  status: MiningSessionStatus;
  prompt: string;
  requestedLimit: number;
  startedAt: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
  errorMessage?: string;
  stats?: Record<string, unknown>;
  traceSummary?: MiningTraceSummary;
  updatedAt: string;
}

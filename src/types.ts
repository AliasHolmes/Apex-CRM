/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type EmailDiscoveryStatus = 'confirmed_public' | 'company_public' | 'pattern_likely' | 'domain_only' | 'not_found' | 'not_searched';

export interface EmailDiscoveryEvidence {
  type: 'brightdata_batch' | 'brightdata_search' | 'tavily_extract' | 'tavily_search' | 'direct_fetch' | 'pattern' | 'dns' | 'cache';
  url?: string;
  email?: string;
  evidence: string;
}

export interface EmailFallbackChannels {
  contactPage?: string;
  genericEmail?: string;
  website?: string;
  linkedinUrl?: string;
}

export interface EmailDiscoveryResult {
  bestEmail?: string;
  status: EmailDiscoveryStatus;
  confidence: number;
  companyDomain?: string;
  mxValid?: boolean;
  sources: EmailDiscoveryEvidence[];
  fallbackChannels: EmailFallbackChannels;
}

export interface ContactDetails {
  email?: string; // Publicly found or clearly labeled inferred outreach address.
  emailStatus?: EmailDiscoveryStatus;
  emailConfidence?: number;
  emailSources?: EmailDiscoveryEvidence[];
  fallbackChannels?: EmailFallbackChannels;
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

export interface QualifiedLeadProfile extends LinkedInProfile {
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  scoreOverride?: number;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
  emailDiscovery?: EmailDiscoveryResult;
}

export type LeadStage = 'SCRAPED' | 'ENRICHED' | 'SEQUENCE ACTIVE' | 'REPLIED' | 'MEETING BOOKED' | 'NEGOTIATING' | 'CONVERTED' | 'LOST' | 'NURTURE';

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
  emailDiscovery?: EmailDiscoveryResult;
}

export interface ScrapingTask {
  id: string;
  type: 'url' | 'paste' | 'search';
  query: string;
  status: 'idle' | 'processing' | 'completed' | 'failed';
  resultCount?: number;
  createdAt: string;
}

export type MiningProvider = 'llm' | 'tavily' | 'brightdata' | 'email' | 'sqlite' | 'system';
export type MiningPhase = 'session' | 'strategy' | 'search' | 'candidate_processing' | 'extraction' | 'filtering' | 'enrichment' | 'email_discovery' | 'persistence';
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

export interface PhaseTimelineItem {
  phase: MiningPhase;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: MiningEventStatus;
  events: number;
}

export interface MiningTraceSummary {
  eventCount: number;
  providerSummary: ProviderSummary;
  costSummary: CostSummary;
  phaseTimeline: PhaseTimelineItem[];
  schemaVersion?: number;
}
export interface SearchLog {
  id: string;
  timestamp: string;
  prompt: string;
  generatedQueries: string[];
  status: 'success' | 'error' | 'running';
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

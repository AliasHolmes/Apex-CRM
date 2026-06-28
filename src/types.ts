/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContactDetails {
  email?: string; // Appended with [CONFIRMED] or [INFERRED-HIGH], etc.
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
  seniorityLevel?: string; // New: C-Suite / VP / Director / Manager / IC / Founder
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
}

export type LeadStage = 'SCRAPED' | 'ENRICHED' | 'SEQUENCE ACTIVE' | 'REPLIED' | 'MEETING BOOKED' | 'NEGOTIATING' | 'CONVERTED' | 'LOST' | 'NURTURE';

export interface Lead {
  id: string;
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
  compositeScore?: number; // (Fit × 0.4) + (Intent × 0.4) + (Timing × 0.2)
  predictiveScore?: number; // 0-100% Likelihood to Close based on stage and scores
  tier?: 'TIER 1: PRIORITY' | 'TIER 2: ACTIVE' | 'TIER 3: WATCH' | 'TIER 4: DEPRIORITIZE';
  
  buyingSignalsDetected?: string[];
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
}

export interface ScrapingTask {
  id: string;
  type: 'url' | 'paste' | 'search';
  query: string;
  status: 'idle' | 'processing' | 'completed' | 'failed';
  resultCount?: number;
  createdAt: string;
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
}
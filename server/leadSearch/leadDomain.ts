import type { Lead } from "../../src/types.js";

/**
 * EngineLead: Domain type for leads and candidates flowing through the
 * lead discovery engine pipeline (extract -> verify -> enrich -> judge -> select -> persist).
 * Combines domain Lead properties with engine-wire annotations.
 */
export type EngineLead = Partial<Lead> & {
  id?: string;
  candidateId?: string;
  stableId?: string;
  fullName?: string;
  currentTitle?: string;
  currentCompany?: string;
  company?: string;
  companyName?: string;
  headline?: string;
  jobTitle?: string;
  location?: string;
  contactDetails?: {
    linkedinUrl?: string;
    email?: string;
    workEmail?: string;
    phone?: string;
    [key: string]: any;
  };
  sourceUrl?: string;
  profileUrl?: string;
  _locationProvenance?: string;
  isProvisionalEntity?: boolean;
  judgmentInsight?: {
    status?: string;
    [key: string]: any;
  };
  qualification?: {
    verdict?: string;
    confidence?: number;
    explanation?: string;
    reason?: string;
    finalScore?: number;
    requirements?: Array<{
      requirementId?: string;
      name?: string;
      met?: boolean;
      status?: string;
      quote?: string;
      evidenceQuote?: string;
      reason?: string;
      [key: string]: any;
    }>;
    sourceVerdict?: string;
    [key: string]: any;
  };
  [key: string]: any;
};

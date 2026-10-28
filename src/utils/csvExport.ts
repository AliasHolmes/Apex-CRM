/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Lead } from '../types.js';

export type ExportPresetId = 'outreach' | 'crm' | 'diagnostic' | 'legacy';

export interface ExportColumnDef {
  id: string;
  header: string;
  description: string;
  category: 'identity' | 'company' | 'intent' | 'scoring' | 'enrichment' | 'diagnostics' | 'workflow';
  getValue: (lead: Lead) => string | number | boolean | null | undefined;
}

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  badge: string;
  targetTools: string;
  description: string;
  columns: readonly ExportColumnDef[];
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'mail.com',
  'zoho.com',
  'gmx.com',
  'yandex.com',
]);

/**
 * Normalizes a URL into a clean domain name without protocol, www, or path.
 * e.g. "https://www.pinscreen.com/about" -> "pinscreen.com"
 * Also falls back to companyIntentEvidence, domain-like company names, or corporate email domain.
 */
export function extractCleanDomain(lead: Lead): string {
  const l = lead as any;
  const rawUrl =
    l.companyAttribution?.companyDomain ||
    l.companyIntentEvidence?.websiteUrl ||
    l.companyAccount?.website ||
    l.profile?.contactDetails?.website ||
    l.profile?.website ||
    l.companyWebsite ||
    '';

  let candidate = typeof rawUrl === 'string' ? rawUrl.trim() : '';

  // If no explicit website, check if currentCompany is formatted as a domain (e.g. "Studio.com")
  if (!candidate && typeof l.profile?.currentCompany === 'string') {
    const comp = l.profile.currentCompany.trim();
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.(?:com|ai|io|co|org|net|dev|app|tech|xyz|so|me|co\.[a-z]{2})$/i.test(comp)) {
      candidate = comp;
    }
  }

  // If still no domain, check corporate email domain
  if (!candidate && typeof l.profile?.contactDetails?.email === 'string') {
    const email = l.profile.contactDetails.email.trim();
    const atIdx = email.lastIndexOf('@');
    if (atIdx > 0) {
      const emailDomain = email.slice(atIdx + 1).toLowerCase();
      if (!FREE_EMAIL_DOMAINS.has(emailDomain)) {
        candidate = emailDomain;
      }
    }
  }

  if (!candidate) return '';

  // If already looks like a bare domain without protocol or slashes
  if (!candidate.includes('/') && !candidate.includes(':')) {
    return candidate.toLowerCase().replace(/^www\./i, '');
  }

  try {
    const formatted = candidate.startsWith('http://') || candidate.startsWith('https://')
      ? candidate
      : `https://${candidate}`;
    const parsed = new URL(formatted);
    return parsed.hostname.toLowerCase().replace(/^www\./i, '');
  } catch {
    // Fallback regex if URL parsing fails
    const match = candidate.match(/(?:https?:\/\/)?(?:www\.)?([^\/\s:]+)/i);
    return match ? match[1].toLowerCase() : '';
  }
}

/**
 * Resolves seniority level, falling back to title-based inference.
 */
export function extractSeniorityLevel(lead: Lead): string {
  if (lead.profile?.seniorityLevel) return lead.profile.seniorityLevel;
  const title = (lead.profile?.currentTitle || '').toLowerCase();
  if (!title) return '';
  if (/\b(founder|co-founder|owner|proprietor|partner)\b/i.test(title)) return 'Founder-Owner';
  if (/\b(ceo|cto|cfo|cmo|coo|cio|cpo|cro|c-suite|president)\b/i.test(title)) return 'C-Suite';
  if (/\b(vp|vice president|evp|svp)\b/i.test(title)) return 'VP';
  if (/\b(director|head)\b/i.test(title)) return 'Director';
  if (/\b(manager|lead|principal)\b/i.test(title)) return 'Manager';
  return 'Professional';
}

/**
 * Extracts a personalized icebreaker quote or verified evidence quote.
 * Prioritizes verbatim quote from company attribution, then requirement evidence,
 * then post intent snippet or whyThisLead.
 */
export function extractIcebreakerQuote(lead: Lead): string {
  const l = lead as any;

  // 1. Verbatim quote from company attribution
  const attrQuote = l.companyAttribution?.verbatimEvidenceQuote;
  if (typeof attrQuote === 'string' && attrQuote.trim()) {
    return attrQuote.trim();
  }

  // 2. Requirement pass evidence quotes (e.g. from structured evaluation)
  const reqs = l.qualification?.requirements;
  if (Array.isArray(reqs)) {
    const withQuote = reqs.find((r: any) => typeof r.evidenceQuote === 'string' && r.evidenceQuote.trim());
    if (withQuote && withQuote.evidenceQuote) {
      return withQuote.evidenceQuote.trim();
    }
  }

  // 3. Post intent snippet
  const postSnippets = lead.postIntentEvidence?.postSnippets;
  if (Array.isArray(postSnippets) && postSnippets.length > 0 && postSnippets[0]?.trim()) {
    return postSnippets[0].trim();
  }

  // 4. Evidence whyThisLead or first snippet
  const whyLead = lead.evidence?.whyThisLead || l.profile?.evidence?.whyThisLead;
  if (typeof whyLead === 'string' && whyLead.trim()) {
    return whyLead.trim();
  }

  const snippets = lead.evidence?.snippets || l.profile?.evidence?.snippets;
  if (Array.isArray(snippets) && snippets.length > 0 && snippets[0]?.trim()) {
    return snippets[0].trim();
  }

  // 5. Explicit hiring signal in notes or summary
  const textToScan = [lead.notes, lead.profile?.summary].filter(Boolean).join(' ');
  const signalMatch = textToScan.match(/(?:hiring signal|hiring intent)[:\s]+["“']?([^"”\n\r]+)["”']?/i);
  if (signalMatch && signalMatch[1]?.trim()) {
    return signalMatch[1].trim();
  }

  return '';
}

/**
 * Determines the priority tier for a lead.
 */
export function getLeadPriorityTier(lead: Lead): string {
  if (lead.tier) return lead.tier;

  const score = lead.compositeScore ?? lead.qualificationScore ?? lead.predictiveScore;
  if (typeof score === 'number') {
    if (score >= 80) return 'TIER 1: PRIORITY';
    if (score >= 60) return 'TIER 2: ACTIVE';
    if (score >= 40) return 'TIER 3: WATCH';
    return 'TIER 4: DEPRIORITIZE';
  }

  return 'TIER 3: WATCH';
}

/**
 * Resolves source URL or hiring signal URL.
 */
export function extractHiringOrSourceUrl(lead: Lead): string {
  const l = lead as any;
  return (
    lead.hiringSignalUrl ||
    l.profile?.hiringSignalUrl ||
    lead.evidence?.sourceUrl ||
    l.profile?.evidence?.sourceUrl ||
    lead.postIntentEvidence?.sourceUrl ||
    lead.profile?.contactDetails?.linkedinUrl ||
    ''
  );
}

/**
 * Resolves why-now buying signal / intent category string.
 */
export function extractIntentCategoryLabel(lead: Lead): string {
  const l = lead as any;
  if (lead.postIntentEvidence?.intentCategory && lead.postIntentEvidence.intentCategory !== 'none') {
    const quality = lead.postIntentEvidence.quality || 'moderate';
    return `${lead.postIntentEvidence.intentCategory} (${quality})`;
  }

  const buyingSignals = lead.companyAccount?.buyingSignals;
  if (Array.isArray(buyingSignals) && buyingSignals.length > 0) {
    return buyingSignals.map((s) => s.label).join('; ');
  }

  if (Array.isArray(lead.buyingSignalsDetected) && lead.buyingSignalsDetected.length > 0) {
    return lead.buyingSignalsDetected.join('; ');
  }

  if (l.companyAttribution?.verdict === 'verified_fit') {
    return 'verified_fit';
  }

  return '';
}

/**
 * Resolves decision-maker authority verification label.
 */
export function extractDecisionMakerLabel(lead: Lead): string {
  const dm = lead.decisionMakerVerification;
  if (dm?.titleMatched && !dm?.ignoredTitle) {
    return `Verified Decision Maker (${dm.reason || ''})`.trim();
  }
  if (dm?.trajectoryScore !== undefined) {
    return `Authority ${dm.trajectoryScore}/10`;
  }
  return lead.profile?.currentTitle || '';
}

/**
 * Extracts first and last name from full name.
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  return { firstName, lastName };
}

// ==========================================
// COLUMN DEFINITIONS
// ==========================================

const COL_ID: ExportColumnDef = {
  id: 'id',
  header: 'ID',
  description: 'Unique lead identifier',
  category: 'identity',
  getValue: (l) => l.id,
};

const COL_FIRST_NAME: ExportColumnDef = {
  id: 'firstName',
  header: 'First Name',
  description: 'Contact given name',
  category: 'identity',
  getValue: (l) => splitFullName(l.profile?.fullName || '').firstName,
};

const COL_LAST_NAME: ExportColumnDef = {
  id: 'lastName',
  header: 'Last Name',
  description: 'Contact family name',
  category: 'identity',
  getValue: (l) => splitFullName(l.profile?.fullName || '').lastName,
};

const COL_FULL_NAME: ExportColumnDef = {
  id: 'fullName',
  header: 'Full Name',
  description: 'Contact full display name',
  category: 'identity',
  getValue: (l) => l.profile?.fullName || '',
};

const COL_TITLE: ExportColumnDef = {
  id: 'title',
  header: 'Current Title',
  description: 'Primary job title',
  category: 'identity',
  getValue: (l) => l.profile?.currentTitle || '',
};

const COL_SENIORITY: ExportColumnDef = {
  id: 'seniority',
  header: 'Seniority Level',
  description: 'Leadership seniority (e.g. Founder-Owner, C-Suite, VP)',
  category: 'identity',
  getValue: (l) => extractSeniorityLevel(l),
};

const COL_YEARS_IN_ROLE: ExportColumnDef = {
  id: 'yearsInRole',
  header: 'Years in Role',
  description: 'Estimated tenure in current role',
  category: 'identity',
  getValue: (l) => l.profile?.yearsInRole || '',
};

const COL_COMPANY: ExportColumnDef = {
  id: 'company',
  header: 'Current Company',
  description: 'Employer or organization name',
  category: 'company',
  getValue: (l) => l.profile?.currentCompany || '',
};

const COL_COMPANY_DOMAIN: ExportColumnDef = {
  id: 'companyDomain',
  header: 'Company Domain',
  description: 'Clean root domain name for waterfall email enrichment (e.g. pinscreen.com)',
  category: 'company',
  getValue: (l) => extractCleanDomain(l),
};

const COL_COMPANY_WEBSITE: ExportColumnDef = {
  id: 'companyWebsite',
  header: 'Company Website',
  description: 'Full website URL with protocol',
  category: 'company',
  getValue: (l) => {
    const raw =
      (l as any).companyAttribution?.companyDomain ||
      (l as any).companyIntentEvidence?.websiteUrl ||
      l.companyAccount?.website ||
      l.profile?.contactDetails?.website ||
      '';
    if (!raw) {
      const domain = extractCleanDomain(l);
      return domain ? `https://${domain}` : '';
    }
    return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
  },
};

const COL_COMPANY_SIZE: ExportColumnDef = {
  id: 'companySize',
  header: 'Company Size',
  description: 'Estimated employee count range (e.g. 1-10, 11-50, 51-200)',
  category: 'company',
  getValue: (l) => l.profile?.companySizeEst || l.companyAccount?.sizeEstimate || '',
};

const COL_BUSINESS_MODEL: ExportColumnDef = {
  id: 'businessModel',
  header: 'Business Model',
  description: 'Commercial model (e.g. software_product, agency_services, b2b_saas)',
  category: 'company',
  getValue: (l) => (l as any).companyAttribution?.businessModel || '',
};

const COL_PRIMARY_OFFERING: ExportColumnDef = {
  id: 'primaryOffering',
  header: 'Primary Offering',
  description: 'Core product or service offering',
  category: 'company',
  getValue: (l) => (l as any).companyAttribution?.primaryOffering || '',
};

const COL_EMAIL: ExportColumnDef = {
  id: 'email',
  header: 'Corporate Email',
  description: 'Direct corporate email address',
  category: 'identity',
  getValue: (l) => l.profile?.contactDetails?.email || '',
};

const COL_PHONE: ExportColumnDef = {
  id: 'phone',
  header: 'Phone Number',
  description: 'Direct or corporate telephone number',
  category: 'identity',
  getValue: (l) => l.profile?.contactDetails?.phone || '',
};

const COL_LINKEDIN_URL: ExportColumnDef = {
  id: 'linkedinUrl',
  header: 'LinkedIn Profile URL',
  description: 'Direct LinkedIn profile URL',
  category: 'identity',
  getValue: (l) => l.profile?.contactDetails?.linkedinUrl || '',
};

const COL_LOCATION: ExportColumnDef = {
  id: 'location',
  header: 'Geographic Location',
  description: 'Geographic location (city, state, country)',
  category: 'identity',
  getValue: (l) => l.profile?.location || '',
};

const COL_INDUSTRY: ExportColumnDef = {
  id: 'industry',
  header: 'Industry Segment',
  description: 'Market vertical or sector',
  category: 'company',
  getValue: (l) =>
    l.profile?.industry && l.profile.industry !== 'Tech'
      ? l.profile.industry
      : (l as any).companyAttribution?.industry || l.profile?.industry || 'Tech',
};

const COL_PRIORITY_TIER: ExportColumnDef = {
  id: 'priorityTier',
  header: 'Priority Tier',
  description: 'Outbound priority tier (Tier 1 Priority down to Tier 4)',
  category: 'scoring',
  getValue: (l) => getLeadPriorityTier(l),
};

const COL_COMPOSITE_SCORE: ExportColumnDef = {
  id: 'compositeScore',
  header: 'Composite Score',
  description: 'AI match score (0-100)',
  category: 'scoring',
  getValue: (l) => l.compositeScore ?? l.qualificationScore ?? l.predictiveScore ?? '',
};

const COL_FIT_SCORE: ExportColumnDef = {
  id: 'fitScore',
  header: 'ICP Fit Score',
  description: 'ICP criteria match score (0-10)',
  category: 'scoring',
  getValue: (l) => l.fitScore ?? '',
};

const COL_INTENT_SCORE: ExportColumnDef = {
  id: 'intentScore',
  header: 'Intent Score',
  description: 'Buying and hiring intent strength (0-10)',
  category: 'scoring',
  getValue: (l) => l.intentScore ?? '',
};

const COL_TIMING_SCORE: ExportColumnDef = {
  id: 'timingScore',
  header: 'Timing Score',
  description: 'Recency and why-now event timing score (0-10)',
  category: 'scoring',
  getValue: (l) => l.timingScore ?? '',
};

const COL_ICP_REASONING: ExportColumnDef = {
  id: 'icpReasoning',
  header: 'ICP Fit Rationale',
  description: 'AI evaluation summary explaining why this prospect matches',
  category: 'scoring',
  getValue: (l) => l.icpScoreReasoning || (l as any).qualification?.reason || '',
};

const COL_ICEBREAKER_QUOTE: ExportColumnDef = {
  id: 'icebreakerQuote',
  header: 'Personalized Icebreaker Quote',
  description: 'Verbatim evidence quote or signal snippet for personalized cold email openers',
  category: 'intent',
  getValue: (l) => extractIcebreakerQuote(l),
};

const COL_WHY_NOW_INTENT: ExportColumnDef = {
  id: 'whyNowIntent',
  header: 'Buying Signals & Intent',
  description: 'Active buying signals, hiring triggers, and intent category',
  category: 'intent',
  getValue: (l) => extractIntentCategoryLabel(l),
};

const COL_HIRING_SIGNAL_URL: ExportColumnDef = {
  id: 'hiringSignalUrl',
  header: 'Signal Evidence URL',
  description: 'Direct link to the job posting, social post, or news article grounding the intent',
  category: 'intent',
  getValue: (l) => extractHiringOrSourceUrl(l),
};

const COL_AUTHORITY: ExportColumnDef = {
  id: 'authority',
  header: 'Authority & Decision Maker',
  description: 'Decision maker verification and trajectory score',
  category: 'identity',
  getValue: (l) => extractDecisionMakerLabel(l),
};

const COL_TECH_STACK: ExportColumnDef = {
  id: 'techStack',
  header: 'Tech Stack Hints',
  description: 'Mentioned tools, technologies, and infrastructure',
  category: 'enrichment',
  getValue: (l) => (l.profile?.techStackHints || []).join('; '),
};

const COL_PAIN_INDICATORS: ExportColumnDef = {
  id: 'painIndicators',
  header: 'Pain Indicators',
  description: 'Observed operational bottlenecks or hiring needs',
  category: 'enrichment',
  getValue: (l) => (l.profile?.painIndicators || []).join('; '),
};

const COL_CAREER_SIGNALS: ExportColumnDef = {
  id: 'careerSignals',
  header: 'Career Signals',
  description: 'Recent promotions, founder transitions, or notable achievements',
  category: 'enrichment',
  getValue: (l) => (l.profile?.careerSignals || []).join('; '),
};

const COL_SKILLS: ExportColumnDef = {
  id: 'skills',
  header: 'Skills Keywords',
  description: 'Core skills and domain tags',
  category: 'identity',
  getValue: (l) => (l.profile?.skills || []).join('; '),
};

const COL_SUMMARY: ExportColumnDef = {
  id: 'summary',
  header: 'Biography Summary',
  description: 'Professional biography and headline summary',
  category: 'identity',
  getValue: (l) => l.profile?.summary || '',
};

const COL_HEADLINE: ExportColumnDef = {
  id: 'headline',
  header: 'LinkedIn Headline',
  description: 'Raw LinkedIn professional headline',
  category: 'identity',
  getValue: (l) => l.profile?.headline || '',
};

const COL_STAGE: ExportColumnDef = {
  id: 'stage',
  header: 'Pipeline Stage',
  description: 'Current CRM pipeline stage',
  category: 'workflow',
  getValue: (l) => l.stage,
};

const COL_REVIEW_STATUS: ExportColumnDef = {
  id: 'reviewStatus',
  header: 'Review Status',
  description: 'Review status (UNREVIEWED, KEEP, MAYBE, REJECT)',
  category: 'workflow',
  getValue: (l) => l.reviewStatus || 'UNREVIEWED',
};

const COL_NEXT_ACTION: ExportColumnDef = {
  id: 'nextAction',
  header: 'Next Action',
  description: 'Next planned action (CONNECT, MESSAGE, RESEARCH, NONE)',
  category: 'workflow',
  getValue: (l) => l.nextAction || 'NONE',
};

const COL_TAGS: ExportColumnDef = {
  id: 'tags',
  header: 'Workflow Tags',
  description: 'Assigned categorization tags',
  category: 'workflow',
  getValue: (l) => (l.tags || []).join('; '),
};

const COL_NOTES: ExportColumnDef = {
  id: 'notes',
  header: 'Log Internal Notes',
  description: 'Internal notes and AI qualification logs',
  category: 'workflow',
  getValue: (l) => l.notes || '',
};

const COL_CREATED_DATE: ExportColumnDef = {
  id: 'createdDate',
  header: 'Created Date',
  description: 'Timestamp when lead was discovered',
  category: 'workflow',
  getValue: (l) => (l.createdAt ? new Date(l.createdAt).toLocaleDateString() : ''),
};

const COL_DISCOVERY_QUERY: ExportColumnDef = {
  id: 'discoveryQuery',
  header: 'Discovery Query',
  description: 'Search engine query that surfaced this prospect',
  category: 'diagnostics',
  getValue: (l) => (l as any).evidence?.sourceQuery || (l as any).profile?.evidence?.sourceQuery || '',
};

const COL_MATCHED_CRITERIA: ExportColumnDef = {
  id: 'matchedCriteria',
  header: 'Matched Criteria',
  description: 'Criteria verified during search and qualification',
  category: 'diagnostics',
  getValue: (l) => ((l as any).scout?.matchedCriteria || (l as any).profile?.scout?.matchedCriteria || []).join('; '),
};

const COL_UNCERTAINTIES: ExportColumnDef = {
  id: 'uncertainties',
  header: 'Uncertainties',
  description: 'Uncertainties flagged by the qualification engine',
  category: 'diagnostics',
  getValue: (l) => ((l as any).scout?.uncertainties || (l as any).profile?.scout?.uncertainties || []).join('; '),
};

const COL_CONFIDENCE_INTERVAL: ExportColumnDef = {
  id: 'confidenceInterval',
  header: '95% Credible Interval',
  description: 'Statistical credible interval [lower - upper]',
  category: 'diagnostics',
  getValue: (l) => {
    const ci = l.scoreBreakdown?.confidenceInterval || (l as any).confidenceInterval;
    if (ci && typeof ci.lower === 'number' && typeof ci.upper === 'number') {
      return `[${ci.lower} - ${ci.upper}]`;
    }
    return '';
  },
};

const COL_PARETO_SKYLINE: ExportColumnDef = {
  id: 'paretoSkyline',
  header: 'Pareto Skyline',
  description: 'Whether prospect is a non-dominated candidate across authority and intent',
  category: 'diagnostics',
  getValue: (l) => ((l.paretoSkyline || (l as any).profile?.paretoSkyline) ? 'Yes' : 'No'),
};

const COL_SOURCE_PROVIDER: ExportColumnDef = {
  id: 'sourceProvider',
  header: 'Source Provider',
  description: 'Underlying search provider (tavily, brightdata, cache)',
  category: 'diagnostics',
  getValue: (l) => l.sourceProvider || (l as any).evidence?.sourceProvider || '',
};

// ==========================================
// PRESET COMPOSITIONS
// ==========================================

/**
 * [OUTREACH] OUTREACH CAMPAIGN READY
 * Engineered for Clay, Instantly, Smartlead, Apollo, Lemlist.
 * Focuses on clean company domains, personalized quotes, priority tiers, and contact points.
 */
export const OUTREACH_COLUMNS: readonly ExportColumnDef[] = [
  COL_FIRST_NAME,
  COL_LAST_NAME,
  COL_FULL_NAME,
  COL_TITLE,
  COL_SENIORITY,
  COL_COMPANY,
  COL_COMPANY_DOMAIN,
  COL_COMPANY_WEBSITE,
  COL_COMPANY_SIZE,
  COL_EMAIL,
  COL_PHONE,
  COL_LINKEDIN_URL,
  COL_LOCATION,
  COL_INDUSTRY,
  COL_PRIORITY_TIER,
  COL_COMPOSITE_SCORE,
  COL_ICEBREAKER_QUOTE,
  COL_WHY_NOW_INTENT,
  COL_HIRING_SIGNAL_URL,
  COL_STAGE,
  COL_REVIEW_STATUS,
  COL_NEXT_ACTION,
] as const;

/**
 * [CRM] SALES INTELLIGENCE & CRM SYNC
 * Engineered for HubSpot, Salesforce, Notion, Airtable.
 * Adds deep firmographics, full ICP score breakdown, tech stack hints, pain indicators, and tags.
 */
export const CRM_COLUMNS: readonly ExportColumnDef[] = [
  COL_ID,
  COL_FIRST_NAME,
  COL_LAST_NAME,
  COL_FULL_NAME,
  COL_TITLE,
  COL_SENIORITY,
  COL_YEARS_IN_ROLE,
  COL_COMPANY,
  COL_COMPANY_DOMAIN,
  COL_COMPANY_WEBSITE,
  COL_COMPANY_SIZE,
  COL_BUSINESS_MODEL,
  COL_PRIMARY_OFFERING,
  COL_EMAIL,
  COL_PHONE,
  COL_LINKEDIN_URL,
  COL_LOCATION,
  COL_INDUSTRY,
  COL_PRIORITY_TIER,
  COL_COMPOSITE_SCORE,
  COL_FIT_SCORE,
  COL_INTENT_SCORE,
  COL_TIMING_SCORE,
  COL_ICP_REASONING,
  COL_ICEBREAKER_QUOTE,
  COL_WHY_NOW_INTENT,
  COL_HIRING_SIGNAL_URL,
  COL_AUTHORITY,
  COL_TECH_STACK,
  COL_PAIN_INDICATORS,
  COL_CAREER_SIGNALS,
  COL_SKILLS,
  COL_STAGE,
  COL_REVIEW_STATUS,
  COL_NEXT_ACTION,
  COL_TAGS,
  COL_NOTES,
  COL_CREATED_DATE,
] as const;

/**
 * [DIAGNOSTIC] FULL FORENSIC & DIAGNOSTIC DUMP
 * Complete data archive with 95% Credible Intervals, discovery query lanes, and verification proofs.
 */
export const DIAGNOSTIC_COLUMNS: readonly ExportColumnDef[] = [
  COL_ID,
  COL_FIRST_NAME,
  COL_LAST_NAME,
  COL_FULL_NAME,
  COL_TITLE,
  COL_SENIORITY,
  COL_HEADLINE,
  COL_COMPANY,
  COL_COMPANY_DOMAIN,
  COL_COMPANY_WEBSITE,
  COL_COMPANY_SIZE,
  COL_BUSINESS_MODEL,
  COL_PRIMARY_OFFERING,
  COL_EMAIL,
  COL_PHONE,
  COL_LINKEDIN_URL,
  COL_LOCATION,
  COL_INDUSTRY,
  COL_PRIORITY_TIER,
  COL_COMPOSITE_SCORE,
  COL_FIT_SCORE,
  COL_INTENT_SCORE,
  COL_TIMING_SCORE,
  COL_CONFIDENCE_INTERVAL,
  COL_PARETO_SKYLINE,
  COL_ICP_REASONING,
  COL_ICEBREAKER_QUOTE,
  COL_WHY_NOW_INTENT,
  COL_HIRING_SIGNAL_URL,
  COL_AUTHORITY,
  COL_TECH_STACK,
  COL_PAIN_INDICATORS,
  COL_CAREER_SIGNALS,
  COL_SKILLS,
  COL_SUMMARY,
  COL_DISCOVERY_QUERY,
  COL_SOURCE_PROVIDER,
  COL_MATCHED_CRITERIA,
  COL_UNCERTAINTIES,
  COL_STAGE,
  COL_REVIEW_STATUS,
  COL_NEXT_ACTION,
  COL_TAGS,
  COL_NOTES,
  COL_CREATED_DATE,
] as const;

/**
 * [LEGACY] LEGACY 23-COLUMN FORMAT
 * Exact column headings and format of the original export for backward compatibility.
 */
export const LEGACY_COLUMNS: readonly ExportColumnDef[] = [
  COL_ID,
  COL_FIRST_NAME,
  COL_LAST_NAME,
  COL_FULL_NAME,
  COL_STAGE,
  COL_REVIEW_STATUS,
  COL_NEXT_ACTION,
  COL_TITLE,
  COL_COMPANY,
  COL_WHY_NOW_INTENT,
  COL_AUTHORITY,
  COL_EMAIL,
  COL_PHONE,
  COL_LINKEDIN_URL,
  COL_INDUSTRY,
  COL_LOCATION,
  COL_SKILLS,
  COL_SUMMARY,
  COL_DISCOVERY_QUERY,
  COL_MATCHED_CRITERIA,
  COL_UNCERTAINTIES,
  COL_NOTES,
  COL_CREATED_DATE,
] as const;

export const EXPORT_PRESETS: Record<ExportPresetId, ExportPreset> = {
  outreach: {
    id: 'outreach',
    label: 'Outreach Campaign Ready',
    badge: 'Recommended',
    targetTools: 'Clay, Instantly, Smartlead, Apollo, Lemlist',
    description: 'Clean domains, verified icebreakers, hiring triggers, and priority tiers for personalized cold email.',
    columns: OUTREACH_COLUMNS,
  },
  crm: {
    id: 'crm',
    label: 'Sales Intelligence & CRM Sync',
    badge: 'CRM',
    targetTools: 'HubSpot, Salesforce, Notion, Airtable',
    description: 'Comprehensive firmographics, AI scoring, tech stack, pain points, and pipeline stages.',
    columns: CRM_COLUMNS,
  },
  diagnostic: {
    id: 'diagnostic',
    label: 'Full Forensic & Diagnostic Dump',
    badge: 'Archive',
    targetTools: 'Data analysis, engine auditing, offline backups',
    description: 'Every captured signal, 95% credible intervals, discovery query lanes, and pass/fail matrices.',
    columns: DIAGNOSTIC_COLUMNS,
  },
  legacy: {
    id: 'legacy',
    label: 'Legacy Format (23 Columns)',
    badge: 'Legacy',
    targetTools: 'Backward compatibility with older scripts',
    description: 'The original 23-column CSV format.',
    columns: LEGACY_COLUMNS,
  },
};

// ==========================================
// CSV & TSV SERIALIZATION
// ==========================================

/**
 * Sanitizes a value against CSV formula injection (DDE attacks) in Excel and Sheets.
 * If the value starts with =, +, -, @, \t, or \r, prepends a single quote.
 */
export function sanitizeFormulaInjection(value: string): string {
  if (!value) return '';
  const trimmed = value.trimStart();
  if (/^[=+\-@]/.test(trimmed) || /^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Escapes quotes and wraps field in double quotes per RFC 4180.
 */
export function formatCsvCell(raw: unknown): string {
  if (raw === null || raw === undefined) return '""';
  const str = String(raw);
  const sanitized = sanitizeFormulaInjection(str);
  const escaped = sanitized.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Formats a field for TSV clipboard copying (tabs and newlines sanitized).
 */
export function formatTsvCell(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const str = String(raw);
  const sanitized = sanitizeFormulaInjection(str);
  return sanitized.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Serializes leads into an RFC 4180 compliant CSV string according to the given preset.
 */
export function serializeLeadsToCsv(
  leads: readonly Lead[],
  presetId: ExportPresetId = 'outreach',
): string {
  const preset = EXPORT_PRESETS[presetId] || EXPORT_PRESETS.outreach;
  const headings = preset.columns.map((col) => `"${col.header.replace(/"/g, '""')}"`).join(',');

  const rows = leads.map((lead) => {
    return preset.columns.map((col) => formatCsvCell(col.getValue(lead))).join(',');
  });

  return [headings, ...rows].join('\n');
}

/**
 * Serializes leads into a Tab-Separated Values (TSV) string for instant clipboard pasting.
 */
export function serializeLeadsToTsv(
  leads: readonly Lead[],
  presetId: ExportPresetId = 'outreach',
): string {
  const preset = EXPORT_PRESETS[presetId] || EXPORT_PRESETS.outreach;
  const headings = preset.columns.map((col) => col.header).join('\t');

  const rows = leads.map((lead) => {
    return preset.columns.map((col) => formatTsvCell(col.getValue(lead))).join('\t');
  });

  return [headings, ...rows].join('\n');
}

/**
 * Triggers a file download in the browser.
 */
export function downloadCsvFile(
  csvContent: string,
  presetId: ExportPresetId = 'outreach',
  dateSuffix?: string,
): void {
  if (typeof window === 'undefined' || !window.document) return;

  const date = dateSuffix || new Date().toISOString().slice(0, 10);
  const filename = `apex_crm_${presetId}_${date}.csv`;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

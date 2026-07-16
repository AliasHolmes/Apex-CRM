import type { Lead, NextAction, QualifiedLeadProfile, ReviewStatus, ScoutEvidence } from '@/types';

export const REVIEW_STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: 'UNREVIEWED', label: 'Unreviewed' },
  { value: 'KEEP', label: 'Keep' },
  { value: 'MAYBE', label: 'Maybe' },
  { value: 'REJECT', label: 'Reject' },
];

export const NEXT_ACTION_OPTIONS: { value: NextAction; label: string }[] = [
  { value: 'NONE', label: 'No action' },
  { value: 'OPEN_LINKEDIN', label: 'Open LinkedIn' },
  { value: 'RESEARCH', label: 'Research' },
  { value: 'CONNECT', label: 'Connect' },
  { value: 'MESSAGE', label: 'Message' },
];

export const getReviewStatus = (lead: Lead): ReviewStatus => lead.reviewStatus || 'UNREVIEWED';
export const getNextAction = (lead: Lead): NextAction => lead.nextAction || 'NONE';

export function getLeadProvenance(lead: Lead) {
  const qualifiedProfile = lead.profile as QualifiedLeadProfile;
  const scout: ScoutEvidence | undefined = lead.scout || qualifiedProfile.scout;
  return {
    discoveryQuery: lead.evidence?.sourceQuery || qualifiedProfile.evidence?.sourceQuery || '',
    matchedCriteria: scout?.matchedCriteria || [],
    uncertainties: scout?.uncertainties || [],
    location: lead.profile.location || '',
    industry: lead.profile.industry || '',
    scout,
  };
}

export const getReviewStatusLabel = (status: ReviewStatus) =>
  REVIEW_STATUS_OPTIONS.find(option => option.value === status)?.label || 'Unreviewed';

export const getNextActionLabel = (action: NextAction) =>
  NEXT_ACTION_OPTIONS.find(option => option.value === action)?.label || 'No action';

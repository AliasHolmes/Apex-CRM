import type { Lead } from '@/types';

export function rebaseLeadChanges(
  canonicalLead: Lead,
  desiredLead: Lead,
  baselineLead: Lead | null,
): Lead {
  if (!baselineLead) return { ...desiredLead, revision: canonicalLead.revision };
  const rebasedLead = { ...canonicalLead } as Lead & Record<string, unknown>;
  const baseline = baselineLead as Lead & Record<string, unknown>;
  for (const [key, value] of Object.entries(desiredLead)) {
    if (key === 'id' || key === 'revision') continue;
    if (!Object.is(value, baseline[key])) rebasedLead[key] = value;
  }
  rebasedLead.id = canonicalLead.id;
  rebasedLead.revision = canonicalLead.revision;
  return rebasedLead;
}

export function preferNewerCanonical(candidate: Lead, knownLead?: Lead | null): Lead {
  const candidateRevision = Number(candidate.revision || 0);
  const knownRevision = Number(knownLead?.revision || 0);
  return knownLead && knownRevision > candidateRevision ? knownLead : candidate;
}

import type { Lead } from '@/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepRebaseObject(
  canonical: Record<string, unknown>,
  desired: Record<string, unknown>,
  baseline: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...canonical };
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'id' || key === 'revision') continue;
    const baseVal = baseline[key];
    const canonVal = canonical[key];

    if (isPlainObject(value) && isPlainObject(baseVal) && isPlainObject(canonVal)) {
      result[key] = deepRebaseObject(canonVal, value, baseVal);
    } else if (!Object.is(value, baseVal)) {
      result[key] = value;
    }
  }
  return result;
}

export function rebaseLeadChanges(
  canonicalLead: Lead,
  desiredLead: Lead,
  baselineLead: Lead | null,
): Lead {
  if (!baselineLead) return { ...desiredLead, revision: canonicalLead.revision };
  const rebasedLead = deepRebaseObject(
    canonicalLead as unknown as Record<string, unknown>,
    desiredLead as unknown as Record<string, unknown>,
    baselineLead as unknown as Record<string, unknown>
  ) as unknown as Lead;

  rebasedLead.id = canonicalLead.id;
  rebasedLead.revision = canonicalLead.revision;
  return rebasedLead;
}

export function preferNewerCanonical(candidate: Lead, knownLead?: Lead | null): Lead {
  const candidateRevision = Number(candidate.revision || 0);
  const knownRevision = Number(knownLead?.revision || 0);
  return knownLead && knownRevision > candidateRevision ? knownLead : candidate;
}

import type { ProspectContract, ProspectRequirement } from './prospectContract.js';

export type SelectedEvidence = {
  evidence: Array<{ id: string; text: string }>;
  budgetChars: number;
  totalChars: number;
  coveredHardRequirementIds: string[];
};

const clean = (value: unknown, max = 1_400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const normalize = (value: unknown) => clean(value, 3_000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const unique = (items: string[], maxChars = 12_000) => Array.from(new Set(items.map(item => clean(item, maxChars)).filter(Boolean)));

const hasWholeTerm = (text: string, term: string) => {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedTerm = normalize(term);
  return Boolean(normalizedTerm && normalizedText.includes(` ${normalizedTerm} `));
};

export function matchingTerms(text: string, requirement: ProspectRequirement): string[] {
  return requirement.acceptableTerms.filter(term => hasWholeTerm(text, term));
}

export function structuredProfileEvidence(lead: Record<string, any>, maxChars = 280): string {
  const fields = [
    ['Name', lead.fullName || lead.profile?.fullName],
    ['Title', lead.currentTitle || lead.jobTitle || lead.profile?.currentTitle || lead.headline || lead.profile?.headline],
    ['Company', lead.currentCompany || lead.company || lead.profile?.currentCompany],
    ['Location', lead.location || lead.profile?.location],
    ['Industry', lead.industry || lead.profile?.industry],
    ['Company size', lead.companySizeEst || lead.companySize || lead.profile?.companySizeEst],
  ]
    .map(([label, value]) => value ? `${label}: ${clean(value, 120)}` : '')
    .filter(Boolean);
  return clean(fields.join('\n'), maxChars);
}

/**
 * These are deliberately narrower than retrieval/diagnostic matching. A strict
 * automatic pass may only use the candidate's own structured profile fields.
 * Ambiguous narrative evidence stays with the LLM judge.
 */
export function structuredFieldsForRequirement(lead: Record<string, any>, requirement: ProspectRequirement): string[] {
  const profile = lead.profile || {};
  switch (requirement.scope) {
    case 'person_role':
      return [lead.currentTitle, lead.jobTitle, profile.currentTitle, lead.headline, profile.headline];
    case 'person_location':
      return [lead.location, profile.location];
    case 'company_type':
    case 'company_industry':
      return [lead.currentCompany, lead.company, profile.currentCompany, lead.industry, profile.industry, lead.headline, profile.headline];
    case 'company_size':
      return [lead.companySizeEst, lead.companySize, profile.companySizeEst, lead.companyAccount?.employeeCount, lead.companyAccount?.companySize];
    case 'signal':
      // A signal needs contextual evidence. Never auto-pass it from a loose text match.
      return [];
  }
}

export function hasStrictStructuredMatch(lead: Record<string, any>, requirement: ProspectRequirement): boolean {
  return structuredFieldsForRequirement(lead, requirement)
    .filter(value => value !== undefined && value !== null)
    .some(value => matchingTerms(String(value), requirement).length > 0);
}

const sourceEvidencePieces = (lead: Record<string, any>, evidenceText?: string) => unique([
  evidenceText || '',
  lead.evidence?.rawText || '',
  lead.evidence?.summary || '',
  lead.summary || '',
  ...(Array.isArray(lead.evidence?.snippets) ? lead.evidence.snippets.map((item: any) => typeof item === 'string' ? item : item?.text) : [])
]);

const toSentences = (pieces: string[]) => unique(pieces.flatMap(piece =>
  String(piece || '').replace(/\r/g, '').split(/(?:\n)+|[.!?;]+\s+/).map(sentence => clean(sentence, 520))
));

const crop = (text: string, maxChars: number, terms: string[] = []) => {
  const normalized = clean(text, 2_000);
  if (normalized.length <= maxChars) return normalized;
  const lower = normalized.toLowerCase();
  const matchIndex = terms
    .map(term => lower.indexOf(clean(term).toLowerCase()))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return `${normalized.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
  const start = Math.max(0, matchIndex - Math.floor(maxChars * 0.30));
  const end = Math.min(normalized.length, start + Math.max(1, maxChars - 2));
  return `${start > 0 ? '...' : ''}${normalized.slice(start, end).trim()}${end < normalized.length ? '...' : ''}`;
};

const evidenceBudgetFor = (lead: Record<string, any>, hardRequirementCount: number, profileChars: number) => {
  const coverage = Number(lead.scout?.criteriaCoverageScore);
  const corroboration = Number(lead.scout?.corroborationScore);
  const baseBudget = coverage >= 8 && corroboration >= 7
    ? 650
    : coverage >= 5
      ? 850
      : 1_100;
  // Every hard requirement deserves room for at least one concise supporting passage.
  return Math.min(1_400, Math.max(baseBudget, profileChars + hardRequirementCount * 130));
};

export function selectEvidenceForFinalist(
  lead: Record<string, any>,
  contract: ProspectContract,
  evidenceText?: string
): SelectedEvidence {
  const profile = structuredProfileEvidence(lead);
  const hardRequirements = contract.requirements.filter(requirement => requirement.importance === 'hard');
  const budgetChars = evidenceBudgetFor(lead, hardRequirements.length, profile.length);
  let remaining = Math.max(0, budgetChars - profile.length);
  const sentences = toSentences(sourceEvidencePieces(lead, evidenceText));
  const scored = sentences.map((text, index) => {
    const matchedRequirementIds = contract.requirements
      .filter(requirement => matchingTerms(text, requirement).length > 0)
      .map(requirement => requirement.id);
    const hardMatches = hardRequirements.filter(requirement => matchedRequirementIds.includes(requirement.id)).length;
    return { text, index, matchedRequirementIds, score: hardMatches * 4 + matchedRequirementIds.length };
  });
  const selected = new Set<number>();
  const evidenceLines: string[] = [];
  const coveredHardRequirementIds = new Set<string>();

  const append = (item: typeof scored[number], preferredTerms: string[] = []) => {
    if (selected.has(item.index) || remaining < 60) return false;
    const line = crop(item.text, Math.min(280, remaining), preferredTerms);
    if (line.length < 24) return false;
    selected.add(item.index);
    evidenceLines.push(line);
    remaining -= line.length + 1;
    for (const id of item.matchedRequirementIds) {
      if (hardRequirements.some(requirement => requirement.id === id)) coveredHardRequirementIds.add(id);
    }
    return true;
  };

  // First protect coverage: choose the strongest available sentence for each hard requirement.
  for (const requirement of hardRequirements) {
    const candidate = scored
      .filter(item => item.matchedRequirementIds.includes(requirement.id) && !selected.has(item.index))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0];
    if (candidate) append(candidate, matchingTerms(candidate.text, requirement));
  }

  // Then use the remaining space for the densest evidence, including soft requirements.
  for (const candidate of [...scored].sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (remaining < 60) break;
    append(candidate);
  }

  if (!evidenceLines.length) {
    const fallback = sourceEvidencePieces(lead, evidenceText)[0];
    if (fallback && remaining >= 60) evidenceLines.push(crop(fallback, Math.min(remaining, 300)));
  }

  const evidence = [{ id: 'e0', text: profile || 'No structured profile fields were retrieved.' }];
  if (evidenceLines.length) evidence.push({ id: 'e1', text: evidenceLines.join('\n') });
  const totalChars = evidence.reduce((sum, item) => sum + item.text.length, 0);
  return { evidence, budgetChars, totalChars, coveredHardRequirementIds: [...coveredHardRequirementIds] };
}

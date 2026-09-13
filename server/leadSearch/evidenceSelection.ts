import type { ProspectContract, ProspectRequirement } from './prospectContract.js';
import { isFlagEnabled } from './featureFlags.js';

export type SelectedEvidence = {
  evidence: Array<{ id: string; text: string }>;
  budgetChars: number;
  totalChars: number;
  coveredHardRequirementIds: string[];
};

const clean = (value: unknown, max = 1_400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const normalize = (value: unknown) => clean(value, 3_000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const unique = (items: string[], maxChars = 12_000) => Array.from(new Set(items.map(item => clean(item, maxChars)).filter(Boolean)));

const CLIENT_SERVICE_STEM_REGEX = /\b(clients?|client[-\s]services?|partner(?:s|ing)?\s+with|bespoke|retainer|custom|deliver(?:ing|s|y)?|solutions?\s+for|services?\s+for|advis(?:ing|ory)\s+for|consulting\s+for|workflows?|enterprise\s+(?:customers?|clients?)|projects?\s+for|build(?:ing)?\s+for)\b/i;

const hasWholeTerm = (text: string, term: string) => {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedTerm = normalize(term);
  return Boolean(normalizedTerm && normalizedText.includes(` ${normalizedTerm} `));
};

export function matchingTerms(text: string, requirement: ProspectRequirement): string[] {
  const directMatches = requirement.acceptableTerms.filter(term => hasWholeTerm(text, term));
  if (directMatches.length > 0) return directMatches;

  // Semantic token co-occurrence scoring for company_type / company_industry
  if (requirement.scope === 'company_type' || requirement.scope === 'company_industry') {
    const normText = ` ${normalize(text)} `;
    const genericWords = new Set(['agency', 'agencies', 'consultancy', 'consulting', 'firm', 'firms', 'studio', 'studios', 'services', 'service', 'solutions', 'solution', 'provider', 'providers', 'partner', 'partners', 'group', 'company', 'companies', 'or', 'and', 'for', 'with', 'the', 'a', 'an']);

    const domainStems = new Set<string>();
    for (const term of requirement.acceptableTerms) {
      const words = normalize(term).split(/\s+/).filter(w => w.length >= 2 && !genericWords.has(w));
      for (const w of words) domainStems.add(w);
    }
    if ([...domainStems].some(s => ['ai', 'artificial', 'intelligence', 'learning', 'ml'].includes(s))) {
      domainStems.add('llm');
      domainStems.add('llms');
      domainStems.add('gpt');
      domainStems.add('genai');
    }

    const hasDomainMatch = Array.from(domainStems).some(stem => normText.includes(` ${stem} `));
    const hasClientServiceMatch = CLIENT_SERVICE_STEM_REGEX.test(text);

    if (hasDomainMatch && hasClientServiceMatch) {
      return [requirement.acceptableTerms[0] || requirement.description];
    }
  }

  return [];
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
    case 'person_location': {
      const locationFallback = (!lead.location && !profile.location)
        ? (lead._sourceQuery || lead.evidence?.sourceQuery || lead.sourceQuery)
        : undefined;
      return [lead.location, profile.location, locationFallback];
    }
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
  if (requirement.scope === 'company_type' || requirement.scope === 'company_industry') {
    const hasCompany = Boolean(clean(lead.currentCompany || lead.company || lead.profile?.currentCompany || lead.organization || ''));
    const isEntityVerified = Boolean(lead.companyEntityResolution?.verified && lead.companyEntityResolution?.companyName);
    if (!hasCompany && !isEntityVerified) {
      return false;
    }
  }
  return structuredFieldsForRequirement(lead, requirement)
    .filter(value => value !== undefined && value !== null)
    .some(value => {
      const text = String(value);
      return requirement.acceptableTerms.some(term => hasWholeTerm(text, term));
    });
}

const sourceEvidencePieces = (lead: Record<string, any>, evidenceText?: string) => unique([
  evidenceText || '',
  lead.evidence?.evidenceBlock || '',
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
  const signalHardReqs = hardRequirements.filter(r =>
    (r.evidenceModality || (r.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal'
  );

  const budgetChars = evidenceBudgetFor(lead, hardRequirements.length, profile.length);
  let remaining = Math.max(0, budgetChars - profile.length);

  // --- Signal evidence reservation ---
  // Extract [OPEN-WEB SIGNAL: ...] blocks before general sentence scoring.
  // These are pinned into their own evidence slot and never evicted by the budget.
  const allPieces = sourceEvidencePieces(lead, evidenceText);
  const signalPieces = signalHardReqs.length > 0
    ? allPieces.filter(piece => piece.includes('[OPEN-WEB SIGNAL:'))
    : [];
  const signalEvidenceText = signalPieces.map(p => clean(p, 600)).join('\n').slice(0, 600);

  const sentences = toSentences(allPieces);
  const scored = sentences.map((text, index) => {
    const matchedRequirementIds = contract.requirements
      .filter(requirement => matchingTerms(text, requirement).length > 0)
      .map(requirement => requirement.id);
    const hardMatches = hardRequirements.filter(requirement => matchedRequirementIds.includes(requirement.id)).length;
    let score = hardMatches * 4 + matchedRequirementIds.length;
    if (CLIENT_SERVICE_STEM_REGEX.test(text) && matchedRequirementIds.length > 0) {
      score += 3;
    }
    
    if (isFlagEnabled.evidenceAware()) {
      for (const id of matchedRequirementIds) {
        const req = contract.requirements.find(r => r.id === id);
        if (req?.acceptableEvidenceSources?.length) {
          const sourceMatch = req.acceptableEvidenceSources.some(src => {
            if (src === 'linkedin_profile') return /linkedin\.com|profile/i.test(text);
            if (src === 'company_website') return /website|\.com|\.io|about us/i.test(text);
            if (src === 'job_postings') return /job|hiring|careers|posted/i.test(text);
            if (src === 'news_articles') return /news|press|article|reported/i.test(text);
            return true;
          });
          if (sourceMatch) score += 3;
        }
      }
    }
    
    return { text, index, matchedRequirementIds, score };
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
    const fallback = allPieces[0];
    if (fallback && remaining >= 60) evidenceLines.push(crop(fallback, Math.min(remaining, 300)));
  }

  const evidence = [{ id: 'e0', text: profile || 'No structured profile fields were retrieved.' }];
  if (evidenceLines.length) evidence.push({ id: 'e1', text: evidenceLines.join('\n') });
  if (signalEvidenceText) {
    evidence.push({ id: 'e2', text: signalEvidenceText });
    for (const req of signalHardReqs) {
      if (matchingTerms(signalEvidenceText, req).length > 0) {
        coveredHardRequirementIds.add(req.id);
      }
    }
  }

  const totalChars = evidence.reduce((sum, item) => sum + item.text.length, 0);
  return { evidence, budgetChars, totalChars, coveredHardRequirementIds: [...coveredHardRequirementIds] };
}

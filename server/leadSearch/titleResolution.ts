import type { ProspectContract } from './prospectContract.js';
import type { Qualification } from './finalistJudge.js';

export type TitleResolutionInput = {
  lead: Record<string, any>;
  qualification?: Pick<Qualification, 'requirements' | 'reason'> | null;
  contract?: ProspectContract | null;
  evidence?: Array<{ id?: string; text?: string }> | null;
};

export type TitleResolutionResult = {
  title: string;
  source: 'inferred_from_qualification';
};

const GENERIC_LEADERSHIP_TITLES = [
  'co-founder & ceo',
  'co-founder and ceo',
  'founder & ceo',
  'founder and ceo',
  'chief executive officer',
  'chief technology officer',
  'chief operating officer',
  'chief financial officer',
  'chief marketing officer',
  'chief revenue officer',
  'chief product officer',
  'managing director',
  'managing partner',
  'co-founder',
  'cofounder',
  'founder',
  'president',
  'owner',
  'partner',
  'ceo',
  'cto',
  'coo',
  'cfo',
  'cmo',
  'cro',
];

const NEGATION_PATTERN = /\b(former|ex-|ex\b|past|previous|retired|advisor|adviser|board\s+member|emeritus)\b/i;
const PROFILE_TAG_PATTERN = /\[(PROFILE|LINKEDIN|CANDIDATE|RESUME)/i;

/**
 * Resolves a missing or empty lead title using verified qualification evidence.
 * Pure function: never mutates arguments, returns null if no valid title can be inferred.
 */
export function resolveTitleFromQualification(
  input: TitleResolutionInput,
): TitleResolutionResult | null {
  const { lead, qualification, contract, evidence } = input;
  if (!lead || !qualification) return null;

  const currentTitle = String(lead.currentTitle || lead.title || '').trim();
  const fullName = String(lead.fullName || '').trim().toLowerCase();
  const isTitleEmptyOrName = !currentTitle || currentTitle.toLowerCase() === fullName;
  if (!isTitleEmptyOrName) return null;

  const roleReq = (qualification.requirements || []).find((r: any) =>
    (r.requirementId === 'person_role-1' || String(r.requirementId || '').startsWith('person_role')) &&
    r.status === 'pass' &&
    typeof r.evidenceQuote === 'string' &&
    r.evidenceQuote.trim().length > 0,
  );
  if (!roleReq) return null;

  const quote = String(roleReq.evidenceQuote || '').trim();
  if (!quote || NEGATION_PATTERN.test(quote)) return null;

  // Attribution check: verify quote is about candidate, not a colleague or third party
  const leadFirst = fullName.split(/\s+/)[0] || '';
  const leadLast = fullName.split(/\s+/).slice(-1)[0] || '';
  const hasNameInQuote =
    (leadFirst.length > 2 && new RegExp(`\\b${leadFirst}\\b`, 'i').test(quote)) ||
    (leadLast.length > 2 && new RegExp(`\\b${leadLast}\\b`, 'i').test(quote));

  if (evidence && Array.isArray(evidence)) {
    const evidenceItem = evidence.find((e) => e?.id === roleReq.evidenceId);
    const hasProfileTag = evidenceItem?.text ? PROFILE_TAG_PATTERN.test(evidenceItem.text) : false;
    const isCompanyAttr = roleReq.evidenceId === 'e_company_attr';

    // If evidence block is neither a profile tag nor company attribution, require name in quote
    if (!hasProfileTag && !isCompanyAttr && !hasNameInQuote) {
      return null;
    }

    // Guard: team page quote explicitly naming another person
    // If quote mentions "X is founder" where X is a different two-word name
    const otherNameMatch = quote.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/);
    if (otherNameMatch && !hasNameInQuote) {
      const mentioned = otherNameMatch[1].toLowerCase();
      if (mentioned !== fullName) {
        return null;
      }
    }
  } else {
    // Persist backstop: evidence not supplied, require candidate name in quote
    if (!hasNameInQuote) {
      return null;
    }
  }

  // Contract-permitted acceptable terms for person_role
  const contractRoleTerms: string[] = (contract?.requirements || [])
    .filter((r: any) => r.scope === 'person_role' && Array.isArray(r.acceptableTerms))
    .flatMap((r: any) => r.acceptableTerms.map((t: string) => String(t || '').trim().toLowerCase()))
    .filter(Boolean);

  const allowsBareDirector = contractRoleTerms.some((t) => t === 'director');
  const allowsBarePrincipal = contractRoleTerms.some((t) => t === 'principal');

  // Candidate terms sorted longest-first for longest-span match
  const allCandidateTerms = Array.from(
    new Set([...GENERIC_LEADERSHIP_TITLES, ...contractRoleTerms]),
  ).sort((a, b) => b.length - a.length);

  for (const term of allCandidateTerms) {
    if (term === 'director' && !allowsBareDirector) continue;
    if (term === 'principal' && !allowsBarePrincipal) continue;

    const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b(${escaped})\\b`, 'i');
    const match = quote.match(regex);
    if (match) {
      return {
        title: match[1], // Preserve casing from quote
        source: 'inferred_from_qualification',
      };
    }
  }

  return null;
}

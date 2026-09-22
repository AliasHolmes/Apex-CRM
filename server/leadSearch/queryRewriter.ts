/**
 * Phase 2: Complexity-aware query rewriter.
 * Replaces brittle createAblationTracker(2) with deterministic rewrite rules:
 * - vague: drop 1 constraint + synonym substitution (broaden)
 * - rich: demote lowest-salience hard -> soft (relax)
 * Max 3 rewrites per query; recomputes coveredRequirementIds.
 */
import type { ProspectContract, ProspectRequirement } from './prospectContract.js';
import { computeCoveredRequirementIds } from './prospectContract.js';
import { classifyQueryComplexity } from './queryUnderstanding.js';
import { expandAliasTerm } from './aliasMap.js';
import { classifyAblationTier, ABLATION_TIERS } from './constraintAblation.js';

export type RewriteResult = {
  query: string;
  demotedRequirementId?: string;
  droppedTerm?: string;
  strategy: 'broaden' | 'relax' | 'synonym_swap' | 'none';
};

const clean = (v: unknown) => String(v || '').replace(/\s+/g, ' ').trim();

function salienceOf(req: ProspectRequirement): number {
  if (req.requirementClass === 'identity_hard') return 100;
  if (req.scope === 'person_role') return 90;
  if (req.scope === 'person_location') return 70;
  if (req.scope === 'company_type' || req.scope === 'company_industry') return 60;
  if (req.scope === 'company_size') return 40;
  if (req.scope === 'signal') return 20;
  return 10;
}

export function rewriteZeroYieldQuery(
  query: string,
  contract: ProspectContract | null | undefined,
  attempt = 1,
): RewriteResult {
  const base = clean(query);
  if (!base || !contract || attempt > 3) return { query: base, strategy: 'none' };
  const complexity = classifyQueryComplexity(contract.brief || base);

  // G8: identity anchors are never droppable -- collect Tier-1 terms first.
  const identityTerms = new Set<string>();
  for (const req of contract.requirements || []) {
    if (classifyAblationTier(req) === ABLATION_TIERS.TIER_1_IMMUTABLE_CORE) {
      for (const t of [...(req.acceptableTerms || []), req.sourcePhrase]) {
        if (t && t.trim().length >= 2) identityTerms.add(t.trim().toLowerCase());
      }
    }
  }
  for (const t of [...(contract.identitySpec?.roles || []), ...(contract.identitySpec?.companyTypes || []), ...(contract.identitySpec?.industries || [])]) {
    if (t && String(t).trim().length >= 2) identityTerms.add(String(t).trim().toLowerCase());
  }
  const isAnchorToken = (token: string) => {
    const l = token.toLowerCase();
    for (const term of identityTerms) {
      if (term === l || term.split(/\s+/).includes(l)) return true;
    }
    return false;
  };

  if (complexity.tier === 'vague' || complexity.tier === 'standard') {
    // Broaden: drop the longest low-signal token (metro/country or filler) + synonym swap.
    // G8: never drop the trailing token when it is an identity anchor --
    // "... agency owner" must not become "... agency".
    const tokens = base.split(' ').filter(Boolean);
    if (tokens.length <= 2) {
      // Synonym swap only: expand first term via alias
      const expanded = expandAliasTerm(tokens[0]);
      const alt = expanded.find(e => e.toLowerCase() !== tokens[0].toLowerCase());
      if (alt) return { query: [alt, ...tokens.slice(1)].join(' '), strategy: 'synonym_swap' };
      return { query: base, strategy: 'none' };
    }
    // Drop a likely-constraint token: prefer trailing geo/metro token, but
    // skip identity anchors scanning from the right.
    let dropIndex = tokens.length - 1;
    while (dropIndex > 0 && isAnchorToken(tokens[dropIndex])) dropIndex--;
    if (dropIndex <= 0 && isAnchorToken(tokens[0])) {
      // Entire query is identity anchors -- synonym swap or nothing.
      const expanded = expandAliasTerm(tokens[0]);
      const alt = expanded.find(e => e.toLowerCase() !== tokens[0].toLowerCase());
      if (alt) return { query: [alt, ...tokens.slice(1)].join(' '), strategy: 'synonym_swap' };
      return { query: base, strategy: 'none' };
    }
    const dropped = tokens[dropIndex];
    const broadened = [...tokens.slice(0, dropIndex), ...tokens.slice(dropIndex + 1)].join(' ');
    return { query: broadened, droppedTerm: dropped, strategy: 'broaden' };
  }

  // Rich: relax lowest-salience hard requirement whose terms appear in query.
  // G8: Tier-1 identity requirements are excluded from relaxation candidates,
  // and person_location is preferred over company_type for demotion.
  const hard = (contract.requirements || []).filter(r => r.importance === 'hard');
  const covered = new Set(computeCoveredRequirementIds(base, contract.requirements, false));
  const candidates = hard
    .filter(r => covered.has(r.id))
    .filter(r => classifyAblationTier(r) !== ABLATION_TIERS.TIER_1_IMMUTABLE_CORE)
    .sort((a, b) => {
      // Prefer dropping person_location before company_type (invert salience for rewriter).
      if (a.scope === 'person_location' && b.scope !== 'person_location') return -1;
      if (b.scope === 'person_location' && a.scope !== 'person_location') return 1;
      return salienceOf(a) - salienceOf(b);
    });
  const victim = candidates[0];
  if (!victim) return { query: base, strategy: 'none' };
  let relaxed = base;
  for (const term of victim.acceptableTerms || []) {
    const escaped = String(term).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i');
    if (re.test(relaxed)) {
      relaxed = relaxed.replace(re, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }
  if (relaxed === base) return { query: base, strategy: 'none' };
  return { query: relaxed, demotedRequirementId: victim.id, droppedTerm: victim.acceptableTerms?.[0], strategy: 'relax' };
}

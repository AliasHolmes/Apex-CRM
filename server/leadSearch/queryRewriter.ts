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

  if (complexity.tier === 'vague' || complexity.tier === 'standard') {
    // Broaden: drop the longest low-signal token (metro/country or filler) + synonym swap
    const tokens = base.split(' ').filter(Boolean);
    if (tokens.length <= 2) {
      // Synonym swap only: expand first term via alias
      const expanded = expandAliasTerm(tokens[0]);
      const alt = expanded.find(e => e.toLowerCase() !== tokens[0].toLowerCase());
      if (alt) return { query: [alt, ...tokens.slice(1)].join(' '), strategy: 'synonym_swap' };
      return { query: base, strategy: 'none' };
    }
    // Drop a likely-constraint token: prefer trailing geo/metro token
    const dropped = tokens[tokens.length - 1];
    const broadened = tokens.slice(0, -1).join(' ');
    return { query: broadened, droppedTerm: dropped, strategy: 'broaden' };
  }

  // Rich: relax lowest-salience hard requirement whose terms appear in query
  const hard = (contract.requirements || []).filter(r => r.importance === 'hard');
  const covered = new Set(computeCoveredRequirementIds(base, contract.requirements, false));
  const candidates = hard
    .filter(r => covered.has(r.id))
    .sort((a, b) => salienceOf(a) - salienceOf(b));
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

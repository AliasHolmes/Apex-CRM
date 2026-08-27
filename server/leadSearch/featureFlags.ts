/**
 * Feature flag reader for Intelligent Hard Term refactor phases.
 * All flags default to OFF for backward compatibility.
 * Flags are environment-driven; toggle via process.env.
 *
 * Usage:
 *   if (isFlagEnabled.taxonomy()) { ... activate Phase 1 ... }
 *   if (isFlagEnabled.distributedQuery()) { ... activate Phase 2 ... }
 */

const readFlag = (envName: string, fallback = false): boolean => {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
};

export const isFlagEnabled = {
  /**
   * Phase 1: Requirement Taxonomy Enhancement
   * Adds requirementClass and queryHardness fields; no behavior change
   */
  taxonomy: () => readFlag('REQUIREMENT_TAXONOMY_ENABLED'),

  /**
   * Phase 2: Query Enforcement Decoupling
   * Replaces append-all-hard-reqs with 1 Identity + 1 Distributed Context
   */
  distributedQuery: () => readFlag('DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED'),

  /**
   * Phase 3: Semantic Grouping Support
   * Honors any_of groups; if one member passes, all members pass
   */
  semanticGrouping: () => readFlag('SEMANTIC_GROUPING_ENABLED'),

  /**
   * Phase 4: Evidence-Aware Hardness
   * Routes evidence by modality; penalizes missing preferred sources
   */
  evidenceAware: () => readFlag('EVIDENCE_AWARE_HARDNESS_ENABLED'),

  /**
   * Phase 5: Adaptive Scheduler Enhancement
   * Enforces per-class coverage requirements
   */
  classAwareScheduler: () => readFlag('CLASS_AWARE_SCHEDULER_ENABLED'),

  /**
   * Phase 6: Diagnostics Enhancement
   * Emits class-level diagnostics; recovery considers class bottlenecks
   */
  enhancedDiagnostics: () => readFlag('ENHANCED_DIAGNOSTICS_ENABLED'),

  /**
   * Optimization 1: Fuzzy Token-Aligned Quote Grounding
   * Prevents false fabrication flags from whitespace/quote formatting differences
   */
  fuzzyQuoteGrounding: () => readFlag('FUZZY_QUOTE_GROUNDING_ENABLED'),

  /**
   * Optimization 2: Safe Slug Probing & Anti-Hijacking
   * Enforces dual-attribute corroboration on guessed .com domains
   */
  safeSlugProbe: () => readFlag('SAFE_SLUG_PROBE_ENABLED'),

  /**
   * Optimization 3: Company Entity Resolution & Domain Registry
   * Canonical domain-stem clustering and collision protection
   */
  companyEntityRegistry: () => readFlag('COMPANY_ENTITY_REGISTRY_ENABLED'),

  /**
   * Optimization 4: Context-Anchored Reverse Flywheel Queries
   * Anchors intent-discovered accounts with geographic/domain keywords
   */
  anchoredFlywheel: () => readFlag('ANCHORED_FLYWHEEL_QUERIES_ENABLED'),

  /**
   * Optimization 5: Full Jitter Exponential Backoff
   * Eliminates thundering-herd retry bursts on 429s
   */
  fullJitterRetry: () => readFlag('FULL_JITTER_RETRY_ENABLED'),

  /**
   * Optimization 6: Transient vs Permanent Negative Cache Separation
   * Prevents temporary 429/timeout errors from locking leads for 14 days
   */
  transientNegativeCache: () => readFlag('TRANSIENT_NEGATIVE_CACHE_ENABLED'),

  /**
   * Optimization 7: Proactive Token Regulator & Load Shedder
   * Meters sliding-window token rates to prevent 429 rate limits
   */
  proactiveTokenRegulator: () => readFlag('PROACTIVE_TOKEN_REGULATOR_ENABLED')
};

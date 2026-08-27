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
  enhancedDiagnostics: () => readFlag('ENHANCED_DIAGNOSTICS_ENABLED')
};

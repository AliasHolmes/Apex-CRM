/**
 * Dual-provider discovery routing for free-tier Tavily + Bright Data Rapid MCP.
 *
 * Credit reservation is intentionally not used here. Multi-key pools rotate on
 * quota/rate-limit failures; routing only decides which providers to call.
 */

import type { RetrievalTask } from './searchSpec.js';

export type DiscoveryProviderMode = 'bd_primary' | 'hybrid' | 'tavily_primary';
export type BrightDataSearchMode = 'off' | 'fallback' | 'secondary' | 'primary' | 'always';

const asMode = (value: unknown): DiscoveryProviderMode | null => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'bd_primary' || mode === 'hybrid' || mode === 'tavily_primary') return mode;
  return null;
};

const asBrightDataSearchMode = (value: unknown): BrightDataSearchMode | null => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'off' || mode === 'fallback' || mode === 'secondary' || mode === 'primary' || mode === 'always') {
    return mode;
  }
  return null;
};

/** Resolve high-level discovery posture from env and provider availability. */
export function resolveDiscoveryProviderMode(options: {
  brightDataConfigured: boolean;
  tavilyConfigured?: boolean;
  envMode?: string;
}): DiscoveryProviderMode {
  const explicit = asMode(options.envMode ?? process.env.DISCOVERY_PROVIDER_MODE);
  if (explicit) {
    if (explicit === 'bd_primary' && !options.brightDataConfigured) return 'tavily_primary';
    return explicit;
  }
  if (options.brightDataConfigured) return 'hybrid';
  return 'tavily_primary';
}

/**
 * Map discovery mode + env onto Bright Data search behavior.
 * Defaults to primary search when Bright Data is part of the dual stack.
 */
export function resolveBrightDataSearchMode(options: {
  discoveryMode: DiscoveryProviderMode;
  envMode?: string;
}): BrightDataSearchMode {
  const explicit = asBrightDataSearchMode(options.envMode ?? process.env.BRIGHTDATA_SEARCH_MODE);
  if (explicit) return explicit;
  if (options.discoveryMode === 'bd_primary') return 'primary';
  if (options.discoveryMode === 'hybrid') return 'primary';
  return 'fallback';
}

export function shouldRunTavilyForTask(
  task: Pick<RetrievalTask, 'lane' | 'providerPreference' | 'priority'>,
  discoveryMode: DiscoveryProviderMode,
  tavilyConfigured: boolean
): boolean {
  if (!tavilyConfigured) return false;
  if (discoveryMode === 'tavily_primary') return true;
  if (discoveryMode === 'bd_primary') {
    // Keep a small Tavily precision set: high-priority person tasks only.
    return task.lane === 'person' && (task.priority || 99) <= 2;
  }
  // hybrid: Tavily owns person-lane precision; account/signal lean on Bright Data.
  if (task.providerPreference === 'tavily') return true;
  if (task.lane === 'person') return true;
  if (task.providerPreference === 'corroborate') return true;
  return false;
}

export function shouldRunBrightDataForTask(
  task: Pick<RetrievalTask, 'lane' | 'providerPreference'>,
  discoveryMode: DiscoveryProviderMode,
  brightDataSearchMode: BrightDataSearchMode,
  options: {
    brightDataReady: boolean;
    tavilyResultCount?: number;
  }
): boolean {
  if (!options.brightDataReady || brightDataSearchMode === 'off') return false;

  if (brightDataSearchMode === 'primary' || brightDataSearchMode === 'always') {
    return true;
  }

  if (brightDataSearchMode === 'secondary') {
    return task.providerPreference === 'corroborate'
      || task.providerPreference === 'brightdata'
      || task.lane === 'account'
      || task.lane === 'signal';
  }

  // fallback: recover low-yield Tavily rounds, or honor explicit BD preference.
  if (task.providerPreference === 'brightdata') return true;
  if ((options.tavilyResultCount ?? 0) < 5) return true;
  return false;
}

export function filterTasksForTavily<T extends Pick<RetrievalTask, 'lane' | 'providerPreference' | 'priority'>>(
  tasks: T[],
  discoveryMode: DiscoveryProviderMode,
  tavilyConfigured: boolean
): T[] {
  return tasks.filter(task => shouldRunTavilyForTask(task, discoveryMode, tavilyConfigured));
}

export function filterTasksForBrightData<T extends Pick<RetrievalTask, 'lane' | 'providerPreference'>>(
  tasks: T[],
  discoveryMode: DiscoveryProviderMode,
  brightDataSearchMode: BrightDataSearchMode,
  options: { brightDataReady: boolean; tavilyResultCount?: number }
): T[] {
  return tasks.filter(task => shouldRunBrightDataForTask(task, discoveryMode, brightDataSearchMode, options));
}

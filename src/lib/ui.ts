export const PROSPECTS_PAGE_SIZE = 100;

export const MANUAL_PROSPECT_INDUSTRIES = [
  'Legal Services',
  'Software Engineering',
  'Human Resources',
  'Finance & Venture',
  'Healthcare',
  'Marketing',
] as const;

export const DEFAULT_MANUAL_INDUSTRY = MANUAL_PROSPECT_INDUSTRIES[1];

export function isDiscoveryProviderConfigured(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  const status = health as {
    hasKey?: unknown;
    hasTavilyKey?: unknown;
    brightData?: { configured?: unknown };
    providerCapabilities?: { brightData?: { configured?: unknown } };
  };
  const hasRetrievalProvider = status.hasTavilyKey === true
    || status.brightData?.configured === true
    || status.providerCapabilities?.brightData?.configured === true;
  return status.hasKey === true && hasRetrievalProvider;
}

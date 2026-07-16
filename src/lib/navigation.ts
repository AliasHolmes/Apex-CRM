export const DASHBOARD_NAV_ITEMS = [
  { id: 'overview', hash: 'overview', label: 'Overview' },
  { id: 'workspace', hash: 'discover', label: 'Discover' },
  { id: 'inventory', hash: 'prospects', label: 'Prospects' },
  { id: 'pipeline', hash: 'pipeline', label: 'Pipeline' },
  { id: 'outreach', hash: 'outreach', label: 'Outreach' },
] as const;

export type DashboardTab = (typeof DASHBOARD_NAV_ITEMS)[number]['id'];

const LEGACY_TAB_HASHES: Readonly<Record<string, DashboardTab>> = {
  workspace: 'workspace',
  inventory: 'inventory',
};

export function getTabFromHash(hash: string): DashboardTab {
  const normalizedHash = hash.replace(/^#/, '').trim().toLowerCase();
  return DASHBOARD_NAV_ITEMS.find((item) => item.hash === normalizedHash)?.id
    ?? LEGACY_TAB_HASHES[normalizedHash]
    ?? 'overview';
}

export function getHashForTab(tab: DashboardTab): string {
  return `#${DASHBOARD_NAV_ITEMS.find((item) => item.id === tab)?.hash ?? 'overview'}`;
}

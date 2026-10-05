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

/** `#prospects/lead-123` -> ['prospects', 'lead-123']. Only the first two segments matter. */
function splitHash(hash: string): [string, string | null] {
  const normalized = hash.replace(/^#/, '').trim();
  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) return [normalized.toLowerCase(), null];
  const rawLeadId = normalized.slice(slashIndex + 1).split('/')[0];
  let leadId: string | null = null;
  if (rawLeadId) {
    try {
      leadId = decodeURIComponent(rawLeadId);
    } catch {
      leadId = null;
    }
  }
  return [normalized.slice(0, slashIndex).toLowerCase(), leadId];
}

export function getTabFromHash(hash: string): DashboardTab {
  const [tabSegment] = splitHash(hash);
  return DASHBOARD_NAV_ITEMS.find((item) => item.hash === tabSegment)?.id
    ?? LEGACY_TAB_HASHES[tabSegment]
    ?? 'overview';
}

export function getHashForTab(tab: DashboardTab): string {
  return `#${DASHBOARD_NAV_ITEMS.find((item) => item.id === tab)?.hash ?? 'overview'}`;
}

/** The lead addressed by a deep link such as `#prospects/lead-123`, or null. */
export function getLeadIdFromHash(hash: string): string | null {
  return splitHash(hash)[1];
}

/** Hash that shows `leadId` in the shared lead drawer on top of `tab`. */
export function getHashForLead(tab: DashboardTab, leadId: string): string {
  return `${getHashForTab(tab)}/${encodeURIComponent(leadId)}`;
}

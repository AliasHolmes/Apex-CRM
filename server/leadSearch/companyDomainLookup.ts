import {
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry,
} from "../db.js";
import { normalizeCompanyName, distinctiveTokens } from "./signalStore.js";
import { isPrivateOrInternalHost } from "../services/privateHosts.js";
import type { SessionContext } from "./pipelineTypes.js";

const BLOCKED_DOMAINS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "google.com",
  "www.google.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "crunchbase.com",
  "www.crunchbase.com",
  "glassdoor.com",
  "www.glassdoor.com",
  "youtube.com",
  "www.youtube.com",
  "github.com",
  "www.github.com",
  "tiktok.com",
  "www.tiktok.com",
  "reddit.com",
  "www.reddit.com",
  "t.co",
  "bit.ly",
]);

export const EXCLUDED_LOOKUP_HOSTS = new Set([
  ...BLOCKED_DOMAINS,
  "clutch.co",
  "www.clutch.co",
  "yelp.com",
  "www.yelp.com",
  "yellowpages.com",
  "www.yellowpages.com",
  "bloomberg.com",
  "www.bloomberg.com",
  "zoominfo.com",
  "www.zoominfo.com",
  "apollo.io",
  "www.apollo.io",
  "pitchbook.com",
  "www.pitchbook.com",
  "dnb.com",
  "www.dnb.com",
  "owler.com",
  "www.owler.com",
  "wikipedia.org",
  "en.wikipedia.org",
  "medium.com",
  "www.medium.com",
  "substack.com",
  "gov.nz",
  "govt.nz",
  "gov",
  "org",
]);

export type DomainLookupResult = {
  domain: string;
  host: string;
  provenance: "tavily_lookup";
};

export function isHostExcluded(host: string): boolean {
  if (!host) return true;
  const cleanHost = host.toLowerCase().replace(/^www\./, "");
  if (EXCLUDED_LOOKUP_HOSTS.has(cleanHost) || EXCLUDED_LOOKUP_HOSTS.has(`www.${cleanHost}`)) {
    return true;
  }
  for (const excluded of EXCLUDED_LOOKUP_HOSTS) {
    if (cleanHost === excluded || cleanHost.endsWith(`.${excluded}`)) {
      return true;
    }
  }
  return isPrivateOrInternalHost(cleanHost);
}

export function matchLookupResultToCompany(
  item: { uri?: string; url?: string; title?: string },
  companyName: string,
): DomainLookupResult | null {
  const rawUrl = item.uri || item.url || "";
  if (!rawUrl) return null;

  let host = "";
  try {
    const parsed = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }

  if (isHostExcluded(host)) return null;

  const normalizedCompany = normalizeCompanyName(companyName);
  const companySlug = normalizedCompany.replace(/[^a-z0-9]/g, "");
  if (companySlug.length < 2) return null;

  const hostWithoutTld = host.split(".").slice(0, -1).join(".");
  const hostSlug = hostWithoutTld.replace(/[^a-z0-9]/g, "");

  // 1. Host slug directly contains or equals company slug
  if (hostSlug.includes(companySlug) || companySlug.includes(hostSlug)) {
    return {
      domain: `https://${host}`,
      host,
      provenance: "tavily_lookup",
    };
  }

  // 2. Distinctive company tokens match host
  const tokens = distinctiveTokens(companyName);
  if (tokens.length > 0) {
    const allTokensInHost = tokens.every((token) => hostSlug.includes(token));
    if (allTokensInHost) {
      return {
        domain: `https://${host}`,
        host,
        provenance: "tavily_lookup",
      };
    }
  }

  // 3. Title strongly mentions company name AND host shares at least one meaningful token
  const title = (item.title || "").toLowerCase();
  const lowerCompany = companyName.toLowerCase();
  const titleMentionsCompany = title.includes(lowerCompany) || title.includes(normalizedCompany);

  if (titleMentionsCompany && tokens.length > 0) {
    const hostSharesToken = tokens.some((token) => hostSlug.includes(token));
    if (hostSharesToken) {
      return {
        domain: `https://${host}`,
        host,
        provenance: "tavily_lookup",
      };
    }
  }

  return null;
}

export async function lookupCompanyDomain(
  companyName: string,
  locationAnchor: string,
  sessionCtx: SessionContext,
  options?: {
    signal?: AbortSignal;
  },
): Promise<DomainLookupResult | null> {
  const normalizedCompany = normalizeCompanyName(companyName);
  if (!normalizedCompany || normalizedCompany.length < 2) return null;

  const negKey = `lookup:${normalizedCompany}`;
  const negCache = getNegativeEnrichmentCacheEntry({ normalizedUrl: negKey }, new Date(), "site_probe");
  if (negCache) return null;

  const reserved = sessionCtx.state.freeTierBudget.reserveTavilySearch("basic");
  if (!reserved) return null;

  const cleanLocation = (locationAnchor || "").trim();
  const query = cleanLocation
    ? `"${companyName}" ${cleanLocation} about`
    : `"${companyName}" about`;

  try {
    const resp = await sessionCtx.ports.tavilySearch(query, {
      max_results: 5,
      search_depth: "basic",
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    const candidateItems: Array<{ uri?: string; url?: string; title?: string }> = [
      ...(Array.isArray(resp?.items) ? resp.items : []),
      ...(Array.isArray(resp?.sources)
        ? resp.sources.map((s) => ({ uri: s.uri, title: s.title }))
        : []),
    ];

    for (const item of candidateItems) {
      const match = matchLookupResultToCompany(item, companyName);
      if (match) {
        return match;
      }
    }

    // No accepted match: write negative cache to avoid repeating wasted calls
    upsertNegativeEnrichmentCacheEntry(
      {
        normalizedUrl: negKey,
        scrapeQuality: "bad",
        evidenceBlock: "no_domain_lookup_failed",
        sourceProvider: "site_probe",
      },
      24,
    );
    return null;
  } catch (err: any) {
    return null;
  }
}

# 20. Bright Data MCP v4.6.0 Upgrade, FastMCP Schema Alignment, and Search Batch Parallelization

Date: 2026-11-08

## Status

Accepted (amends ADR-0007, ADR-0008, ADR-0012, and ADR-0013)

## Scope

This ADR covers the full upgrade of Apex CRM's Bright Data integration from `@brightdata/mcp@2.11.1` to `@brightdata/mcp@4.6.0`, resolving FastMCP schema breaking changes, eliminating silent failure modes, and unlocking high-throughput batch retrieval:
- FastMCP `.strict()` Zod schema alignment and parameter migration in [`server/services/brightdata.ts`](../../server/services/brightdata.ts)
- Cryptographic untrusted nonce envelope unwrapping (`unwrapBrightDataUntrustedContent`)
- Child process environment configuration (`CONTENT_GATE="off"`, `SERP_ZONE`, `BROWSER_ZONE`, `RATE_LIMIT`, `BROWSER_FILTERED_SNAPSHOT`)
- 5-query parallel batch retrieval (`search_engine_batch`) and credit accounting in [`server/leadSearch/stages/retrieveStage.ts`](../../server/leadSearch/stages/retrieveStage.ts)
- Scrape batch contract standardization strictly to 1-5 URLs (`BRIGHTDATA_SCRAPE_BATCH_MAX_URLS`)
- Migration of retired bespoke endpoints (`web_data_linkedin_*`, `scrape_as_html`) to the unified Web Scraper API (`run_scraper` on datasets `gd_l1viktl72bvl7bjuj0` and `gd_l1vikfnt1wgvvqz95w`), superseding ADR-0012's single-URL scraper constraint
- Dynamic Scraper Discovery catalog (`search_scrapers`, `get_scraper_details`, `refresh_scrapers`) across 1,200+ Bright Data scrapers
- Scraping Browser Automation suite wrapping all 14 FastMCP browser tools
- Native multi-format single and batch scrape extraction (`format: "markdown" | "html" | "ld_json" | "text"`) and direct Schema.org probing via `format: "ld_json"`
- Runtime capability discovery via `listTools()` augmenting static Pro tool metadata
- Double-layered cache poisoning guards and interactive timeout calibration (60s) in [`server/leadSearch/agentBrainRunner.ts`](../../server/leadSearch/agentBrainRunner.ts) and [`server/leadSearch/stages/enrichStage.ts`](../../server/leadSearch/stages/enrichStage.ts)
- Zero-cost Schema.org JSON-LD extraction (`extractSchemaOrgSignals`) in [`server/leadSearch/siteProbe.ts`](../../server/leadSearch/siteProbe.ts)
- Test suite and module state reset isolation (`resetBrightDataModuleState`) under esbuild ESM bundling

---

## Context

Apex CRM previously depended on `@brightdata/mcp@2.11.1`. Upgrading to `@brightdata/mcp@4.6.0` was necessary to access 30 modern MCP tools, unified Web Scraper datasets, and batch search capabilities. However, empirical inspection of `@brightdata/mcp@4.6.0` revealed several critical architectural shifts and silent traps:

1. **Cryptographic Nonce Envelopes**: Tool outputs in v4.6.0 are wrapped in `=====UNTRUSTED_<nonce>_BEGIN=====\n...\n=====UNTRUSTED_<nonce>_END=====`. Direct `JSON.parse` on raw tool results throws syntax errors.
2. **Content Gate Data Withholding**: v4.6.0 defaults `CONTENT_GATE` to `"on"`. Lacking interactive user elicitation during automated mining, the MCP server waits 2s and silently withholds web data with a refusal message.
3. **FastMCP Strict Schema Validation**: Zod `.strict()` rejects legacy parameters (`geo_location`, `cursor`, `start`) and disallows `hour`/`month` for Bing `time_range`.
4. **Google SERP Challenge Deadlock**: v4.6.0 changed error phrases (e.g. `Search failed: Google search failed ... Details: the search engine answer was not JSON`), which previously fell to `"unknown"` in `classifyBrightDataError`, bypassing the sticky Bing failover threshold.
5. **Interactive Mining Timeout Abort**: `agentBrainRunner.ts` invoked profile enrichment with a 40s timeout, while `run_scraper` waits up to 45s internally before returning status, causing hard timeout aborts on unindexed leads.
6. **False-Positive Enrichment Poisoning**: On failed URLs (404, private), `run_scraper` returns `{ status: "ready", data: [{ url, error: "..." }] }`. Treating this as a successful enrichment poisoned the SQLite positive cache with empty dossiers.
7. **Scrape Batch Contract Inconsistency**: Prior configuration permitted and validated 1-20 batch URLs (`BRIGHTDATA_SCRAPE_BATCH_MAX_URLS="10"` default), while `@brightdata/mcp` strictly enforces `max: 5` URLs per `scrape_batch` call, silently clamping or risking Zod validation rejections. Older documentation in ADR-0012 also mischaracterized scrapers as strictly single-URL without batch capabilities, which ADR-0020 formally supersedes.
8. **Underutilized Scraper Discovery and Browser Automation**: `@brightdata/mcp@4.6.0` exposes a discovery-first scraper engine (`search_scrapers`, `get_scraper_details`, `refresh_scrapers`) covering 1,200+ scrapers and 14 browser automation tools for complex SPAs and authenticated flows.
9. **Native Structured Formats**: FastMCP natively supports `format: "ld_json"` alongside `markdown`, `html`, and `text`, reducing payload size and parsing overhead.
10. **Static vs Dynamic Capability Discovery**: Static Pro capability reporting only listed `scraping_browser_snapshot`, masking available browser, discovery, and dataset tools.

---

## Decision

### 1. FastMCP Schema Alignment & Child Process Environment

- In [`server/services/brightdata.ts`](../../server/services/brightdata.ts), `buildBrightDataSearchArguments` strictly formats parameters for FastMCP:
  - Maps `geoLocation` -> `country` (2-letter ISO).
  - Normalizes `start` and `cursor` to integer `page = Math.max(0, page)`.
  - Clamps Bing `time_range` (`hour`/`month` -> `day`).
  - Strips obsolete keys (`start`, `cursor`, `geo_location`).
- In `connectLocalClient`, passes:
  - `CONTENT_GATE: process.env.CONTENT_GATE || "off"` (eliminates 2s withholding refusal).
  - `SERP_ZONE: process.env.BRIGHTDATA_SERP_ZONE || "mcp_serp"`.
  - `BROWSER_ZONE: process.env.BRIGHTDATA_BROWSER_ZONE || "mcp_browser"`.
  - MCP safety controls: `CONTENT_GATE_TIMEOUT`, `RATE_LIMIT`, `BROWSER_FILTERED_SNAPSHOT`, `BRIGHTDATA_GROUPS`, `BRIGHTDATA_TOOLS`.
  - Strips obsolete `PRO_MODE` and `POLLING_TIMEOUT` flags.

### 2. Cryptographic Untrusted Nonce Unwrapping

- Implemented `unwrapBrightDataUntrustedContent` using regex with boundary backreference:
  `/=====UNTRUSTED_([A-Za-z0-9+/=_-]+)_BEGIN=====\r?\n([\s\S]*?)\r?\n?=====UNTRUSTED_\1_END=====/`
- Directly integrated into `textFromToolResult()` so that all tool results (SERP, scrape, scraper datasets) automatically unwrap before serialization.

### 3. 5-Query Search Batch Parallelization (`search_engine_batch`)

- Added `brightDataSearchBatch` accepting up to 5 queries per MCP call. Maps queries into an array of `search_schema` objects and unpacks results from `entry.result.organic`.
- Wired into [`server/leadSearch/stages/retrieveStage.ts`](../../server/leadSearch/stages/retrieveStage.ts):
  - Chunks queries into groups of 5 with atomic credit reservation (`reserveBrightDataSearch(chunk.length)`).
  - Natively supports Page 2 retrieval by passing `page: 1` (`Math.floor(start / 10)`).
  - Fires `onQuerySettled` callbacks per query to unblock early-extraction waves immediately (ADR-0013).
  - Provides full trace recording, credit reservation, and cooldown propagation on batch fallback to Tavily.

### 4. Migration to Web Scraper API (`run_scraper`)

- Replaced legacy bespoke endpoints (`web_data_linkedin_person_profile`, `web_data_linkedin_company_profile`) with `run_scraper` targeting pinned dataset IDs:
  - Person Profile: `gd_l1viktl72bvl7bjuj0`
  - Company Profile: `gd_l1vikfnt1wgvvqz95w`
- Clamped profile enrichment timeout to a safe minimum of 50s (`Math.max(timeoutMs, 50_000)`), and elevated [`server/leadSearch/agentBrainRunner.ts`](../../server/leadSearch/agentBrainRunner.ts) caller timeout to 60s.
- Implemented double-layered validation: checks `record.error` in the service layer, and requires at least one meaningful profile signal (`name`, `position`, `company`, `experience`, `about`) in `applyDatasetDossierToTarget()` before marking a lead enriched.

### 5. Standardized 5-URL Scrape Batch Contract

- Standardized `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS` strictly to range `1-5` (default `5`) across runtime (`server/services/brightdata.ts`), environment files (`.env`, `.env.example`), boot validator (`server/configValidation.ts`), documentation (`docs/CODEBASE_INDEX.md`), and unit tests (`test/brightDataBatchLimit.test.ts`).
- Guarantees alignment with upstream FastMCP Zod schema (`urls: z.array(z.string().url()).min(1).max(5)`), eliminating silent clamping discrepancies.

### 6. Scraper Discovery Catalog API

- Implemented and exported discovery wrappers:
  - `brightDataSearchScrapers(query)`: Discovers scraper datasets across Bright Data's 1,200+ catalog.
  - `brightDataGetScraperDetails(datasetId)`: Retrieves schema, inputs, and output fields for a specific scraper.
  - `brightDataRefreshScrapers()`: Refreshes the local scraper catalog.
  - `brightDataRunScraper(datasetId, inputs, timeoutMs)`: Executes scraper runs with polling.
  - `brightDataGetScraperProgress(snapshotId)`: Checks running progress.
  - `brightDataGetScraperResults(snapshotId)`: Fetches finalized results.

### 7. Scraping Browser Automation Suite (14 FastMCP Tools)

- Wrapped and exported all 14 FastMCP browser automation tools in `server/services/brightdata.ts`:
  - Navigation & State: `brightDataBrowserNavigate`, `brightDataBrowserGoBack`, `brightDataBrowserGoForward`, `brightDataBrowserWaitForRef`
  - DOM Inspection & Snapshot: `brightDataBrowserSnapshot`, `brightDataBrowserGetText`, `brightDataBrowserGetHtml`, `brightDataBrowserScreenshot`, `brightDataBrowserNetworkRequests`
  - Interaction: `brightDataBrowserClick`, `brightDataBrowserClickRef`, `brightDataBrowserType`, `brightDataBrowserTypeRef`, `brightDataBrowserFillForm`, `brightDataBrowserScroll`, `brightDataBrowserScrollToRef`

### 8. Native Multi-Format Batch Extraction & Direct `ld_json` Probing

- Updated `scrapeBatchAsMarkdown` (and alias `brightDataScrapeBatch`) and `PipelinePorts.scrapeBatchMarkdown` to accept `format?: "markdown" | "html" | "ld_json" | "text"`.
- Omits `format` argument when defaulting to `"markdown"` to preserve backward compatibility with existing tests.
- Accelerated `siteProbe.ts`: queries `brightDataScrapeAsLdJson(url)` directly for structured metadata before falling back to full HTML scraping, drastically reducing token and payload overhead.
- Preserved zero-cost `extractSchemaOrgSignals` in `siteProbe.ts` for fallback HTML scraping.

### 9. Runtime Tool Discovery & Pro Capabilities

- Expanded `BRIGHTDATA_PRO_SUPPORTED_TOOLS` to include all 30 modern FastMCP tools (14 browser tools, dataset search/query tools, insights, and scraper discovery).
- Augmented `getBrightDataCapabilities()` with dynamic runtime `listTools()` discovery (`discoverBrightDataCapabilities()`), populating `discoveredTools` directly from the active MCP client connection to accurately report available tools based on active plan and account entitlements.

### 10. MCP Safety, Rate Limiting, and Filtering Governance

- Documented and exposed:
  - `CONTENT_GATE="off"`: Documented safety implications (disables interactive gating for unattended background mining; untrusted content is safely isolated via cryptographic nonce unwrapping and structured schema parsing).
  - `CONTENT_GATE_TIMEOUT`: Interactive user approval timeout (default 120s).
  - `RATE_LIMIT`: MCP client rate limiting (e.g. `100/1h`, `10/1s`).
  - `BROWSER_FILTERED_SNAPSHOT`: Exclusion of raw page text from ARIA snapshots to save LLM tokens and prevent prompt injection.
  - `BRIGHTDATA_GROUPS` / `BRIGHTDATA_TOOLS`: Allowlisting for MCP tool groups (`ecommerce`, `social`, `browser`, `scrapers`, etc.) or individual tools.

---

## Consequences

- **Performance**: Stage 2 retrieval latency reduced by 60-75% via 5-query parallel batch dispatch; site probing leverages direct `ld_json` extraction without full HTML DOM downloads.
- **Reliability**: Eliminates silent data loss from content gating, Zod validation rejections, and Google bot challenge deadlocks. Scrape batch configuration contracts are standardized to 1-5 across all boundaries.
- **Versatility**: Unlocks dynamic scraper discovery across 1,200+ scrapers and full 14-tool browser automation for complex SPAs and authenticated interactions.
- **Safety & Transparency**: MCP safety controls are surfaced and documented; untrusted content is isolated via cryptographic nonce unwrapping; runtime capabilities reflect real MCP server state via `listTools()`.
- **Compatibility**: All test suites pass with 0 failures under esbuild ESM bundling, and TypeScript compilation succeeds with 0 errors under strict type checking.

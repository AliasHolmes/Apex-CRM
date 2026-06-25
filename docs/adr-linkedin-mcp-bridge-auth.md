# ADR: LinkedIn MCP Session Auth — Bridge Path Pivot

**Date:** 2026-06-25  
**Status:** Accepted  
**Affected files:** `.apex-data/cookies.json`, `.apex-data/source-state.json`

---

## Context

Apex CRM uses `mcp-server-linkedin` (FastMCP / Patchright) to deep-enrich LinkedIn profiles during the `/api/find-leads` flow. The MCP server is spawned as a stdio child process by the Node.js backend (`server/services/mcp.ts`) and maintains a persistent Chromium session at `.apex-data/linkedin-profile/`.

The session broke: every `get_person_profile` call returned a local 15-second timeout with the message:

```
MCP deep enrichment failed: Local timeout: MCP server took too long (likely stuck on login wall)
```

---

## Problem Discovery

The MCP server's driver (`linkedin_mcp_server/drivers/browser.py`) has two authentication paths:

### Path A — Source Profile (what was being used)
When `current_runtime_id == source_state.source_runtime_id`, the driver opens the existing **Chromium persistent context** at `linkedin-profile/` and navigates to `linkedin.com/feed/` to verify the session. Authentication lives in `Default/Network/Cookies` — a **SQLite database** that Chromium writes to disk.

**The problem:** LinkedIn had invalidated the stored SQLite cookies. Every navigation hit the login/authwall, causing the 15-second timeout before the Node.js race timer killed the call.

### Path B — Bridge Path (the fix)
When `current_runtime_id != source_state.source_runtime_id`, the driver:
1. Starts a **fresh, empty** Chromium context
2. Navigates to `linkedin.com/feed/`
3. Calls `browser.import_cookies(cookie_path)` — injecting the portable cookie set from `.apex-data/cookies.json` into the live browser context via `context.add_cookies()`
4. Re-validates `/feed/` with the injected cookies
5. Proceeds if authenticated

The `cookies.json` file is **always writable by us**, whereas the Chromium SQLite DB requires a live login session to update.

---

## The Fix

### 1. Replace `.apex-data/cookies.json`

Translated the browser's cookie export (Chrome/Firefox extension JSON format) into **Playwright cookie format**:

| Browser export field | Playwright field | Notes |
|---|---|---|
| `expirationDate` | `expires` | Same float value |
| `sameSite: "no_restriction"` | `sameSite: "None"` | Playwright uses `"None"` |
| `domain: ".www.linkedin.com"` | `domain: ".linkedin.com"` | Normalized per MCP server's `_normalize_cookie_domain` |
| `session: true` | `expires: -1` | Session cookies get `-1` |

The `auth_minimal` preset (used by default in `import_cookies`) requires at minimum:
`li_at`, `JSESSIONID`, `bcookie`, `bscookie`, `lidc`

The most critical is **`li_at`** — LinkedIn's main authentication token.

### 2. Spoof `source_runtime_id` in `.apex-data/source-state.json`

```diff
- "source_runtime_id": "windows-amd64-host",
+ "source_runtime_id": "windows-amd64-host-prior-session",
```

This is a **permanent one-time change**. The current machine's runtime ID is always computed as `windows-amd64-host` (Windows + amd64 + not a container). By setting the stored `source_runtime_id` to a different value, the driver is permanently redirected to the bridge path on every startup — which is now the more reliable path for us.

---

## Verification

```
[test] OK: MCP server connected and initialized
[test] Calling get_person_profile(williamhgates)...
[test] SUCCESS - got 15241 chars of profile data
[test] Preview: {"url":"https://www.linkedin.com/in/williamhgates/", ...}
```

The smoke test (`test_mcp_session.py`) confirms full profile enrichment is working.

---

## Session Renewal Workflow

LinkedIn sessions expire periodically (every few weeks to months). When enrichment starts hitting auth wall timeouts again:

1. **Export cookies** from your logged-in browser (any cookie export extension, e.g. "Cookie-Editor" → Export as JSON)
2. **Translate and overwrite** `.apex-data/cookies.json` using the Playwright format above — or ask Antigravity to do it
3. **Do not touch** `source-state.json` — the `source_runtime_id` spoof is permanent

> [!IMPORTANT]
> `source-state.json` must keep `source_runtime_id` as anything **other than** `windows-amd64-host`. If it ever gets reset to `windows-amd64-host` (e.g. by running `mcp-server-linkedin --login`), the driver will revert to Path A and stop using the cookie bridge.

---

## Tradeoffs

| Concern | Notes |
|---|---|
| **Bridge path is slightly slower to start** | Adds ~5–10s on first call per server process; subsequent calls reuse the singleton browser |
| **No persistent Chromium session** | `experimental_persist_derived_runtime` env var can be set to `1` to derive and persist a runtime profile, but this is unnecessary given we can refresh cookies easily |
| **`--login` overwrites source-state.json** | If someone runs `mcp-server-linkedin --login` it will reset `source_runtime_id` to `windows-amd64-host` and break the bridge. Don't run `--login` — use the cookie export workflow above instead |
| **Cookie export required on expiry** | Manual step, but takes ~2 minutes |

---

## Files Changed

| File | Change |
|---|---|
| `.apex-data/cookies.json` | Fresh LinkedIn session cookies in Playwright format |
| `.apex-data/source-state.json` | `source_runtime_id` permanently set to non-matching value |
| `test_mcp_session.py` | Smoke test for MCP session validation |

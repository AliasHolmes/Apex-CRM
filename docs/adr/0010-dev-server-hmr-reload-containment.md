# 10. Dev-Server HMR Forced-Reload Containment

Date: 2026-10-09

## Status

Accepted

## Scope

This ADR covers the elimination of unprompted full-page reloads during active discovery sessions in development: [`server.ts`](../../server.ts), [`vite.config.ts`](../../vite.config.ts), [`src/App.tsx`](../../src/App.tsx), [`src/components/ScrapeWorkspace.tsx`](../../src/components/ScrapeWorkspace.tsx), and the regression guard [`test/hmrReloadGuard.test.ts`](../../test/hmrReloadGuard.test.ts).

---

## Context

Users reported the tab reloading by itself mid-mining-session, detaching the live trace from a still-running session. A full audit of the application sources found **zero** programmatic reloads (the only `location.reload()` is the user-clicked recovery button in `AppErrorBoundary`), so the reloads were browser-initiated by the Vite dev-server client.

Root cause (verified against the installed Vite 8.2.2 runtime and source):

1. **Vite HMR websocket auto-reload** ([`client.mjs:1001-1009`](../../node_modules/vite/dist/client/client.mjs)): on `vite:ws:disconnect` the client pings the HMR socket, and as soon as the ping succeeds it calls `location.reload()` **unconditionally**. The HMR websocket shares the Express HTTP listener (`server.ts` passed `ws: { server }, hmr: { server }`), so it can drop under mining load (4-way Atria concurrency, SSE telemetry floods, SQLite WAL commits). The ping succeeds immediately because the Express server is still alive.
2. **`full-reload` broadcast for non-graph files**: Vite's `handleHMRUpdate` sets `needFullReload = modules.length === 0`, so a change to any *watched* file that is not in the module graph broadcasts `full-reload` -> `location.reload()`. Any stray runtime-written file under a watched root (logs, temp files) therefore hard-reloads the page.
3. **The `DISABLE_HMR` escape hatch was inert**: `vite.config.ts` gated `server.watch` on `DISABLE_HMR`, but the inline `createViteServer({ server: { hmr: { server } } })` in `server.ts` *overrides* the config file - proven live: with `DISABLE_HMR=true`, `server.watch` became `null` while `server.hmr` stayed active, leaving the auto-reload channel armed.

Two candidate mitigations were evaluated and **rejected**:
- **Client-side `import.meta.hot.on('vite:beforeFullReload', () => false)`** guards: Vite's `notifyListeners` discards listener return values and both reload paths execute unconditionally, so client listeners cannot block either path. `location.reload` is unforgeable and cannot be monkey-patched.
- **Separate HMR websocket server**: does not help, because an event-loop stall under mining load starves every server in the process, not only the shared HTTP listener.

Evidence against the initially suspected causes: `node_modules/.vite/deps/_metadata.json` shows `discovered: {}` (no runtime dependency re-optimization has ever occurred - the `deps_temp_*` folders were debris from diagnostic `createServer` runs, timestamps confirmed), and a live chokidar test proved `**/.apex-data/**` correctly produces **zero** events for SQLite WAL/SHM writes on Windows.

---

## Decision

### 1. Make the kill switch real (`server.ts`)
`ws` and `hmr` are now both gated on `DISABLE_HMR`:
```ts
ws: hmrDisabled ? false : { server },
hmr: hmrDisabled ? false : { server },
```
With `DISABLE_HMR=true` there is no HMR websocket at all, so no reload channel exists. Default development behavior is unchanged.

### 2. Harden watcher ignores (`vite.config.ts`)
`watch.ignored` additionally covers `**/*.sqlite*`, `**/*.log`, `**/*.tmp`, `**/*.bak`, and `**/scratch/**` so runtime writes can never reach the non-graph `full-reload` path.

### 3. Instrument HMR socket lifecycle (`server.ts`)
`upgrade` events and socket closes on the shared listener are logged (`[Vite] HMR websocket upgrade/closed`), so any future drop is observable instead of surfacing as an unexplained reload.

### 4. Make any residual reload lossless (`App.tsx`, `ScrapeWorkspace.tsx`)
A forced reload cannot be fully excluded in default dev mode, so the app must recover from one:
- `ScrapeWorkspace` writes the running session id to `sessionStorage` (`apex-active-mining-session-id`) when a watcher attaches, and clears it on every terminal path (completion, failure, cancel, or when the mount effect finds no live session).
- `App.tsx` force-mounts the `workspace` job tab when that marker exists, so `ScrapeWorkspace`'s existing mount effect (`/api/mining-sessions/active` check + `attachActiveSessionWatcher`) re-attaches the live stream automatically.
- The set of mounted job tabs is persisted in `sessionStorage` (`apex-mounted-job-tabs`) so the tab lifecycle survives the reload, and a mount-only effect navigates the user back to the workspace when a session is running (deliberately not keyed on `activeTab`, so navigating away mid-session is never yanked back).

### 5. Regression guards (`test/hmrReloadGuard.test.ts`)
Source-assertion tests (repo convention) verify: the `hmr`/`ws` gating in `server.ts`, the upgrade instrumentation, the hardened ignore patterns, the rehydration wiring in both components, that every bare package import in `src/` is covered by `optimizeDeps.include` (preventing future runtime dep-optimization reloads), and that `deps/_metadata.json` never reports runtime-discovered deps.

---

## Consequences

- **Positive**: `DISABLE_HMR=true` now fully removes the reload channel - verified live that both `server.hmr` and `server.watch` are disabled.
- **Positive**: Runtime file writes (SQLite WAL/SHM, logs, temp files) cannot trigger `full-reload`.
- **Positive**: Even in default dev mode, a websocket drop that forces a reload is now invisible to the user: the workspace remounts and re-attaches to the running session, keeping the live trace continuous.
- **Positive**: Any future HMR drop is logged server-side with the upgrade path, turning an intermittent heisenbug into an observable event.
- **Negative / accepted**: HMR websocket drops under mining load remain possible in default dev mode (the socket shares the loaded HTTP listener); the recovery path, not drop prevention, is the containment strategy.
- **Operational note**: For long unattended mining sessions, prefer `npm run build && npm start` (no Vite in the request path at all).

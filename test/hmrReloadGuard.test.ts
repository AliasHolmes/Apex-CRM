/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards for ADR-0010 (dev-server HMR forced-reload containment). The Vite dev
// client calls location.reload() unconditionally on vite:ws:disconnect and on any
// full-reload broadcast, and the inline createViteServer config in server.ts wins
// over vite.config.ts - so an unconditional `hmr: { server }` silently re-arms the
// reload channel even when DISABLE_HMR=true. These assertions keep the containment
// (kill switch, watcher hardening, session rehydration) from regressing.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('server.ts gates the Vite HMR/WS channels on DISABLE_HMR so the escape hatch is real', () => {
  const server = read('server.ts');
  assert.match(
    server,
    /hmrDisabled\s*=\s*process\.env\.DISABLE_HMR\s*===\s*["']true["']/,
    'server.ts must derive a hmrDisabled flag from DISABLE_HMR',
  );
  assert.match(
    server,
    /ws:\s*hmrDisabled\s*\?\s*false\s*:\s*\{\s*server\s*\}/,
    'the shared HTTP server must not be handed to Vite WS when HMR is disabled',
  );
  assert.match(
    server,
    /hmr:\s*hmrDisabled\s*\?\s*false\s*:\s*\{\s*server\s*\}/,
    'the inline hmr option must be conditional - it overrides vite.config.ts',
  );
});

test('server.ts instruments HMR websocket upgrades/drops so forced reloads are observable', () => {
  const server = read('server.ts');
  assert.match(server, /server\.on\("upgrade"/, 'upgrade events on the shared listener must be logged');
  assert.match(server, /HMR websocket upgrade/);
  assert.match(server, /HMR websocket closed/);
});

test('vite.config.ts ignores runtime-generated files that would broadcast full-reload', () => {
  const config = read('vite.config.ts');
  for (const pattern of ['**/.apex-data/**', '**/*.sqlite*', '**/*.log', '**/*.tmp', '**/*.bak']) {
    assert.ok(
      config.includes(`'${pattern}'`),
      `watch.ignored is missing '${pattern}' - a runtime write of that file force-reloads the page`,
    );
  }
  assert.match(config, /ignored:\s*\[/);
});

test('App.tsx re-mounts the workspace and navigates back when a mining session is marked active', () => {
  const app = read('src/App.tsx');
  assert.ok(app.includes('apex-active-mining-session-id'), 'the active-session marker key must be referenced');
  assert.match(
    app,
    /hasActiveMiningSessionMarker\(\)\) return new Set<DashboardTab>\(\['workspace'\]\)/,
    'a running session must force-mount the workspace after a forced reload',
  );
  assert.match(app, /navigateToTab\('workspace'\)/, 'a running session must bring the user back to the workspace');
  assert.match(app, /MOUNTED_JOB_TABS_STORAGE_KEY/, 'mounted job tabs must survive a reload');
});

test('ScrapeWorkspace marks a live session in sessionStorage and clears it on teardown', () => {
  const workspace = read('src/components/ScrapeWorkspace.tsx');
  assert.ok(workspace.includes('apex-active-mining-session-id'), 'the marker key must be written/cleared here');
  assert.match(workspace, /rememberActiveSession\(sessionId\)/, 'attaching a watcher must mark the session');
  assert.match(workspace, /forgetActiveSession\(\)/, 'terminal states must clear the marker');
  const forgetCount = (workspace.match(/forgetActiveSession\(\)/g) ?? []).length;
  assert.ok(forgetCount >= 4, `expected teardown cover points, found ${forgetCount}`);
});

test('every bare package imported by src is pre-bundled (no runtime dep-optimization full-reloads)', () => {
  const config = read('vite.config.ts');
  const includeStart = config.indexOf('include: [');
  assert.ok(includeStart >= 0, 'optimizeDeps.include block not found');
  const includeBlock = config.slice(includeStart, config.indexOf(']', includeStart));
  const included = new Set([...includeBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(path.join(repoRoot, 'src'));

  const modules = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const mod = (match[1] ?? match[2] ?? '').trim();
      if (!mod || mod.startsWith('.') || mod.startsWith('@/') || mod.startsWith('/') || mod.startsWith('node:')) {
        continue;
      }
      modules.add(mod);
    }
  }

  // A module is covered when it (or its package root / scoped scope+name) is
  // pre-bundled: "motion/react" is covered by the 'motion' root or the exact
  // 'motion/react' subpath entry in optimizeDeps.include.
  const isCovered = (mod: string) => {
    const candidates = new Set<string>([mod]);
    const segments = mod.split('/');
    if (mod.startsWith('@') && segments.length > 2) candidates.add(`${segments[0]}/${segments[1]}`);
    else if (!mod.startsWith('@') && segments.length > 1) candidates.add(segments[0]!);
    return [...candidates].some((c) => included.has(c) || optimizedKeys.has(c));
  };

  const metaPath = path.join(repoRoot, 'node_modules/.vite/deps/_metadata.json');
  const optimizedKeys = new Set<string>();
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    for (const key of Object.keys(meta.optimized ?? {})) optimizedKeys.add(key);
    const discovered = Object.keys(meta.discovered ?? {});
    assert.deepEqual(
      discovered,
      [],
      'deps discovered at runtime mean a full-reload is possible on a fresh clone - move them into optimizeDeps.include',
    );
  }

  const uncovered = [...modules].filter((mod) => !isCovered(mod));
  assert.deepEqual(uncovered, [], 'bare imports missing from optimizeDeps.include (runtime optimization triggers full-reload)');
});

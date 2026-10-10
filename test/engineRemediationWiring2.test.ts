import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Wiring guards for ADR-0013 (post-ADR-0011/0012 remediation). Behavioral units are
// covered by liveRollingPool / planCache / engineBottleneckRemediation /
// knowledgeGraphPrune tests; this file pins the integration points.

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

test('extraction concurrency can fill the full Atria slot count', () => {
  const engine = read('server/leadSearch/discoveryEngine.ts');
  assert.match(
    engine,
    /extractionConcurrency: Math\.max\(\s*Math\.min\(\s*Math\.max\(Number\(process\.env\.LEAD_EXTRACTION_CONCURRENCY \|\| 1\), 1\),\s*8,\s*\),\s*1,\s*\)/,
    'the engine-level extraction ceiling must be 8, not 6',
  );
  const extract = read('server/leadSearch/stages/extractStage.ts');
  assert.match(
    extract,
    /const extractionConcurrency = Math\.max\(\s*Math\.min\(/,
    'the stage-level extraction ceiling must allow 8',
  );
  assert.ok(
    !/Math\.min\([\s\S]{0,200}6,\s*\)/.test(extract),
    'no hardcoded 6 ceiling may remain in the extraction stage',
  );
  assert.ok(
    !/routingTier: "fast"/.test(extract),
    'the dead fast-tier param must not be passed by extraction (routing stays on Atria per ADR-0011)',
  );
});

test('streaming judge submissions are coalesced into micro-batches', () => {
  const engine = read('server/leadSearch/discoveryEngine.ts');
  assert.match(engine, /readyBatchTarget/, 'a readiness batch target must exist');
  assert.match(engine, /readyFlushMs/, 'a readiness flush debounce must exist');
  assert.match(engine, /const pendingReadyGroup: FinalistCandidate\[\] = \[\]/);
  assert.match(engine, /if \(group\.length > 0\) queueReadyCandidates\(group\)/);
  assert.match(engine, /flushReadyGroup\(\);\s*\n\s*\n\s*const drainStartedAt/, 'the buffer must flush before drain');
  assert.match(engine, /concurrency: 2,/, 'two judge groups may run at once');
  assert.match(
    engine,
    /LEAD_STREAMING_JUDGE_BATCH_TARGET \|\| 3/,
    'the coalescing target defaults to a micro-batch of 3',
  );
});

test('post-intent LLM batches run through the provider queue', () => {
  const postIntent = read('server/leadSearch/linkedinPostIntent.ts');
  assert.match(postIntent, /Phase B: Batched LLM classification/);
  assert.match(postIntent, /await runProviderQueue\(/);
  assert.match(
    postIntent,
    /LINKEDIN_POST_INTENT_CONCURRENCY \|\| 3/,
    'batch concurrency must honor the env knob',
  );
  assert.ok(
    !/for \(let i = 0; i < pendingLlm\.length; i \+= BATCH_SIZE\) \{[\s\S]{0,400}await classifyLinkedInPostIntentBatch/.test(postIntent),
    'the serial per-batch await loop must be gone',
  );
});

test('retrieval streams settled queries into early extraction waves', () => {
  const retrieve = read('server/leadSearch/stages/retrieveStage.ts');
  assert.match(retrieve, /onQuerySettled\?: \(batch: \{/);
  assert.match(retrieve, /await onQuerySettled\?\.\(\{/, 'the hook must fire per settled query');
  const engine = read('server/leadSearch/discoveryEngine.ts');
  assert.match(engine, /const streamingExtractionEnabled =[\s\S]{0,80}LEAD_STREAMING_EXTRACTION !== "false"/);
  assert.match(engine, /earlyExtractPool = createLiveRollingPool<any\[\], void>/);
  assert.match(
    engine,
    /const itemsForFinalExtraction = candidateItems\.filter\(/,
    'the final pass must skip early-extracted items',
  );
  assert.match(
    engine,
    /const provisionalLeads = \[\.\.\.earlyProfiles, \.\.\.extractResult\.extractedProfiles\]/,
    'early-wave profiles must reach verification',
  );
});

test('pruners cover the knowledge-graph tables and stale session errors', () => {
  const db = read('server/db.ts');
  assert.match(db, /export function pruneExpiredKnowledgeGraph/);
  assert.match(db, /DELETE FROM candidate_verdicts WHERE expires_at <= \?/);
  assert.match(db, /DELETE FROM company_profiles WHERE expires_at <= \?/);
  assert.match(db, /DELETE FROM company_attribution_verdicts WHERE expires_at <= \?/);
  assert.match(db, /export function clearStaleSessionErrorMessages/);
  const server = read('server.ts');
  assert.match(server, /pruneExpiredKnowledgeGraph\(\)/, 'the maintenance timer must run the pruner');
  assert.match(server, /clearStaleSessionErrorMessages\(\),?/, 'startup must run the stale-message cleanup');
  const engine = read('server/leadSearch/discoveryEngine.ts');
  assert.match(
    engine,
    /const expiredGraphRows = pruneExpiredKnowledgeGraph\(\)/,
    'session start must prune the knowledge graph',
  );
});

test('terminal-success persistence clears stale error messages', () => {
  const persist = read('server/leadSearch/stages/persistStage.ts');
  assert.match(
    persist,
    /derivedStatus === "success" \|\| derivedStatus === "partial_success"\s*\?\s*null/,
    'a terminal success must write errorMessage: null',
  );
});

test('session log buffer is bounded on every write path', () => {
  const engine = read('server/leadSearch/discoveryEngine.ts');
  const addLogBlock = /addLog\(sessionId: string, message: string\): void \{[\s\S]*?\n  \}/.exec(engine);
  assert.ok(addLogBlock, 'addLog must exist');
  assert.match(
    addLogBlock![0],
    /if \(logs\.length > 1500\) \{[\s\S]*?splice\(0, logs\.length - 1500\)/,
    'the public addLog path must trim like the internal logEvent path',
  );
});

test('lead hydration transfers deltas instead of the full table', () => {
  const api = read('server/routes/api.ts');
  assert.match(api, /updatedSince,/, 'the route must parse updatedSince');
  assert.match(
    api,
    /SELECT payload FROM leads WHERE updated_at > \?/,
    'the delta path must filter server-side',
  );
  assert.match(api, /latestUpdatedAt/, 'responses must carry the high-water mark');
  const ctx = read('src/context/LeadContext.tsx');
  assert.match(ctx, /hydratedLeadsById/);
  assert.match(ctx, /api\/leads\?updatedSince=/, 'the client must request deltas after first hydration');
  assert.match(ctx, /data\.delta === true && hydratedLeadsById/, 'delta responses must merge');
  assert.match(
    ctx,
    /hydratedLeadsById\.size \+ sanitized\.length < serverTotal/,
    'a row-count mismatch must fall back to a full refetch',
  );
});

test('per-lead derived values are cached across hydrations', () => {
  const table = read('src/components/LeadTable.tsx');
  assert.match(table, /derivedLeadCache/);
  assert.match(table, /getDerivedLeadValues\(lead\)\.searchText/);
  assert.match(table, /getDerivedLeadValues\(lead\)\.dedupeKeys/);
});

test('SSE frames carry the session row only when it changes', () => {
  const hub = read('server/services/sessionStreamHub.ts');
  assert.match(hub, /lastEmittedSessionUpdatedAt/);
  assert.match(
    hub,
    /const sessionChanged =\s*Boolean\(session\) &&\s*\(isTerminal \|\|/,
    'the session must be embedded only on change or terminal frames',
  );
  const workspace = read('src/components/ScrapeWorkspace.tsx');
  assert.match(workspace, /miningTraceStore\.isStreamConnected\(sessionId\)/);
  assert.match(workspace, /if \(streamHealthy && watcherTick % 3 !== 0\) return;/, 'the poll must fall back to 1-in-3 cadence');
  assert.match(workspace, /document\.hidden\) return;/, 'the watcher must pause in hidden tabs');
  const traceStore = read('src/lib/traceStore.ts');
  assert.match(traceStore, /isStreamConnected\(sessionId: string\): boolean/);
  const banner = read('src/components/ResumableSessionsBanner.tsx');
  assert.match(banner, /visibilitychange/, 'the resumable banner must gate polling on visibility');
});

test('lead rows use browser-level virtualization and the entry chunk dropped the motion engine', () => {
  const table = read('src/components/LeadTable.tsx');
  assert.match(
    table,
    /contentVisibility: 'auto',\s*containIntrinsicSize: 'auto 56px'/,
    'table rows must skip off-screen subtree rendering',
  );
  const app = read('src/App.tsx');
  assert.ok(!/from 'motion\/react'/.test(app), 'the motion engine must not be in the entry chunk');
  assert.match(app, /apex-tab-enter/, 'tab sections must use the CSS fade');
  const css = read('src/index.css');
  assert.match(css, /@keyframes apex-tab-enter/);
  const html = read('index.html');
  assert.match(html, /media="print"/, 'the webfont stylesheet must be non-blocking');
  assert.match(html, /<noscript>/, 'a noscript font fallback must exist');
});

test('session history reads light columns only', () => {
  const db = read('server/db.ts');
  assert.match(db, /export function readSearchLogDigests/);
  assert.ok(
    !/SELECT id, timestamp, prompt, generated_queries, status, error_message, raw_results_count, leads_found, provider_summary/.test(
      /export function readSearchLogs[\s\S]*?export function readSearchLogDigests/.exec(db)?.[0] || '',
    ),
    'readSearchLogs must remain for the detail view',
  );
  const api = read('server/routes/api.ts');
  assert.match(api, /readSearchLogDigests\(parsedLimit\)/, 'the history route must use the digest query');
  const digestQuery = /export function readSearchLogDigests[\s\S]*?FROM search_logs[^`]*?`/.exec(db)?.[0] || '';
  assert.ok(!/detailed_logs/.test(digestQuery), 'the digest query must not read detailed_logs');
  assert.ok(!/debug_logs/.test(digestQuery), 'the digest query must not read debug_logs');
  assert.ok(!/trace_events/.test(digestQuery), 'the digest query must not read trace_events');
});

test('tavily search concurrency and env knobs match the plan', () => {
  const env = read('.env');
  assert.match(env, /TAVILY_SEARCH_CONCURRENCY="4"/);
  assert.match(env, /BRIGHTDATA_PROFILE_CONCURRENCY="3"/);
  assert.match(env, /BRIGHTDATA_SEARCH_CONCURRENCY="4"/);
});

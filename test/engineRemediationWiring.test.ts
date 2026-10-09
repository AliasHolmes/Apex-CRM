import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Wiring guards for ADR-0012 (engine bottleneck remediation). The behavioral units are
// covered by liveRollingPool/planCache/engineBottleneckRemediation tests; this file pins
// the integration points so a refactor cannot silently detach them.

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

test('streaming judge seam wires enrichment completion into the live judge pool', () => {
  const engine = read('server/leadSearch/discoveryEngine.ts');
  assert.match(engine, /createLiveRollingPool/, 'the live pool must be constructed');
  assert.match(
    engine,
    /\.\.\.\(streamingJudgeEnabled \? \{ onTargetsReady \} : \{\}\)/,
    'enrichStage must receive the readiness callback when streaming is enabled',
  );
  assert.match(engine, /await judgePool\.drain\(\)/, 'the pool must be drained after enrichment');
  assert.match(
    engine,
    /survivedEnrichment\(qCand\)/,
    'drain-time admission must re-check enrichment acceptance',
  );
  assert.match(
    engine,
    /LEAD_PIPELINE_STREAMING_JUDGE !== "false"/,
    'the streaming seam must be feature-flag gated',
  );

  const enrich = read('server/leadSearch/stages/enrichStage.ts');
  assert.match(enrich, /onTargetsReady\?: \(leads: any\[\]\) => void/, 'the hook must exist on the input type');
  const hookFires = (enrich.match(/onTargetsReady\(/g) ?? []).length;
  assert.ok(hookFires >= 6, `expected the hook to fire at each enrichment completion point, found ${hookFires}`);
  assert.match(
    enrich,
    /const enrichConcurrency = Math\.max\(1, profileConcurrency \|\| 3\)/,
    'the pro waterfall must use the configured profile concurrency',
  );
});

test('judge concurrency adapts to free Atria slots within the hard ceiling', () => {
  const judge = read('server/leadSearch/stages/judgeStage.ts');
  assert.match(judge, /getProviderConcurrencyLimit\("atria"\)/);
  assert.match(judge, /getProviderActiveSlots\("atria"\)/);
  assert.match(
    judge,
    /Math\.min\(8, Math\.max\(configuredJudgeConcurrency, freeAtriaSlots\)\)/,
    'adaptive concurrency must stay bounded by 8',
  );
  assert.match(
    judge,
    /firstWaveBatchSize =\s*explicitBatchSize > 0 \? maxBatchCandidates : Math\.min\(3, batchCapacityCap\)/,
    'the first judge wave must use batch-3 unless explicitly configured',
  );
});

test('retrieval falls back to the market-slice signature cache key', () => {
  const retrieve = read('server/leadSearch/stages/retrieveStage.ts');
  assert.match(retrieve, /buildRetrievalSignatureKey/);
  assert.match(retrieve, /signatureCacheHit/);
  assert.match(
    retrieve,
    /if \(signatureKey !== cacheKey\) writeCachedSearch\(signatureKey, res\)/,
    'results must be published under the signature key too',
  );
  const cache = read('server/leadSearch/retrievalCache.ts');
  assert.match(cache, /retrieval-sig:\$\{provider\}/);
});

test('round plan cache gates on round/spec/recovery state', () => {
  const plan = read('server/leadSearch/stages/planStage.ts');
  assert.match(plan, /readPlanCache\(planCacheKey\)/);
  assert.match(plan, /writePlanCache\(planCacheKey, planItems\)/);
  assert.match(
    plan,
    /planCacheEnabled &&\s*!input\.isSpeculative &&\s*!isRecoveryMode &&\s*round > 1 &&\s*stallDirective\.effectiveLevel === 0/,
    'cache use must be restricted to non-speculative, non-recovery, post-first rounds',
  );
});

test('planning-family calls opt into the fast tier and the .env knobs match the plan', () => {
  for (const rel of [
    'server/leadSearch/intentSignals.ts',
    'server/leadSearch/linkedinPostIntent.ts',
  ]) {
    assert.match(read(rel), /tierProviderOrder: resolvePlannerProviderOrder\(\)/, `${rel} must route on the fast tier`);
  }

  const env = read('.env');
  assert.match(env, /BRIGHTDATA_PROFILE_CONCURRENCY="3"/);
  assert.match(env, /BRIGHTDATA_SEARCH_CONCURRENCY="4"/);
  assert.match(env, /FINALIST_JUDGE_MAX_EVIDENCE_ITEMS="6"/);
  assert.match(env, /FINALIST_JUDGE_EVIDENCE_CHARS="1800"/);
});

test('site probe recovers thin roots with the wider subpath set', () => {
  const probe = read('server/leadSearch/siteProbe.ts');
  assert.match(probe, /\/services/);
  assert.match(probe, /\/careers/);
  assert.match(
    probe,
    /verifiedDomain[\s\S]*?\/about/,
    'missing roots on verified domains must still probe /about',
  );
});

test('saturation response injects account queries and tightens the metro threshold', () => {
  const plan = read('server/leadSearch/stages/planStage.ts');
  assert.match(plan, /crmDuplicateShare/);
  assert.match(plan, /crmSaturationDominates = crmDuplicateShare >= 0\.5 && !isSingleMetroBrief/);
  assert.match(plan, /saturationThreshold = crmSaturationDominates \? 10 : 20/);
  assert.match(plan, /buildAccountFlywheelItems\(signalCompanies, searchSpec, maxTasks\)/);
  assert.match(plan, /CRM SATURATION DIRECTIVE/);
});

test('queue wait is persisted through the v27 column', () => {
  const db = read('server/db.ts');
  assert.match(db, /LATEST_SCHEMA_VERSION = 27/);
  assert.match(db, /"queue_wait_ms",\s*"queue_wait_ms INTEGER NOT NULL DEFAULT 0"/);
  assert.match(db, /queue_wait_ms INTEGER NOT NULL DEFAULT 0,\s*model_name TEXT,/, 'fresh DBs must create the column');

  const telemetry = read('server/leadSearch/telemetry.ts');
  assert.match(telemetry, /queueWaitMs\?: number/, 'the log entry type must carry queue wait');
  assert.match(telemetry, /attempts\.reduce\(\(sum, a\) => sum \+ \(Number\(a\?\.queueWaitMs\) \|\| 0\), 0\)/);
});

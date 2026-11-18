import test from "node:test";
import assert from "node:assert/strict";
import { getLeadsDb, insertLlmStageLog, readLlmStageLogs } from "../server/db.js";

test("Schema v30 migration adds cost_usd, reasoning_tokens, cached_tokens, prompt_version to llm_stage_logs", () => {
  const db = getLeadsDb();
  
  // Verify columns exist via table_info
  const columns = db.prepare("PRAGMA table_info(llm_stage_logs)").all() as Array<{ name: string; type: string }>;
  const colNames = new Set(columns.map((c) => c.name));

  assert.ok(colNames.has("cost_usd"), "cost_usd column must exist");
  assert.ok(colNames.has("reasoning_tokens"), "reasoning_tokens column must exist");
  assert.ok(colNames.has("cached_tokens"), "cached_tokens column must exist");
  assert.ok(colNames.has("prompt_version"), "prompt_version column must exist");

  // Insert test stage log with new fields
  const testSessionId = `test-schema30-${Date.now()}`;
  insertLlmStageLog({
    searchLogId: testSessionId,
    stage: "company_attribution",
    round: 1,
    status: "success",
    inputTokens: 1500,
    outputTokens: 450,
    latencyMs: 820,
    queueWaitMs: 45,
    costUsd: 0.00185,
    reasoningTokens: 120,
    cachedTokens: 800,
    promptVersion: "v1.0.0",
    modelName: "gpt-4o-mini",
    provider: "byesu",
  });

  const logs = readLlmStageLogs(testSessionId);
  assert.equal(logs.length, 1, "Should retrieve inserted log entry");
  const entry = logs[0];
  assert.equal(entry.costUsd, 0.00185);
  assert.equal(entry.reasoningTokens, 120);
  assert.equal(entry.cachedTokens, 800);
  assert.equal(entry.promptVersion, "v1.0.0");
  assert.equal(entry.modelName, "gpt-4o-mini");
  assert.equal(entry.provider, "byesu");

  // Clean up test rows
  db.prepare("DELETE FROM llm_stage_logs WHERE search_log_id = ?").run(testSessionId);
});

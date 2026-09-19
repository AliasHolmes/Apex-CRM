import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-llm-floor-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import { fitOutputTokenBudget } from "../server/leadSearch/llmBudget.js";

test("Stream 4 - LLM Budget Floor Guard", async (t) => {
  await t.test("throws error when available output tokens < 200", () => {
    assert.throws(
      () => {
        fitOutputTokenBudget({
          configuredMaxTokens: 2000,
          estimatedInputTokens: 7900,
          totalTokenBudget: 8192,
          safetyTokens: 200,
          minimumOutputTokens: 800,
        });
      },
      (err: any) => {
        assert.match(err.message, /below minimum viable output threshold \(200\)/);
        return true;
      },
    );
  });

  await t.test("returns at least 200 tokens when budget is tight but viable (>= 200)", () => {
    // totalBudget 8192, input 7500, safety 200 -> available 492
    const tokens = fitOutputTokenBudget({
      configuredMaxTokens: 2000,
      estimatedInputTokens: 7500,
      totalTokenBudget: 8192,
      safetyTokens: 200,
      minimumOutputTokens: 800,
    });
    assert.ok(tokens >= 200);
    assert.equal(tokens, 492);
  });

  await t.test("respects configuredMaxTokens and available when abundant", () => {
    const tokens = fitOutputTokenBudget({
      configuredMaxTokens: 1500,
      estimatedInputTokens: 2000,
      totalTokenBudget: 8192,
      safetyTokens: 400,
      minimumOutputTokens: 800,
    });
    assert.equal(tokens, 1500);
  });
});

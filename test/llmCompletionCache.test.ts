import { test } from "node:test";
import assert from "node:assert/strict";
import { getLlmCacheEntry, upsertLlmCacheEntry, purgeLlmCacheExpired } from "../server/db.js";

test("LLM completion cache saves, retrieves, and purges expired entries", () => {
  const testHash = "test_prompt_hash_" + Date.now();
  const testResponse = JSON.stringify({ leads: [{ fullName: "Test Lead" }] });

  // Initially empty
  assert.equal(getLlmCacheEntry(testHash), null);

  // Upsert entry with 24h TTL
  upsertLlmCacheEntry(testHash, "test_provider", "test_model", testResponse, { prompt_tokens: 100 }, 24);

  // Read back
  const cached = getLlmCacheEntry(testHash);
  assert.ok(cached);
  assert.equal(cached.response, testResponse);
  assert.equal(cached.usage?.prompt_tokens, 100);

  // Entry with expired time (negative TTL)
  const expiredHash = "expired_hash_" + Date.now();
  upsertLlmCacheEntry(expiredHash, "test_provider", "test_model", testResponse, undefined, -1);

  // getLlmCacheEntry should not return expired entry
  assert.equal(getLlmCacheEntry(expiredHash), null);

  // purgeLlmCacheExpired cleans expired rows
  const purgedCount = purgeLlmCacheExpired();
  assert.ok(purgedCount >= 1);
});

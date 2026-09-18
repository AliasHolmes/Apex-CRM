import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCleanEvidence } from "../server/leadSearch/stages/extractStage.js";

test("buildCleanEvidence preserves up to 1800 chars for upgraded items", () => {
  const longText = "A".repeat(1500);
  const upgradedItem = {
    url: "https://example.com/alice",
    title: "Alice Smith",
    content: longText,
    sourceProvider: "brightdata_search",
    _evidenceUpgraded: true,
  };

  const evidence = buildCleanEvidence(upgradedItem);
  assert.ok(evidence.includes("LINK: https://example.com/alice"));
  assert.ok(evidence.includes("[BRIGHTDATA SNIPPET]"));
  assert.ok(!evidence.includes("[TAVILY SNIPPET]"));
  // Must NOT be truncated to 500
  assert.ok(evidence.length > 1400);
  assert.ok(evidence.includes("A".repeat(1500)));
});

test("buildCleanEvidence caps non-upgraded items at 500 chars with default [TAVILY SNIPPET]", () => {
  const longText = "B".repeat(1500);
  const regularItem = {
    url: "https://example.com/bob",
    title: "Bob Jones",
    content: longText,
    sourceProvider: "tavily",
    _evidenceUpgraded: false,
  };

  const evidence = buildCleanEvidence(regularItem);
  assert.ok(evidence.includes("LINK: https://example.com/bob"));
  assert.ok(evidence.includes("[TAVILY SNIPPET]"));
  assert.ok(!evidence.includes("[BRIGHTDATA SNIPPET]"));
  // Must be capped at 500
  assert.ok(evidence.includes("B".repeat(500) + "..."));
  assert.ok(!evidence.includes("B".repeat(501)));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { executeFuseStage } from "../server/leadSearch/stages/fuseStage.js";

test("fuseStage maps brightdata_dataset to provider brightdata and preserves sourceProvider", async () => {
  const roundPlans = [
    {
      executableQuery: "AI agency founders",
      item: { priority: 1, family: "person", lane: "person" },
    },
  ];

  const roundItems = [
    {
      resultIndex: 0,
      item: {
        title: "Carol Danvers - Founder",
        url: "https://www.linkedin.com/in/caroldanvers",
        content: "Founder of Marvel AI agency",
        sourceProvider: "brightdata_dataset",
        _resultIndex: 0,
        _sourceRound: 1,
      },
    },
  ];

  const ctx: any = {
    config: {
      sessionId: "test-session-123",
      promptQuery: "AI agency founders",
    },
    state: {
      stats: { scout: {} },
      seenCandidateKeys: new Set(),
      existingKeys: new Set(),
    },
    logEvent: () => {},
    recordTrace: () => {},
  };

  const input: any = {
    round: 1,
    roundPlans,
    roundItems,
    queryRuns: [{ rawCandidates: 0 }],
    planByQuery: new Map(),
    queryRunByQuery: new Map(),
    stats: { rawCandidates: 0, rejectionReasons: {} },
  };

  const result = await executeFuseStage(ctx, input);
  assert.ok(result);
  assert.ok(result.candidateItems.length > 0);
  const fusedItem = result.candidateItems[0];
  assert.equal(fusedItem.sourceProvider, "brightdata_dataset");
  assert.ok(
    Array.isArray(fusedItem._sourceProviders) &&
      fusedItem._sourceProviders.includes("brightdata"),
    "Expected _sourceProviders to include brightdata",
  );
});

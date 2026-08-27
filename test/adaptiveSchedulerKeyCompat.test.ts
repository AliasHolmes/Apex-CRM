import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveScopeKey, scheduleAdaptiveRetrievalTasks } from "../server/leadSearch/adaptiveScheduler.js";
import type { RetrievalTask } from "../server/leadSearch/searchSpec.js";

test("adaptiveScopeKey format matches historicalPerformance row key format", () => {
  const task: Pick<RetrievalTask, "family" | "lane" | "providerPreference"> = {
    family: "persona_title",
    lane: "person",
    providerPreference: "tavily",
  };

  const expectedKey = "persona_title|person|tavily";
  assert.equal(adaptiveScopeKey(task), expectedKey);

  const row = {
    family: "persona_title",
    lane: "person",
    provider: "tavily",
    outcome_runs: 5,
    qualified_candidates: 4,
  };

  const rowKey = [
    row.family || "general",
    row.lane || "person",
    row.provider || "tavily",
  ]
    .join("|")
    .toLowerCase();
  assert.equal(rowKey, expectedKey);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseObservations, type ScoutObservation } from "../server/leadSearch/observations.js";

test("fuseObservations prioritizes brightdata_dataset even when raw snippet is longer", () => {
  const shortDatasetObs: ScoutObservation = {
    round: 1,
    provider: "brightdata",
    query: "site:linkedin.com/in/ test",
    title: "Alice Smith - Founder & CEO",
    url: "https://www.linkedin.com/in/alicesmith",
    content: JSON.stringify({ name: "Alice Smith", position: "Founder & CEO", current_company_name: "Acme AI" }),
    raw: {
      name: "Alice Smith",
      position: "Founder & CEO",
      current_company_name: "Acme AI",
      sourceProvider: "brightdata_dataset",
    },
  };

  const longTavilySnippetObs: ScoutObservation = {
    round: 1,
    provider: "tavily",
    query: "site:linkedin.com/in/ alicesmith",
    title: "Alice Smith | LinkedIn",
    url: "https://www.linkedin.com/in/alicesmith",
    content: "A very long multi-paragraph description of Alice Smith's career with hundreds of extra characters that previously would have won the content-length comparison and overwritten the structured dataset result.",
    raw: {
      snippet: "A very long multi-paragraph description...",
    },
  };

  // Case 1: Tavily arrived first, then Bright Data dataset arrived
  const fused1 = fuseObservations([longTavilySnippetObs, shortDatasetObs]);
  assert.equal(fused1.length, 1);
  assert.equal(fused1[0].raw?.sourceProvider, "brightdata_dataset");
  assert.ok(fused1[0].content.includes("Acme AI"));

  // Case 2: Bright Data dataset arrived first, then Tavily snippet arrived
  const fused2 = fuseObservations([shortDatasetObs, longTavilySnippetObs]);
  assert.equal(fused2.length, 1);
  assert.equal(fused2[0].raw?.sourceProvider, "brightdata_dataset");
  assert.ok(fused2[0].content.includes("Acme AI"));
});

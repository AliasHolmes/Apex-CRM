import test from "node:test";
import assert from "node:assert/strict";
import { selectDiversifiedLeads } from "../server/leadSearch/scoutScoring.js";

test("selectDiversifiedLeads backfills remaining slots up to requested limit", () => {
  const candidates = [
    {
      id: "1",
      fullName: "Alice",
      currentCompany: "Acme Corp",
      finalSelectionScore: 9,
    },
    {
      id: "2",
      fullName: "Bob",
      currentCompany: "Acme Corp",
      finalSelectionScore: 8.5,
    },
    {
      id: "3",
      fullName: "Charlie",
      currentCompany: "Acme Corp",
      finalSelectionScore: 8,
    },
    {
      id: "4",
      fullName: "David",
      currentCompany: "Acme Corp",
      finalSelectionScore: 7.5,
    },
    {
      id: "5",
      fullName: "Eve",
      currentCompany: "Beta LLC",
      finalSelectionScore: 7,
    },
  ];

  // Request 4 leads with maxPerCompany = 2
  const selected = selectDiversifiedLeads(candidates, 4, 2);
  assert.equal(
    selected.length,
    4,
    "Must return exactly 4 leads (shortfall backfilled)",
  );
  assert.equal(selected[0].fullName, "Alice");
});

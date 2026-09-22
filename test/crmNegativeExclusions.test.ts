import { test } from "node:test";
import assert from "node:assert/strict";
import { extractValidCompanyDomain, upsertLeadWithIdentity, readStoredMetroSaturation, deleteLead } from "../server/db.js";
import { buildStrategistPrompt } from "../server/leadSearch/searchSpec.js";

test("G13: readStoredMetroSaturation counts profile.location engine leads", () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const id = `g13-test-lead-${Date.now()}-${i}`;
      ids.push(id);
      upsertLeadWithIdentity({ id, profile: { location: "London" }, fullName: `G13 Test ${i}` } as any);
    }
    assert.ok((readStoredMetroSaturation()["london"] || 0) >= 2);
  } finally {
    for (const id of ids) { try { deleteLead(id); } catch {} }
  }
});

test("CRM Negative Exclusions: extracts and normalizes valid company domains", () => {
  assert.equal(extractValidCompanyDomain("https://www.cognition-ai.co.uk/services"), "cognition-ai.co.uk");
  assert.equal(extractValidCompanyDomain("https://applied-ml.com"), "applied-ml.com");
  assert.equal(extractValidCompanyDomain("bespoke-ai.io"), "bespoke-ai.io");

  // Rejects public social and email domains
  assert.equal(extractValidCompanyDomain("https://www.linkedin.com/company/test"), null);
  assert.equal(extractValidCompanyDomain("https://twitter.com/ai_agency"), null);
  assert.equal(extractValidCompanyDomain("gmail.com"), null);
  assert.equal(extractValidCompanyDomain("notadomain"), null);
  assert.equal(extractValidCompanyDomain(""), null);
});

test("CRM Negative Exclusions: strategist prompt warns against CRM-saturated metros", () => {
  const prompt = buildStrategistPrompt({
    query: "UK AI agency owners",
    round: 1,
    maxRounds: 4,
    remaining: 20,
    previousQueries: [],
    previousRoundSummary: {},
    knownCompanyEntities: ["Cognition AI", "Fetch AI"],
    metroSaturation: {
      london: 45,
      manchester: 2,
      bristol: 0,
    },
  });

  // Check that London is declared saturated
  assert.ok(prompt.includes("CRM-SATURATED METROS"));
  assert.ok(prompt.includes("London"));

  // Check that unvisited secondary metros are recommended instead of London
  assert.ok(prompt.includes("RECOMMENDED UNVISITED METROS"));
  assert.ok(prompt.includes("Manchester"));
  assert.ok(prompt.includes("Bristol"));

  // Check that known CRM entities are listed with negative operator advice
  assert.ok(prompt.includes("EXISTING CRM & RECENTLY EXPLORED COMPANIES"));
  assert.ok(prompt.includes("Cognition AI"));
});

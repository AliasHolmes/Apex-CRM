import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-select-stage-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import { determineSelectionShortfall } from "../server/leadSearch/stages/selectStage.js";
import { applyIntentEnrichmentDelta, getLeadScore } from "../server/leadSearch/scoring.js";

test("Stream 4 - Selection Stage Off-by-One Fix", async (t) => {
  await t.test("when qualified count equals targetLimit, isShortfall is FALSE (hit target runs execute intent)", () => {
    const isShortfall = determineSelectionShortfall(10, 10);
    assert.equal(isShortfall, false, "Hitting target exactly must not trigger shortfall bypass");
  });

  await t.test("when qualified count exceeds targetLimit, isShortfall is FALSE", () => {
    const isShortfall = determineSelectionShortfall(15, 10);
    assert.equal(isShortfall, false);
  });

  await t.test("when qualified count is less than targetLimit, isShortfall is TRUE", () => {
    const isShortfall = determineSelectionShortfall(9, 10);
    assert.equal(isShortfall, true, "Strictly fewer leads than target is a shortfall");
  });

  await t.test("Phase 3.2: judge qualification.finalScore remains the baseline score before and after enrichment deltas", () => {
    const lead: Record<string, any> = {
      id: "lead-judge-baseline",
      qualification: { verdict: "qualified", finalScore: 8.4 },
      finalSelectionScore: 8.4,
      decisionMakerVerification: { confidence: 5 },
      companyIntentEvidence: {
        evidenceQuality: "good",
        dynamicSignals: ["hiring n8n automation"],
        universalSignals: ["careers"],
        pagesMatched: 2
      }
    };
    assert.equal(getLeadScore(lead), 8.4, "Baseline must be the judge score 8.4, not the lower structural rank");
    const enriched = applyIntentEnrichmentDelta(lead, 0);
    assert.ok(enriched > 8.4, `Enriched score (${enriched}) must build additively on judge score 8.4`);
  });
});


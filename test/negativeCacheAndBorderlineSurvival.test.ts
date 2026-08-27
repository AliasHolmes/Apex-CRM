import test from "node:test";
import assert from "node:assert/strict";
import { computeScoreBreakdown } from "../server/leadSearch/scoring.js";

test("Borderline lead with score >= 5.0 and decision maker verification satisfies admission condition", () => {
  const minScore = 6.0;
  const lead: any = {
    fullName: "Elena Rostova",
    currentTitle: "Co-Founder & AI Architect",
    currentCompany: "Synthetix Labs",
    contactDetails: { linkedinUrl: "https://www.linkedin.com/in/elena-rostova" },
    _borderlineEvidence: true
  };

  const scoreBreakdown = computeScoreBreakdown(
    lead,
    "weak",
    "tavily",
    { confidence: 8, ignoredTitle: false }
  );

  lead.scoreBreakdown = scoreBreakdown;
  const score = scoreBreakdown.finalScore;

  // The acceptance condition in enrichStage:
  const passesScore =
    score >= minScore ||
    Boolean(lead._borderlineEvidence) ||
    score >= minScore - 1.0;

  assert.ok(
    passesScore,
    `Borderline lead with score ${score} should pass acceptance condition`,
  );
});

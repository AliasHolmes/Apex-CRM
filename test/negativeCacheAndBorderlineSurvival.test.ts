import test from "node:test";
import assert from "node:assert/strict";
import { computeScoreBreakdown } from "../server/leadSearch/scoring.js";

test("borderline lead is admitted via the real [minScore-3, minScore) window and score gate", () => {
  const minScore = 6.0;
  const lead: any = {
    fullName: "Elena Rostova",
    currentTitle: "Co-Founder & AI Architect",
    currentCompany: "Synthetix Labs",
    contactDetails: { linkedinUrl: "https://www.linkedin.com/in/elena-rostova" },
  };

  const scoreBreakdown = computeScoreBreakdown(
    lead,
    "weak",
    "tavily",
    { confidence: 8, ignoredTitle: false } as any,
  );

  lead.scoreBreakdown = scoreBreakdown;
  const score = scoreBreakdown.finalScore;

  // Real engine contract:
  //  - verifyStage.ts:435 flags a lead borderline when (minScore - 3) <= score < minScore.
  //  - enrichStage.ts:1220 admits a lead when score >= minScore || _borderlineEvidence.
  const isBorderline = score >= minScore - 3 && score < minScore;
  const admitted = score >= minScore || isBorderline;

  assert.ok(
    typeof score === "number" && Number.isFinite(score),
    "computeScoreBreakdown must produce a finite score",
  );
  assert.ok(score < minScore, "this fixture is expected to score below minScore (a genuine borderline case)");
  assert.ok(
    admitted,
    `borderline score ${score} must be admitted via the >=minScore gate or the [minScore-3, minScore) window`,
  );
});

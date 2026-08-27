import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundDiagnostics } from "../server/leadSearch/roundDiagnostics.js";
import { buildDeterministicProspectContract } from "../server/leadSearch/prospectContract.js";

test("buildRoundDiagnostics recognizes multi-signal candidate relevance without rigid exact match", () => {
  const brief =
    "Founder or owner of a marketing agency in USA, LinkedIn active";
  const contract = buildDeterministicProspectContract(brief);

  const leads = [
    {
      fullName: "Sarah Connor",
      currentTitle: "Founder & Creative Director",
      headline:
        "Founder at Neon Agency | Digital Marketing, Branding & Growth",
      currentCompany: "Neon Agency",
      location: "Austin, Texas, United States",
      decisionMakerVerification: { verified: true },
    },
    {
      fullName: "John Doe",
      currentTitle: "CEO",
      headline: "CEO @ Quantum Marketing - Full Service Agency",
      currentCompany: "Quantum Marketing",
      location: "New York, USA",
      decisionMakerVerification: { verified: true },
    },
  ];

  const diag = buildRoundDiagnostics({
    round: 1,
    rawCandidates: 20,
    extractedCandidates: 10,
    leads,
    contract,
    targetLimit: 2,
  });

  assert.equal(
    diag.viableCandidates,
    2,
    "Both candidates must be recognized as viable",
  );
  assert.equal(
    diag.missingHardRequirementIds.length,
    0,
    "No hard requirements should be missing",
  );
  assert.equal(
    diag.shouldRecover,
    false,
    "Recovery is not needed when viable candidates meet target",
  );
});

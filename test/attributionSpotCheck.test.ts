import { describe, it } from "node:test";
import assert from "node:assert";
import { checkStrictContradiction } from "../server/leadSearch/finalistJudge.ts";
import { buildLeadIdentityKeys } from "../server/db.js";

describe("Attribution and Disqualification Spot Checks", () => {
  it("should not reject a valid agency lead with a brand-related title", () => {
    const lead = {
      currentCompany: "Digital Growth Agency",
      currentTitle: "Google Partner & Meta Ads Specialist",
    };
    const contract = {
      brief: "Looking for digital marketing agencies.",
      requirements: [],
      exclusions: [],
    };
    
    // Test the identity keys build while we're at it (as requested by B30 instructions)
    const keys = buildLeadIdentityKeys(lead);
    assert.ok(keys instanceof Set);
    
    const result = checkStrictContradiction(lead, contract as any);
    assert.strictEqual(result, null);
  });

  it("should reject a candidate working directly at big tech", () => {
    const lead = {
      currentCompany: "Amazon Web Services",
      currentTitle: "Solutions Architect",
    };
    const contract = {
      brief: "Looking for software agencies.",
      requirements: [{ scope: "company_type", importance: "hard", description: "company", id: "req_1" }],
      exclusions: [],
    };
    const result = checkStrictContradiction(lead, contract as any);
    assert.ok(result, "Expected to be rejected");
    assert.ok(result?.reason.includes("non-agency tech enterprise") || result?.reason.includes("Amazon"));
  });

  it("should not reject a valid marketing lead with a specific ad platform title", () => {
    const lead = {
      currentCompany: "WebScale Marketing",
      currentTitle: "Founder | Google Ads specialist",
    };
    const contract = {
      brief: "Looking for marketing agencies.",
      requirements: [],
      exclusions: [],
    };
    const result = checkStrictContradiction(lead, contract as any);
    assert.strictEqual(result, null);
  });
});

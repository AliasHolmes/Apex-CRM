import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasGroundedQualification,
  upsertLeadsWithIdentity,
  readStoredLeadById,
  readLeadActivities,
} from "../server/db.js";

describe("Grounded-Write Invariant (ADR-0015 / Findings F5, F6)", () => {
  it("pure helper hasGroundedQualification correctly evaluates payloads", () => {
    // Missing or invalid
    assert.equal(hasGroundedQualification(null as any), false);
    assert.equal(hasGroundedQualification({}), false);
    assert.equal(hasGroundedQualification({ qualification: {} }), false);

    // Cached verdict reuse is grounded
    assert.equal(
      hasGroundedQualification({
        qualification: { verdict: "qualified", sourceVerdict: "candidate_verdicts" },
      }),
      true
    );

    // Qualified with quote is grounded
    assert.equal(
      hasGroundedQualification({
        qualification: {
          verdict: "qualified",
          requirements: [{ name: "Role", met: true, quote: "CEO at Acme" }],
        },
      }),
      true
    );

    // Qualified with evidenceQuote is grounded
    assert.equal(
      hasGroundedQualification({
        qualification: {
          verdict: "qualified_partial",
          requirements: [{ name: "Role", met: true, evidenceQuote: "Founder at Startup" }],
        },
      }),
      true
    );

    // Qualified but empty quotes is ungrounded
    assert.equal(
      hasGroundedQualification({
        qualification: {
          verdict: "qualified",
          requirements: [{ name: "Role", met: true, quote: "   " }],
        },
      }),
      false
    );

    // Not qualified verdict is ungrounded
    assert.equal(
      hasGroundedQualification({
        qualification: {
          verdict: "not_qualified",
          requirements: [{ name: "Role", met: true, quote: "CEO at Acme" }],
        },
      }),
      false
    );
  });

  it("passes grounded engine writes through with KEEP and priority tier", () => {
    const leadId = `lead-grounded-${Date.now()}`;
    const payload = {
      id: leadId,
      fullName: "Grounded CEO",
      currentTitle: "CEO",
      currentCompany: "Grounding Labs",
      reviewStatus: "KEEP",
      nextAction: "CONNECT",
      tier: "TIER 1: PRIORITY",
      qualification: {
        verdict: "qualified",
        requirements: [{ name: "Role", met: true, quote: "CEO at Grounding Labs" }],
      },
    };

    upsertLeadsWithIdentity([payload], { isEngineWrite: true });
    const stored = readStoredLeadById(leadId);
    assert.ok(stored);
    assert.equal(stored.reviewStatus, "KEEP");
    assert.equal(stored.nextAction, "CONNECT");
    assert.equal(stored.tier, "TIER 1: PRIORITY");
    assert.equal(String(stored.notes || "").includes("[ungrounded-write]"), false);
  });

  it("demotes ungrounded engine writes to UNREVIEWED with note and activity record", () => {
    const leadId = `lead-ungrounded-${Date.now()}`;
    const payload = {
      id: leadId,
      fullName: "Ungrounded Lead",
      currentTitle: "Executive",
      currentCompany: "Unknown Corp",
      reviewStatus: "KEEP",
      nextAction: "CONNECT",
      tier: "TIER 1: PRIORITY",
      // No grounded qualification
    };

    upsertLeadsWithIdentity([payload], { isEngineWrite: true });
    const stored = readStoredLeadById(leadId);
    assert.ok(stored);
    assert.equal(stored.reviewStatus, "UNREVIEWED");
    assert.equal(stored.nextAction, "NONE");
    assert.equal(stored.tier, "TIER 3: WATCH");
    assert.match(String(stored.notes || ""), /\[ungrounded-write\]/);

    const activities = readLeadActivities(leadId);
    const demotion = activities.find((a) => a.type === "ungrounded_write_demotion");
    assert.ok(demotion, "Expected ungrounded_write_demotion activity record");
    assert.equal(demotion.fromValue, "KEEP");
    assert.equal(demotion.toValue, "UNREVIEWED");
    assert.equal(demotion.actor, "engine");
  });

  it("allows cached verdict reuse without demoting", () => {
    const leadId = `lead-cached-${Date.now()}`;
    const payload = {
      id: leadId,
      fullName: "Cached Verdict Lead",
      currentTitle: "Founder",
      currentCompany: "Cached Labs",
      reviewStatus: "KEEP",
      nextAction: "CONNECT",
      tier: "TIER 1: PRIORITY",
      qualification: {
        verdict: "qualified",
        sourceVerdict: "candidate_verdicts",
      },
    };

    upsertLeadsWithIdentity([payload], { isEngineWrite: true });
    const stored = readStoredLeadById(leadId);
    assert.ok(stored);
    assert.equal(stored.reviewStatus, "KEEP");
    assert.equal(stored.nextAction, "CONNECT");
  });

  it("does not demote non-engine writes (CSV/manual imports)", () => {
    const leadId = `lead-manual-${Date.now()}`;
    const payload = {
      id: leadId,
      fullName: "Manual Import Lead",
      currentTitle: "Director",
      currentCompany: "Manual Co",
      reviewStatus: "KEEP",
      nextAction: "CONNECT",
      tier: "TIER 1: PRIORITY",
      // No qualification
    };

    // isEngineWrite is omitted / false for manual/CSV writes
    upsertLeadsWithIdentity([payload], { isEngineWrite: false });
    const stored = readStoredLeadById(leadId);
    assert.ok(stored);
    assert.equal(stored.reviewStatus, "KEEP");
    assert.equal(stored.nextAction, "CONNECT");
    assert.equal(stored.tier, "TIER 1: PRIORITY");
    assert.equal(String(stored.notes || "").includes("[ungrounded-write]"), false);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-title-triage-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  classifyTitle,
  evaluateDecisionMakerGate,
} from "../server/leadSearch/titleTriage.js";
import { checkStrictContradiction } from "../server/leadSearch/finalistJudge.js";
import type { ProspectContract } from "../server/leadSearch/prospectContract.js";

test("Stream 3 - Title Triage Truth Table & Precedence", async (t) => {
  await t.test("passes Principal Consultant due to Executive Override over Consultant", () => {
    const res = classifyTitle("Principal Consultant");
    assert.equal(res.isExecutive, true);
    assert.equal(res.isIC, false);
    assert.ok(res.confidence >= 7);
  });

  await t.test("fails Associate as an IC non-decision maker role", () => {
    const res = classifyTitle("Associate");
    assert.equal(res.isExecutive, false);
    assert.equal(res.isIC, true);
    assert.ok(res.confidence <= 3);
  });

  await t.test("passes VP Sales with executive precedence", () => {
    const res = classifyTitle("VP Sales");
    assert.equal(res.isExecutive, true);
    assert.equal(res.isIC, false);
    assert.ok(res.confidence >= 7);
  });

  await t.test("fails Account Executive as an IC sales role", () => {
    const res = classifyTitle("Account Executive");
    assert.equal(res.isExecutive, false);
    assert.equal(res.isIC, true);
    assert.ok(res.confidence <= 3);
  });

  await t.test("fails Principal Engineer as IC role (lookahead prevents executive match)", () => {
    const res = classifyTitle("Principal Engineer");
    assert.equal(res.isExecutive, false);
    assert.equal(res.isIC, true);
  });

  await t.test("fails Staff Software Engineer as IC role", () => {
    const res = classifyTitle("Staff Software Engineer");
    assert.equal(res.isExecutive, false);
    assert.equal(res.isIC, true);
  });

  await t.test("passes Founder & CEO as executive role", () => {
    const res = classifyTitle("Founder & CEO");
    assert.equal(res.isExecutive, true);
    assert.equal(res.isIC, false);
  });

  await t.test("passes Managing Partner as executive role", () => {
    const res = classifyTitle("Managing Partner");
    assert.equal(res.isExecutive, true);
    assert.equal(res.isIC, false);
  });
});

test("Stream 3 - evaluateDecisionMakerGate Threshold Consistency", async (t) => {
  await t.test("authorityRequired=true rejects when ignoredTitle=true and confidence <= 2", () => {
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: true,
      confidence: 2,
      authorityRequired: true,
    });
    assert.equal(gate.pass, false);
    assert.match(gate.reason || "", /low authority/i);
  });

  await t.test("authorityRequired=true passes when title is not ignored", () => {
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: false,
      confidence: 2,
      authorityRequired: true,
    });
    assert.equal(gate.pass, true);
  });

  await t.test("standard pipeline gate rejects when ignoredTitle=true, confidence < 4, and effectiveScore < minScore", () => {
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: true,
      confidence: 3,
      effectiveScore: 4.0,
      minScore: 5.0,
    });
    assert.equal(gate.pass, false);
    assert.match(gate.reason || "", /Low decision-maker confidence/);
  });

  await t.test("standard pipeline gate passes when confidence is 4 even with low score (fixing enrichStage split-brain)", () => {
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: false,
      confidence: 4,
      effectiveScore: 3.5,
      minScore: 5.0,
    });
    assert.equal(gate.pass, true);
  });

  await t.test("standard pipeline gate passes when effectiveScore >= minScore even if ignoredTitle=true and confidence=3", () => {
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: true,
      confidence: 3,
      effectiveScore: 7.5,
      minScore: 5.0,
    });
    assert.equal(gate.pass, true);
  });
});

test("Stream 3 - checkStrictContradiction in finalistJudge", async (t) => {
  const baseContract: ProspectContract = {
    version: 1,
    policyVersion: "evidence-contract-v8",
    brief: "Marketing agency owners and founders",
    requirements: [
      {
        id: "company_type",
        description: "Marketing agency",
        scope: "company_type",
        importance: "hard",
        evidenceModality: "structured_profile",
        sourcePhrase: "marketing agencies",
        acceptableTerms: ["marketing agency", "digital agency"],
        queryable: true,
      },
    ],
    exclusions: [],
    initialQueries: [],
    authorityRequired: true,
  };

  await t.test("rejects Principal Engineer on founder/owner query", () => {
    const lead = {
      fullName: "Jane Doe",
      currentTitle: "Principal Software Engineer",
      currentCompany: "Acme Digital Agency",
      decisionMakerVerification: {
        ignoredTitle: true,
        confidence: 2,
      },
    };

    const result = checkStrictContradiction(lead, baseContract);
    assert.ok(result !== null);
    assert.match(result?.reason || "", /contradicts required owner\/founder leadership|low authority/i);
  });

  await t.test("admits Principal Consultant on agency owner query", () => {
    const lead = {
      fullName: "John Smith",
      currentTitle: "Principal Consultant",
      currentCompany: "Acme Digital Agency",
      companyEntityResolution: {
        verified: true,
        companyName: "Acme Digital Agency",
      },
      decisionMakerVerification: {
        ignoredTitle: false,
        confidence: 7,
      },
    };

    const result = checkStrictContradiction(lead, baseContract);
    assert.equal(result, null);
  });
});

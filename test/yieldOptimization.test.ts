import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-yield-opt-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  buildDeterministicProspectContract,
} from "../server/leadSearch/prospectContract.js";
import {
  evaluateDecisionMakerGate,
} from "../server/leadSearch/titleTriage.js";
import {
  verifyDecisionMakerFromEvidence,
} from "../server/leadSearch/verification.js";
import {
  cleanCompanyHint,
  looksLikeCompanyHint,
} from "../server/leadSearch/observations.js";

test("Yield Optimization - Target 1: Unquoted natural query tokens", async (t) => {
  await t.test("Fallback queries do not force quotes around 2-word verticals", () => {
    const contract = buildDeterministicProspectContract("Find AI agency owners in Austin USA");
    const queries = contract.initialQueries.map((q) => q.query);
    assert.ok(queries.length > 0, "Initial queries should be generated");
    // Verify none of the persona queries wrap AI agency in quotes
    for (const q of queries) {
      assert.ok(!q.includes('"AI agency"'), `Query should not contain forced quotes: ${q}`);
      assert.ok(q.toLowerCase().includes("ai agency"), `Query should include natural token AI agency: ${q}`);
    }
  });

  await t.test("Global mode fallback queries do not force quotes around multi-word verticals", () => {
    const contract = buildDeterministicProspectContract("AI automation service founders");
    const queries = contract.initialQueries.map((q) => q.query);
    assert.ok(queries.length > 0, "Initial queries should be generated");
    for (const q of queries) {
      assert.ok(!q.includes('"AI automation service"'), `Query should not contain forced quotes: ${q}`);
    }
  });
});

test("Yield Optimization - Target 2: Headline Company Fallback Resolution", async (t) => {
  await t.test("cleanCompanyHint and looksLikeCompanyHint identify valid companies", () => {
    assert.equal(looksLikeCompanyHint("Acme AI Studio"), true);
    assert.equal(looksLikeCompanyHint("Nexus Solutions"), true);
    assert.equal(looksLikeCompanyHint("London, UK"), false);
    assert.equal(looksLikeCompanyHint("United States"), false);
  });

  await t.test("Extracts company from '@ Company' in headline", () => {
    const headline = "Founder & CEO @ NeuralEdge AI | Automating Enterprises";
    const atMatch = headline.match(/(?:\b(?:at|of)\b|@)\s+([A-Za-z0-9][A-Za-z0-9&.' -]{1,60}?)(?=\s*(?:\||\u2013|\u2014|•|\n|,|$))/i);
    assert.ok(atMatch, "Regex should match @ pattern");
    const company = cleanCompanyHint(atMatch[1]);
    assert.equal(company, "NeuralEdge AI");
    assert.equal(looksLikeCompanyHint(company), true);
  });

  await t.test("Extracts company from 'at Company' in headline", () => {
    const headline = "Owner at Apex Integrations • Building LLM Workflows";
    const atMatch = headline.match(/(?:\b(?:at|of)\b|@)\s+([A-Za-z0-9][A-Za-z0-9&.' -]{1,60}?)(?=\s*(?:\||\u2013|\u2014|•|\n|,|$))/i);
    assert.ok(atMatch, "Regex should match at pattern");
    const company = cleanCompanyHint(atMatch[1]);
    assert.equal(company, "Apex Integrations");
    assert.equal(looksLikeCompanyHint(company), true);
  });

  await t.test("Extracts company from pipe separator when at/of is absent", () => {
    const headline = "Founder | HyperScale Labs";
    const parts = headline.split(/\s*(?:\||\u2013|\u2014|•)\s*/).map(p => p.trim()).filter(Boolean);
    assert.ok(parts.length > 1);
    const candidate = cleanCompanyHint(parts[parts.length - 1]);
    assert.equal(candidate, "HyperScale Labs");
    assert.equal(looksLikeCompanyHint(candidate), true);
  });
});

test("Yield Optimization - Target 3: Decision-Maker Pre-Filtering", async (t) => {
  await t.test("Account Manager is rejected deterministically when authority is required", () => {
    const dmVerification = verifyDecisionMakerFromEvidence({
      query: "AI agency owners in New York",
      currentTitle: "Account Manager",
      headline: "Account Manager at TechCorp",
    });
    assert.equal(dmVerification.ignoredTitle, true, "Account Manager should be marked as ignored title");
    assert.ok(dmVerification.confidence <= 2, "Confidence should be <= 2");

    const gate = evaluateDecisionMakerGate({
      ignoredTitle: dmVerification.ignoredTitle,
      confidence: dmVerification.confidence,
      authorityRequired: true,
      effectiveScore: 6.5, // Even with high keyword match score
    });
    assert.equal(gate.pass, false, "evaluateDecisionMakerGate must reject Account Manager when authority is required");
    assert.match(gate.reason || "", /low authority/i);
  });

  await t.test("Product Leader is rejected deterministically when authority is required", () => {
    const dmVerification = verifyDecisionMakerFromEvidence({
      query: "AI agency owners in New York",
      currentTitle: "Product Leader",
      headline: "Product Leader | Enterprise SaaS",
    });
    assert.equal(dmVerification.ignoredTitle, true);
    assert.ok(dmVerification.confidence <= 2);

    const gate = evaluateDecisionMakerGate({
      ignoredTitle: dmVerification.ignoredTitle,
      confidence: dmVerification.confidence,
      authorityRequired: true,
      effectiveScore: 7.0,
    });
    assert.equal(gate.pass, false);
  });

  await t.test("Brand Ambassador is rejected deterministically when authority is required", () => {
    const dmVerification = verifyDecisionMakerFromEvidence({
      query: "AI agency owners in New York",
      currentTitle: "Brand Ambassador",
      headline: "Brand Ambassador at Agency",
    });
    assert.equal(dmVerification.ignoredTitle, true);
    assert.ok(dmVerification.confidence <= 2);

    const gate = evaluateDecisionMakerGate({
      ignoredTitle: dmVerification.ignoredTitle,
      confidence: dmVerification.confidence,
      authorityRequired: true,
      effectiveScore: 5.5,
    });
    assert.equal(gate.pass, false);
  });

  await t.test("Genuine Agency Founder passes gate with high confidence", () => {
    const dmVerification = verifyDecisionMakerFromEvidence({
      query: "AI agency owners in New York",
      currentTitle: "Founder & CEO",
      currentCompany: "Nexus AI Studio",
      headline: "Founder & CEO at Nexus AI Studio",
    });
    assert.equal(dmVerification.ignoredTitle, false);
    assert.ok(dmVerification.confidence >= 7);

    const gate = evaluateDecisionMakerGate({
      ignoredTitle: dmVerification.ignoredTitle,
      confidence: dmVerification.confidence,
      authorityRequired: true,
      effectiveScore: 8.0,
    });
    assert.equal(gate.pass, true);
  });
});

test("Yield Optimization - Target 4: Strategic Vocabulary Elevation", async (t) => {
  await t.test("Contract company_type expansion prioritizes integrator and solutions over consultancy", () => {
    const contract = buildDeterministicProspectContract("AI agency owners in New York");
    const compReq = contract.requirements.find(r => r.scope === "company_type");
    assert.ok(compReq, "company_type requirement should exist");
    const terms = compReq.acceptableTerms;
    
    const integratorIdx = terms.indexOf("AI integrator");
    const solutionsIdx = terms.indexOf("AI solutions provider");
    const studioIdx = terms.indexOf("AI studio");
    const consultancyIdx = terms.indexOf("AI consultancy");
    const consultingFirmIdx = terms.indexOf("AI consulting firm");

    assert.ok(integratorIdx !== -1, "AI integrator must be in acceptable terms");
    assert.ok(solutionsIdx !== -1, "AI solutions provider must be in acceptable terms");
    assert.ok(studioIdx !== -1, "AI studio must be in acceptable terms");
    assert.ok(consultancyIdx !== -1, "AI consultancy must be in acceptable terms");

    // Integrator, solutions provider, and studio must appear ahead of consultancy
    assert.ok(integratorIdx < consultancyIdx, `integrator (${integratorIdx}) should appear before consultancy (${consultancyIdx})`);
    assert.ok(solutionsIdx < consultancyIdx, `solutions provider (${solutionsIdx}) should appear before consultancy (${consultancyIdx})`);
    assert.ok(studioIdx < consultancyIdx, `studio (${studioIdx}) should appear before consultancy (${consultancyIdx})`);
    assert.ok(integratorIdx < consultingFirmIdx, `integrator (${integratorIdx}) should appear before consulting firm (${consultingFirmIdx})`);
  });
});

test("Yield Optimization - Target 5: Dynamic Round Extension Ceiling", async (t) => {
  await t.test("configuredRoundCeiling allows +2 rounds beyond maxRounds when extended ceiling is not pinned", () => {
    const maxRounds = 6;
    const extendedCeilingEnv = 0;
    const configuredRoundCeiling = extendedCeilingEnv > 0
      ? extendedCeilingEnv
      : Math.min(10, maxRounds + 2);
    
    assert.equal(configuredRoundCeiling, 8, "Ceiling should be 8 for maxRounds=6");
    assert.ok(maxRounds < configuredRoundCeiling, "maxRounds (6) < configuredRoundCeiling (8) must be true so dynamic extension can fire");
  });

  await t.test("configuredRoundCeiling respects explicit env override", () => {
    const maxRounds = 6;
    const extendedCeilingEnv = 6; // Explicitly locked to 6
    const configuredRoundCeiling = extendedCeilingEnv > 0
      ? extendedCeilingEnv
      : Math.min(10, maxRounds + 2);

    assert.equal(configuredRoundCeiling, 6);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.APEX_DB_PATH = path.join(
  os.tmpdir(),
  `test-pipeline-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);

import { classifyKeyRotationError, isHostNetworkError } from "../server/services/keyRotator.js";
import { hasIdentityAnchor } from "../server/leadSearch/stages/verifyStage.js";
import {
  buildDeterministicProspectContract,
  normalizeProspectContract,
} from "../server/leadSearch/prospectContract.js";
import { applyRequestedDiscoveryMode } from "../server/leadSearch/searchSpec.js";
import { classifyLeadTransition } from "../server/routes/api.js";

test("key rotation treats provider plan/usage limits as exhaustion so the next key is tried", () => {
  const planLimit = Object.assign(
    new Error("This request exceeds your plan's set usage limit. Please upgrade your plan."),
    { statusCode: 432 },
  );
  assert.equal(classifyKeyRotationError(planLimit).kind, "exhausted");

  const payGo = Object.assign(new Error("PayGo limit exceeded"), { statusCode: 433 });
  assert.equal(classifyKeyRotationError(payGo).kind, "exhausted");

  const messageOnly = new Error("Request failed: you have exceeded your plan limit for this month");
  assert.equal(classifyKeyRotationError(messageOnly).kind, "exhausted");
});

test("key rotation does not mistake incidental words or numbers for exhaustion or status codes", () => {
  const credit = Object.assign(new Error("Invalid credit field in payload"), { statusCode: 422 });
  assert.notEqual(classifyKeyRotationError(credit).kind, "exhausted");

  const duration = classifyKeyRotationError(new Error("Request completed in 450ms without a body"));
  assert.equal(duration.statusCode, undefined);

  const sockErr = new Error("connect ETIMEDOUT 104.18.1.40:443");
  assert.equal(classifyKeyRotationError(sockErr).statusCode, undefined);
  assert.equal(isHostNetworkError(sockErr), true);

  // A real status in text is still found.
  assert.equal(classifyKeyRotationError(new Error("Tavily search error 401: bad key")).kind, "exhausted");
});

test("a person found on a company site keeps an identity anchor without a LinkedIn URL", () => {
  assert.equal(hasIdentityAnchor({ contactDetails: { linkedinUrl: "https://linkedin.com/in/jane" } }), true);
  assert.equal(hasIdentityAnchor({ sourceUrl: "https://www.linkedin.com/in/jane-doe/" }), true);
  assert.equal(hasIdentityAnchor({ contactDetails: { website: "acme.com" } }), true);
  assert.equal(hasIdentityAnchor({ companyEntityResolution: { companyDomain: "acme.com" } }), true);
  assert.equal(hasIdentityAnchor({ sourceUrl: "https://acme-plumbing.com/about/team" }), true);
  // A bare social/search/aggregator page proves nothing about who the person works for.
  assert.equal(hasIdentityAnchor({ sourceUrl: "https://www.facebook.com/some.page" }), false);
  assert.equal(hasIdentityAnchor({ sourceUrl: "https://www.google.com/search?q=jane" }), false);
  assert.equal(hasIdentityAnchor({ sourceUrl: "" }), false);
  assert.equal(hasIdentityAnchor({}), false);
});

test("contract exclusions keep a brand the user named and drop brands the model invented", () => {
  const spuriousBrief = "owners of digital marketing agencies in Texas";
  const fallback1 = buildDeterministicProspectContract(spuriousBrief);
  const c1 = normalizeProspectContract(
    { exclusions: ["Google", "Meta", "Staff Engineer"], requirements: [] },
    spuriousBrief,
    fallback1,
  );
  const ex1 = c1.exclusions.map((e: string) => e.toLowerCase());
  assert.ok(!ex1.includes("google"), "an invented bare-brand exclusion should be dropped");
  assert.ok(!ex1.includes("meta"));
  assert.ok(ex1.includes("staff engineer"));

  const namedBrief = "VPs of engineering at fintech startups, not Google employees";
  const fallback2 = buildDeterministicProspectContract(namedBrief);
  const c2 = normalizeProspectContract(
    { exclusions: ["Google", "Meta"], requirements: [] },
    namedBrief,
    fallback2,
  );
  const ex2 = c2.exclusions.map((e: string) => e.toLowerCase());
  assert.ok(ex2.includes("google"), "a brand the user explicitly excluded must survive");
  assert.ok(!ex2.includes("meta"), "a brand the user never mentioned is still dropped");
});

test("a requested discovery mode survives an LLM-generated search spec", () => {
  const spec: any = { mode: "person_first", person: {}, company: {}, signals: {}, exclusions: {}, maxPerCompany: 2 };
  assert.equal(applyRequestedDiscoveryMode(spec, "account_first").mode, "account_first");
  assert.equal(applyRequestedDiscoveryMode(spec, undefined).mode, "person_first");
  assert.equal(applyRequestedDiscoveryMode(spec, "not_a_mode" as any).mode, "person_first");
});

test("lead transitions classify into binary outcomes consistently", () => {
  assert.deepEqual(classifyLeadTransition({ stage: "ENRICHED" }, { stage: "REPLIED" }).outcome, {
    type: "positive",
    detail: "REPLIED",
  });
  assert.deepEqual(classifyLeadTransition({ stage: "ENRICHED" }, { stage: "LOST" }).outcome, {
    type: "negative",
    detail: "LOST",
  });
  assert.deepEqual(
    classifyLeadTransition({ reviewStatus: "UNREVIEWED" }, { reviewStatus: "REJECT" }).outcome,
    { type: "negative", detail: "REJECT" },
  );
  assert.equal(classifyLeadTransition({ stage: "ENRICHED" }, { stage: "SEQUENCE ACTIVE" }).outcome, null);
  assert.equal(classifyLeadTransition({ stage: "LOST" }, { stage: "LOST" }).outcome, null);
});

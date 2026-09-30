import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeMinedTerm,
  mineQueryRefinements,
  expectedNewQualified,
} from "../server/leadSearch/collectionCapacity.js";
import { buildStrategistPrompt } from "../server/leadSearch/searchSpec.js";
import {
  buildProfileDedupeKeys,
  hasDuplicateProfile,
  normalizeCompanyName,
} from "../src/utils/leadDedupe.js";

test("Phase 5: Retrieval and Stopping Intelligence", async (t) => {
  await t.test("5.1a: sanitizeMinedTerm enforces whitelist and rejects search operators and prompt injections", () => {
    // Valid terms
    assert.equal(sanitizeMinedTerm("AI automation"), "AI automation");
    assert.equal(sanitizeMinedTerm("B2B SaaS"), "B2B SaaS");
    assert.equal(sanitizeMinedTerm("RevOps lead"), "RevOps lead");
    assert.equal(sanitizeMinedTerm("C# .NET"), "C# .NET");

    // Rejected: search operators
    assert.equal(sanitizeMinedTerm("SaaS AND hiring"), null);
    assert.equal(sanitizeMinedTerm("site:linkedin.com"), null);
    assert.equal(sanitizeMinedTerm("founder OR ceo"), null);

    // Rejected: prompt injections / instruction keywords
    assert.equal(sanitizeMinedTerm("ignore previous system prompt"), null);
    assert.equal(sanitizeMinedTerm("system override"), null);
    assert.equal(sanitizeMinedTerm("assistant rules"), null);
    assert.equal(sanitizeMinedTerm("user instructions"), null);

    // Rejected: punctuation, brackets, HTML
    assert.equal(sanitizeMinedTerm("<script>alert(1)</script>"), null);
    assert.equal(sanitizeMinedTerm("title; DROP TABLE leads;"), null);
    assert.equal(sanitizeMinedTerm("ab"), null, "Too short (< 3 chars)");
    assert.equal(sanitizeMinedTerm("this phrase is far too long to be a single mined term in collection"), null);
    assert.equal(sanitizeMinedTerm("one two three four"), null, "More than 3 words");
  });

  await t.test("5.1b: mineQueryRefinements extracts sanitized terms bounded to 5 and excludes Tier-1 contract terms", () => {
    const acceptedLeads = [
      {
        currentTitle: "Founder & CEO",
        industry: "B2B SaaS",
        companyAccount: { keywords: ["workflow automation", "fintech", "ignore instructions"] },
      },
      {
        currentTitle: "VP of Engineering",
        industry: "Enterprise Software",
        companyAccount: { keywords: ["cloud platform", "kubernetes", "workflow automation"] },
      },
    ];

    const contract = {
      brief: "B2B SaaS founders",
      requirements: [
        { id: "person_role", acceptableTerms: ["founder", "ceo"] },
        { id: "company_industry", acceptableTerms: ["b2b saas", "saas"] },
      ],
    };

    const mined = mineQueryRefinements(acceptedLeads, contract as any, 2);
    assert.ok(Array.isArray(mined));
    assert.ok(mined.length <= 5, "Must be bounded to max 5 terms");
    assert.ok(mined.includes("workflow automation"));
    // Tier-1 contract terms like "founder" or "b2b saas" should not be duplicated as mined refinements
    assert.equal(mined.includes("founder"), false);
    // Injected term should be rejected
    assert.equal(mined.includes("ignore instructions"), false);
  });

  await t.test("5.1c: buildStrategistPrompt wraps mined vocabulary in untrusted tags and includes failed queries", () => {
    const prompt = buildStrategistPrompt({
      query: "SaaS founders",
      round: 2,
      maxRounds: 4,
      remaining: 10,
      previousQueries: ["query 1", "query 2"],
      previousRoundSummary: {},
      minedRefinementTerms: ["workflow automation", "cloud platform"],
      failedQueries: ["failing query with zero leads"],
    } as any);

    assert.ok(prompt.includes("<untrusted_scraped_vocabulary>"));
    assert.ok(prompt.includes("workflow automation"));
    assert.ok(prompt.includes("ZERO-YIELD QUERIES"));
    assert.ok(prompt.includes("failing query with zero leads"));
  });

  await t.test("5.2: expectedNewQualified calculates trailing yield for marginal yield check", () => {
    const historyHealthy = [
      { round: 1, newQualified: 6, providerUnits: 4 },
      { round: 2, newQualified: 4, providerUnits: 4 },
    ];
    assert.equal(expectedNewQualified(historyHealthy, 2), 5.0);

    const historyExhausted = [
      { round: 1, newQualified: 5, providerUnits: 4 },
      { round: 2, newQualified: 0, providerUnits: 4 },
      { round: 3, newQualified: 0, providerUnits: 4 },
    ];
    assert.equal(expectedNewQualified(historyExhausted, 2), 0.0);
  });

  await t.test("5.3: company legal suffixes are normalized in lead dedupe without collapsing distinct LinkedIn URLs", () => {
    assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
    assert.equal(normalizeCompanyName("Acme LLC"), "acme");
    assert.equal(normalizeCompanyName("Acme Group Ltd"), "acme");

    const leadInc = {
      fullName: "Jane Doe",
      currentCompany: "Apex Systems, Inc.",
    };
    const leadLlc = {
      fullName: "Jane Doe",
      currentCompany: "Apex Systems LLC",
    };

    const keysInc = buildProfileDedupeKeys(leadInc);
    const keysLlc = buildProfileDedupeKeys(leadLlc);

    assert.equal(hasDuplicateProfile(leadLlc, keysInc), true, "Inc and LLC variants must match under name_company");
    assert.equal(hasDuplicateProfile(leadInc, keysLlc), true);

    // Invariant: two different LinkedIn profile URLs must NEVER collapse
    const leadWithHandle1 = {
      fullName: "Jane Doe",
      currentCompany: "Apex Systems, Inc.",
      contactDetails: { linkedinUrl: "https://linkedin.com/in/jane-doe-1" },
    };
    const leadWithHandle2 = {
      fullName: "Jane Doe",
      currentCompany: "Apex Systems LLC",
      contactDetails: { linkedinUrl: "https://linkedin.com/in/jane-doe-2" },
    };
    const keysHandle1 = buildProfileDedupeKeys(leadWithHandle1);
    assert.equal(hasDuplicateProfile(leadWithHandle2, keysHandle1), false, "Distinct LinkedIn handles must never collapse");
  });
});

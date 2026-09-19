import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEvidenceForFinalist } from "../server/leadSearch/evidenceSelection.js";
import type { ProspectContract } from "../server/leadSearch/prospectContract.js";

test("selectEvidenceForFinalist allows sentences up to 500 chars and higher budget", () => {
  const contract: ProspectContract = {
    version: 1,
    policyVersion: "evidence-contract-v8",
    brief: "AI founders",
    authorityRequired: false,
    exclusions: [],
    initialQueries: [],
    requirements: [
      {
        id: "req_role",
        scope: "person_role",
        importance: "hard",
        evidenceModality: "structured_profile",
        description: "Must be a founder",
        sourcePhrase: "founder",
        acceptableTerms: ["founder", "ceo"],
        queryable: true,
      },
    ],
  };

  const longSentence = "Alice is the visionary founder and CEO of Acme AI, an enterprise artificial intelligence consultancy providing custom machine learning pipelines, deep learning computer vision models, and generative AI workflow automation across North America and Europe since 2021 with significant industry recognition and award-winning enterprise customer implementations.";
  assert.ok(longSentence.length > 300);

  const lead = {
    fullName: "Alice Smith",
    currentTitle: "Founder & CEO",
    currentCompany: "Acme AI",
    scout: {
      criteriaCoverageScore: 9,
      corroborationScore: 8,
    },
    evidence: {
      snippets: [longSentence],
      evidenceBlock: longSentence,
    },
  };

  const selected = selectEvidenceForFinalist(lead, contract);
  assert.ok(selected);
  // Sentence should not have been cut at 280 chars
  const combined = selected.evidence.map(i => i.text).join(" ");
  assert.ok(combined.length > 280, "Expected evidence length > 280");
  assert.ok(combined.includes("enterprise customer implementations"), "Expected sentence tail to be preserved up to 500 chars");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalLinkedInIdentity } from "../server/services/linkedinEvidence.js";

describe("canonicalLinkedInIdentity", () => {
  it("normalizes standard public profile URLs to linkedin:<slug>", () => {
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/in/sarah-connor/"),
      "linkedin:sarah-connor"
    );
    assert.equal(
      canonicalLinkedInIdentity("http://linkedin.com/in/john-smith"),
      "linkedin:john-smith"
    );
    assert.equal(
      canonicalLinkedInIdentity("https://linkedin.com/in/jane-doe///"),
      "linkedin:jane-doe"
    );
  });

  it("strips tracking query params and hash fragments", () => {
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/in/alex-miller?trk=public_profile_browsemap#experience"),
      "linkedin:alex-miller"
    );
  });

  it("normalizes uppercase and mixed-case URLs", () => {
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/in/ALICE-WONDERLAND/"),
      "linkedin:alice-wonderland"
    );
  });

  it("handles country-subdomain and locale-prefixed URLs", () => {
    assert.equal(
      canonicalLinkedInIdentity("https://uk.linkedin.com/in/richard-branson"),
      "linkedin:richard-branson"
    );
    assert.equal(
      canonicalLinkedInIdentity("https://de.linkedin.com/in/max-mustermann"),
      "linkedin:max-mustermann"
    );
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/in/de/hans-schmidt"),
      "linkedin:hans-schmidt"
    );
  });

  it("handles existing linkedin:<slug> keys idempotently", () => {
    assert.equal(
      canonicalLinkedInIdentity("linkedin:sarah-connor"),
      "linkedin:sarah-connor"
    );
    assert.equal(
      canonicalLinkedInIdentity("linkedin:SARAH-CONNOR"),
      "linkedin:sarah-connor"
    );
    assert.equal(
      canonicalLinkedInIdentity("  linkedin:john-doe  "),
      "linkedin:john-doe"
    );
  });

  it("handles bare slugs and normalizes them", () => {
    assert.equal(
      canonicalLinkedInIdentity("sarah-connor"),
      "linkedin:sarah-connor"
    );
    assert.equal(
      canonicalLinkedInIdentity("SARAH-CONNOR"),
      "linkedin:sarah-connor"
    );
  });

  it("normalizes posts and pulse URLs to the author slug", () => {
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/posts/satyanadella_ai-innovation-activity-7123456789-xyz"),
      "linkedin:satyanadella"
    );
    assert.equal(
      canonicalLinkedInIdentity("https://www.linkedin.com/pulse/future-of-cloud-satyanadella"),
      "linkedin:future-of-cloud-satyanadella"
    );
  });

  it("rejects invalid, empty, or reserved URLs cleanly", () => {
    assert.equal(canonicalLinkedInIdentity(""), "");
    assert.equal(canonicalLinkedInIdentity("   "), "");
    assert.equal(canonicalLinkedInIdentity(undefined as any), "");
    assert.equal(canonicalLinkedInIdentity(null as any), "");
    assert.equal(canonicalLinkedInIdentity("https://google.com/search?q=test"), "");
    assert.equal(canonicalLinkedInIdentity("https://linkedin.com/jobs/view/12345"), "");
    assert.equal(canonicalLinkedInIdentity("https://linkedin.com/in/login"), "");
    assert.equal(canonicalLinkedInIdentity("linkedin:login"), "");
    assert.equal(canonicalLinkedInIdentity("linkedin:12345"), "");
  });
});

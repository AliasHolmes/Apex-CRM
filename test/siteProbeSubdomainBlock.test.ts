import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomainUrl } from "../server/leadSearch/siteProbe.js";

test("normalizeDomainUrl blocks linkedin country subdomains", () => {
  assert.equal(normalizeDomainUrl("https://uk.linkedin.com/in/john-doe"), null);
  assert.equal(normalizeDomainUrl("https://ca.linkedin.com/in/jane-doe"), null);
  assert.equal(normalizeDomainUrl("https://fr.linkedin.com/company/acme"), null);
  assert.equal(normalizeDomainUrl("https://in.linkedin.com/"), null);
  assert.equal(normalizeDomainUrl("https://linkedin.com"), null);
  assert.equal(normalizeDomainUrl("https://www.linkedin.com"), null);
});

test("normalizeDomainUrl allows legitimate company domains", () => {
  assert.equal(normalizeDomainUrl("https://acmeai.com"), "https://acmeai.com");
  assert.equal(normalizeDomainUrl("https://sub.agencycorp.io"), "https://sub.agencycorp.io");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCompanyDomainWithProvenance } from "../server/leadSearch/siteProbe.js";

test("deriveCompanyDomainWithProvenance extracts explicit domain from contactDetails.website", () => {
  const lead = {
    fullName: "Jane Doe",
    contactDetails: {
      website: "https://janedoedesign.com",
    },
  };

  const derived = deriveCompanyDomainWithProvenance(lead);
  assert.ok(derived);
  assert.equal(derived.domain, "https://janedoedesign.com");
  assert.equal(derived.provenance, "explicit");
});

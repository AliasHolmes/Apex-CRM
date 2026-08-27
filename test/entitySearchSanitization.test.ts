import test from "node:test";
import assert from "node:assert/strict";
import { cleanCompanyForDomainSearch } from "../server/leadSearch/companyIntent.js";

test("cleanCompanyForDomainSearch strips punctuation, symbols, and legal entity suffixes", () => {
  assert.equal(
    cleanCompanyForDomainSearch("WeGood?\u00AE System Inc."),
    "WeGood System",
  );
  assert.equal(
    cleanCompanyForDomainSearch("Quantum Sales Technologies, LLC."),
    "Quantum Sales Technologies",
  );
  assert.equal(
    cleanCompanyForDomainSearch("Austin Artificial Intelligence, Inc."),
    "Austin Artificial Intelligence",
  );
  assert.equal(
    cleanCompanyForDomainSearch("Apex Global Solutions Ltd."),
    "Apex Global",
  );
  assert.equal(
    cleanCompanyForDomainSearch("NextGen Agency \u2122"),
    "NextGen",
  );
});

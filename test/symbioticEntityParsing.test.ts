import test from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicProspectContract } from "../server/leadSearch/prospectContract.js";

test("Smart entity parser extracts prepositional company types and rejects conjunction artifacts", () => {
  const brief =
    "Founder or owner of a marketing agency with 5-50 employees, US or Canada, LinkedIn active";
  const contract = buildDeterministicProspectContract(brief);

  const roleReq = contract.requirements.find((r) => r.scope === "person_role");
  const companyReq = contract.requirements.find(
    (r) => r.scope === "company_type",
  );
  const sizeReq = contract.requirements.find((r) => r.scope === "company_size");

  assert.ok(roleReq, "Must have a person_role requirement");
  assert.ok(
    roleReq.acceptableTerms.includes("founder") ||
      roleReq.acceptableTerms.includes("owner"),
    "Role terms must include founder or owner",
  );

  assert.ok(companyReq, "Must have a company_type requirement");
  assert.equal(
    companyReq.sourcePhrase,
    "marketing agency",
    "Company source phrase must be marketing agency",
  );
  assert.ok(
    !companyReq.acceptableTerms.includes("Founder or"),
    "Company requirement must NEVER include 'Founder or'",
  );
  assert.ok(
    !companyReq.acceptableTerms.includes("founder"),
    "Company requirement must NEVER include role words",
  );

  assert.ok(sizeReq, "Must have a company_size requirement");
  assert.ok(
    sizeReq.acceptableTerms.some((t) => t.includes("5-50")),
    "Size requirement must extract 5-50 employees",
  );
});

test("Smart entity parser extracts prefix company types", () => {
  const brief = "AI agency owner in Austin USA";
  const contract = buildDeterministicProspectContract(brief);

  const companyReq = contract.requirements.find(
    (r) => r.scope === "company_type",
  );
  assert.ok(companyReq, "Must have a company_type requirement");
  assert.equal(
    companyReq.sourcePhrase,
    "AI agency",
    "Company source phrase must be AI agency",
  );
});

test("Smart entity parser extracts role at company structure", () => {
  const brief = "CEO at a B2B SaaS in New York";
  const contract = buildDeterministicProspectContract(brief);

  const companyReq = contract.requirements.find(
    (r) => r.scope === "company_type",
  );
  assert.ok(companyReq, "Must have a company_type requirement");
  assert.equal(
    companyReq.sourcePhrase,
    "B2B SaaS",
    "Company source phrase must be B2B SaaS",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePrimaryAdmission } from "../server/leadSearch/stages/judgeStage.js";
import { namesKnownMetro } from "../server/leadSearch/prospectContract.js";

// Contract shape from the "AI service provider agency owner in Canada and USA" session:
// r3 (company_type) is the requirement that defines the brief.
const contract: any = {
  requirements: [
    { id: "person_role-1", scope: "person_role", importance: "hard" },
    { id: "r2", scope: "person_location", importance: "hard", groupId: "loc", matchRule: "any_of" },
    { id: "r3", scope: "company_type", importance: "hard", groupId: "type", matchRule: "any_of" },
  ],
};

const qual = (role: string, loc: string, type: string) => ({
  requirements: [
    { requirementId: "person_role-1", status: role },
    { requirementId: "r2", status: loc },
    { requirementId: "r3", status: type },
  ],
}) as any;

test("admits a lead whose company type is proven and attribution matches the brief", () => {
  const lead = { companyAttribution: { verdict: "verified_fit", queryAlignment: "matches_brief" } };
  assert.equal(evaluatePrimaryAdmission(lead, qual("pass", "pass", "pass"), contract).admit, true);
});

test("withholds a founder whose company type is unknown (the 7 junk partials in the audited session)", () => {
  const lead = { companyAttribution: { verdict: "unverified", queryAlignment: "adjacent", businessModel: "software_product" } };
  const res = evaluatePrimaryAdmission(lead, qual("pass", "pass", "unknown"), contract);
  assert.equal(res.admit, false);
  assert.match(res.reason || "", /defining requirement/);
});

test("attribution overrides a judge pass when the company is an adjacent product (Nikola Dordic case)", () => {
  const lead = { companyAttribution: { verdict: "unverified", queryAlignment: "adjacent", businessModel: "software_product" } };
  const res = evaluatePrimaryAdmission(lead, qual("pass", "pass", "pass"), contract);
  assert.equal(res.admit, false);
  assert.match(res.reason || "", /attribution/i);
});

test("stored-profile attribution carries placeholder values and must not veto a judge pass", () => {
  const lead = { companyAttribution: { verdict: "unverified", queryAlignment: "adjacent", fromStoredProfile: true } };
  assert.equal(evaluatePrimaryAdmission(lead, qual("pass", "pass", "pass"), contract).admit, true);
});

test("unknown location alone does not block admission (incidental context stays tolerant)", () => {
  const lead = { companyAttribution: { verdict: "verified_fit", queryAlignment: "matches_brief" } };
  assert.equal(evaluatePrimaryAdmission(lead, qual("pass", "unknown", "pass"), contract).admit, true);
});

test("gate is inert when the brief has no company_type requirement", () => {
  const noType: any = { requirements: [{ id: "a", scope: "person_role", importance: "hard" }] };
  assert.equal(evaluatePrimaryAdmission({}, { requirements: [{ requirementId: "a", status: "pass" }] } as any, noType).admit, true);
});

test("a deliberately ablated company_type requirement is not enforced", () => {
  const lead = { _ablatedRequirementId: "r3" };
  assert.equal(evaluatePrimaryAdmission(lead, qual("pass", "pass", "unknown"), contract).admit, true);
});

test("any_of group: one passing member is enough", () => {
  const grouped: any = {
    requirements: [
      { id: "t1", scope: "company_type", importance: "hard", groupId: "g", matchRule: "any_of" },
      { id: "t2", scope: "company_type", importance: "hard", groupId: "g", matchRule: "any_of" },
    ],
  };
  const q: any = { requirements: [{ requirementId: "t1", status: "unknown" }, { requirementId: "t2", status: "pass" }] };
  assert.equal(evaluatePrimaryAdmission({}, q, grouped).admit, true);
});

test("namesKnownMetro recognises US cities the old per-country list missed, whole-word only", () => {
  assert.equal(namesKnownMetro('"Founder" "generative AI" Atlanta AI service provider agency'), true);
  assert.equal(namesKnownMetro("Agency Founder AI agents Dallas"), true);
  assert.equal(namesKnownMetro("chrome extension founder"), false); // 'Rome' inside 'chrome'
  assert.equal(namesKnownMetro("AI consultancy founder"), false);
});

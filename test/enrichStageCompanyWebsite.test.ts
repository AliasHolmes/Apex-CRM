import { test } from "node:test";
import assert from "node:assert/strict";
import { applySiteProbe } from "../server/leadSearch/siteProbe.js";

test("applySiteProbe propagates company website signals to lead without error", () => {
  const target: any = {
    lead: {
      fullName: "Dave Miller",
      company: "Miller Consulting",
    },
    evidenceMeta: {},
  };

  const signals = {
    location: "Austin, TX",
    headcount: "10-50",
    services: "Cloud and AI Architecture",
    sourceUrl: "https://millerconsulting.io",
    provenance: "explicit" as const,
  };

  applySiteProbe(target, signals, "https://millerconsulting.io");
  assert.equal(target.lead.location, "Austin, TX");
  // G2: provenance tag marks company-derived location for judge routing
  assert.equal(target.lead._locationProvenance, "company_site");
  assert.equal(target.lead.companySizeEst, "10-50");
  assert.ok(target.lead.companyAccount.description.includes("Cloud and AI Architecture"));
  assert.ok(target.evidenceMeta.evidenceBlock.includes("millerconsulting.io"));
});

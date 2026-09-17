import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBrightDataFreeTier,
  isBrightDataPro,
  getBrightDataCapabilities,
} from "../server/services/brightdata.js";

test("Bright Data capabilities reflect Pro vs Free mode accurately", () => {
  const originalPlan = process.env.BRIGHTDATA_PLAN;
  const originalToken = process.env.BRIGHTDATA_API_TOKEN;
  try {
    process.env.BRIGHTDATA_API_TOKEN = originalToken || "mock-brightdata-token-12345";
    process.env.BRIGHTDATA_PLAN = "pro";
    assert.equal(isBrightDataFreeTier(), false);
    assert.equal(isBrightDataPro(), true);
    const proCaps = getBrightDataCapabilities();
    assert.equal(proCaps.plan, "pro");
    assert.equal(proCaps.rapidModeOnly, false);
    assert.ok(proCaps.supportedTools.includes("search_dataset"));
    assert.ok(proCaps.supportedTools.includes("list_dataset_fields"));
    assert.ok(proCaps.supportedTools.includes("web_data_linkedin_person_profile"));
    assert.ok(proCaps.supportedTools.includes("web_data_linkedin_company_profile"));
    assert.ok(proCaps.supportedTools.includes("scrape_as_html"));

    process.env.BRIGHTDATA_PLAN = "free";
    assert.equal(isBrightDataFreeTier(), true);
    assert.equal(isBrightDataPro(), false);
    const freeCaps = getBrightDataCapabilities();
    assert.equal(freeCaps.rapidModeOnly, true);
  } finally {
    process.env.BRIGHTDATA_PLAN = originalPlan;
    process.env.BRIGHTDATA_API_TOKEN = originalToken;
  }
});

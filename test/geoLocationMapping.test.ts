import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBrightDataGeoLocation } from "../server/services/brightdata.js";

test("normalizeBrightDataGeoLocation maps country names and standard abbreviations to ISO-2 codes", () => {
  assert.equal(normalizeBrightDataGeoLocation("USA"), "us");
  assert.equal(normalizeBrightDataGeoLocation("United States"), "us");
  assert.equal(normalizeBrightDataGeoLocation("us"), "us");
  assert.equal(normalizeBrightDataGeoLocation("UK"), "gb");
  assert.equal(normalizeBrightDataGeoLocation("United Kingdom"), "gb");
  assert.equal(normalizeBrightDataGeoLocation("Canada"), "ca");
  assert.equal(normalizeBrightDataGeoLocation("Australia"), "au");
  assert.equal(normalizeBrightDataGeoLocation("Germany"), "de");
  assert.equal(normalizeBrightDataGeoLocation("France"), "fr");
  assert.equal(normalizeBrightDataGeoLocation("Netherlands"), "nl");
  assert.equal(normalizeBrightDataGeoLocation(""), "");
});

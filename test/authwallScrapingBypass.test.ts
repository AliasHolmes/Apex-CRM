import test from "node:test";
import assert from "node:assert/strict";
import {
  isAuthwalledUrl,
  scrapeAsMarkdown,
  scrapeBatchAsMarkdown,
} from "../server/services/brightdata.js";

test("isAuthwalledUrl detects LinkedIn, Twitter, Instagram, and social URLs", () => {
  assert.equal(
    isAuthwalledUrl("https://www.linkedin.com/in/alex-smith"),
    true,
  );
  assert.equal(
    isAuthwalledUrl("https://linkedin.com/in/williamhgates"),
    true,
  );
  assert.equal(isAuthwalledUrl("https://twitter.com/jack"), true);
  assert.equal(isAuthwalledUrl("https://x.com/elonmusk"), true);
  assert.equal(isAuthwalledUrl("https://instagram.com/natgeo"), true);

  assert.equal(isAuthwalledUrl("https://apexstudio.io/about"), false);
  assert.equal(isAuthwalledUrl("https://company.com/services"), false);
  assert.equal(isAuthwalledUrl("https://acme-agency.ai"), false);
});

test("scrapeAsMarkdown immediately returns null for authwalled URLs without MCP call", async () => {
  const result = await scrapeAsMarkdown(
    "https://www.linkedin.com/in/alex-smith-12345",
  );
  assert.equal(result, null);
});

test("scrapeBatchAsMarkdown filters out authwalled URLs before scraping", async () => {
  const urls = [
    "https://www.linkedin.com/in/user1",
    "https://www.linkedin.com/in/user2",
  ];
  const results = await scrapeBatchAsMarkdown(urls);
  assert.deepEqual(results, []);
});

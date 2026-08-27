import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
  chunkBrightDataBatchItems,
} from "../server/services/brightdata.js";

test("Bright Data MCP batch limit is hard-capped to at most 5 URLs", () => {
  assert.equal(
    BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
    5,
    "BRIGHTDATA_SCRAPE_BATCH_MAX_URLS must be 5 to strictly satisfy @brightdata/mcp schema",
  );
});

test("chunkBrightDataBatchItems slices 7 URLs into batches of <= 5", () => {
  const urls = [
    "https://www.linkedin.com/in/url1",
    "https://www.linkedin.com/in/url2",
    "https://www.linkedin.com/in/url3",
    "https://www.linkedin.com/in/url4",
    "https://www.linkedin.com/in/url5",
    "https://www.linkedin.com/in/url6",
    "https://www.linkedin.com/in/url7",
  ];

  const batches = chunkBrightDataBatchItems(urls);
  assert.equal(batches.length, 2, "7 URLs should produce 2 batches");
  assert.equal(batches[0].length, 5, "First batch must have 5 URLs");
  assert.equal(batches[1].length, 2, "Second batch must have 2 URLs");
  for (const batch of batches) {
    assert.ok(
      batch.length <= 5,
      `Batch length ${batch.length} exceeds Bright Data MCP max limit of 5`,
    );
  }
});

test("chunkBrightDataBatchItems slices 12 URLs into batches of <= 5", () => {
  const urls = Array.from(
    { length: 12 },
    (_, i) => `https://www.linkedin.com/in/lead${i}`,
  );
  const batches = chunkBrightDataBatchItems(urls);
  assert.equal(batches.length, 3, "12 URLs should produce 3 batches (5, 5, 2)");
  assert.deepEqual(
    batches.map((b) => b.length),
    [5, 5, 2],
  );
});

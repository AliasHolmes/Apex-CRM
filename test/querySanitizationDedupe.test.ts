import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeQueryText } from "../server/leadSearch/strategist.js";

test("sanitizeQueryText strips trailing/leading conjunctions and deduplicates words", () => {
  assert.equal(
    sanitizeQueryText("founder marketing agency Canada Founder or"),
    "founder marketing agency Canada",
  );

  assert.equal(
    sanitizeQueryText("owner AI agency Austin USA owner"),
    "owner AI agency Austin USA",
  );

  assert.equal(
    sanitizeQueryText("and founder B2B SaaS New York with"),
    "founder B2B SaaS New York",
  );

  assert.equal(
    sanitizeQueryText("site:linkedin.com/in/ founder AI startup AND Austin"),
    "founder AI startup Austin",
  );
});

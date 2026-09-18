import { test } from "node:test";
import assert from "node:assert/strict";
import { toDatasetFilter } from "../server/leadSearch/strategist.js";

test("toDatasetFilter extracts domain keywords into about filter", () => {
  const planItem = {
    query: "site:linkedin.com/in/ \"AI agency\" \"founder\" \"Austin\"",
    country: "US",
  };

  const filter: any = toDatasetFilter(planItem);
  assert.ok(filter);
  assert.equal(filter.operator, "and");
  assert.ok(Array.isArray(filter.filters));

  const posFilter = filter.filters.find((f: any) => f.name === "position");
  assert.ok(posFilter, "Expected position filter");
  assert.equal(posFilter.value, "Founder");

  const cityFilter = filter.filters.find((f: any) => f.name === "city");
  assert.ok(cityFilter, "Expected city filter");
  assert.equal(cityFilter.value, "Austin");

  const aboutFilter = filter.filters.find((f: any) => f.name === "about");
  assert.ok(aboutFilter, "Expected about domain keyword filter");
  assert.equal(aboutFilter.operator, "includes");
  assert.ok(aboutFilter.value.includes("ai"), "Expected about value to include 'ai'");
});

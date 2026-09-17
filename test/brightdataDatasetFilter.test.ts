import { test } from "node:test";
import assert from "node:assert/strict";
import { toDatasetFilter } from "../server/leadSearch/strategist.js";

test("toDatasetFilter translates founder query with location to valid filter tree", () => {
  const planItem = {
    query: "AI startup founders Austin",
    country: "US",
  };
  const filter: any = toDatasetFilter(planItem);
  assert.ok(filter);
  assert.equal(filter.operator, "and");
  assert.ok(Array.isArray(filter.filters));

  const countryFilter = filter.filters.find((f: any) => f.name === "country_code");
  assert.ok(countryFilter);
  assert.equal(countryFilter.operator, "=");
  assert.equal(countryFilter.value, "US");

  const positionFilter = filter.filters.find((f: any) => f.name === "position");
  assert.ok(positionFilter);
  assert.equal(positionFilter.operator, "includes");
  assert.equal(positionFilter.value, "Founder");

  const cityFilter = filter.filters.find((f: any) => f.name === "city");
  assert.ok(cityFilter);
  assert.equal(cityFilter.operator, "includes");
  assert.equal(cityFilter.value, "Austin");
});

test("toDatasetFilter handles single field query without group operator", () => {
  const planItem = {
    query: "CTO",
  };
  const filter: any = toDatasetFilter(planItem);
  assert.ok(filter);
  // May be a single leaf or group
  if (filter.filters) {
    const pos = filter.filters.find((f: any) => f.name === "position");
    assert.ok(pos);
    assert.equal(pos.value, "Cto");
  } else {
    assert.equal(filter.name, "position");
    assert.equal(filter.value, "Cto");
  }
});

test("toDatasetFilter normalizes country strings to ISO 2-letter codes", () => {
  const planItem = {
    query: "Head of Product",
    country: "United States",
  };
  const filter: any = toDatasetFilter(planItem);
  assert.ok(filter);
  const countryFilter = filter.filters.find((f: any) => f.name === "country_code");
  assert.ok(countryFilter);
  assert.equal(countryFilter.value, "US");
});

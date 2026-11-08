import test from "node:test";
import assert from "node:assert";
import { verifyDecisionMakerFromEvidence } from "../server/leadSearch/verification.js";
import { findCompanyWebsite } from "../server/leadSearch/companyIntent.js";
import {
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry,
} from "../server/db.js";
import {
  baseMaxRetries,
  baseTimeoutSeconds,
  BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
  BrightDataError,
  brightDataSearchBatch,
  buildBrightDataSearchArguments,
  chunkBrightDataBatchItems,
  classifyBrightDataError,
  createBrightDataMcpStderrFilter,
  executeBrightDataSearchWithEmptyBodyRecovery,
  executeBrightDataSearchWithRetry,
  extractLinkedInProfileUrlFromResult,
  filterBrightDataMcpStderrLine,
  isEmptyBodySerpTransientError,
  normalizeBrightDataGeoLocation,
  normalizeBrightDataUrl,
  parseBingMarkdownResults,
  resetBrightDataModuleState,
  unwrapBrightDataUntrustedContent,
} from "../server/services/brightdata.js";
import * as bd from "../server/services/brightdata.js";
import { extractSchemaOrgSignals } from "../server/leadSearch/siteProbe.js";
import { executeRetrieveStage } from "../server/leadSearch/stages/retrieveStage.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { brightDataFreeTierCapabilities } from "../server/leadSearch/freeTier.js";

test("verifyDecisionMakerFromEvidence accepts founder", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "find me some founders",
    currentTitle: "Founder and CEO",
  });
  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, false);
});

test("extractLinkedInProfileUrlFromResult recovers only person profile URLs", () => {
  assert.equal(
    extractLinkedInProfileUrlFromResult({
      link: "https://www.google.com/search?q=founder",
      snippet:
        "Profile: https://uk.linkedin.com/in/Jane-Doe/?trk=public_profile",
    }),
    "https://linkedin.com/in/jane-doe",
  );
  assert.equal(
    extractLinkedInProfileUrlFromResult({
      link: "https://www.linkedin.com/company/example",
      metadata: { url: "https://linkedin.com/posts/example-123" },
    }),
    "",
  );
  assert.equal(
    extractLinkedInProfileUrlFromResult({
      link: "https://example.com/team/jane-doe",
      title: "Jane Doe | Example AI",
    }),
    "",
  );
});

test("verifyDecisionMakerFromEvidence rejects intern unless requested", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "find me tech leads",
    currentTitle: "Software Engineering Intern",
  });
  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, true);
});

test("verifyDecisionMakerFromEvidence accepts intern if requested", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "find me interns",
    currentTitle: "Software Engineering Intern",
  });
  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, false);
});

test("negative cache works", () => {
  upsertNegativeEnrichmentCacheEntry(
    {
      normalizedUrl: "linkedin.com/in/test-negative",
      linkedinUsername: "test-negative",
      evidenceBlock: "brightdata_login_wall",
      scrapeQuality: "bad",
      sourceProvider: "brightdata",
    },
    1,
  );

  const cacheHit = getNegativeEnrichmentCacheEntry({
    normalizedUrl: "linkedin.com/in/test-negative",
  });
  assert.ok(cacheHit);
  assert.strictEqual(cacheHit.evidenceBlock, "brightdata_login_wall");
  assert.strictEqual(cacheHit.scrapeQuality, "bad");
});

test("post-enrichment decision-maker verification can rescue unclear evidence", () => {
  const initial = verifyDecisionMakerFromEvidence({
    query: "dental clinic owners",
    currentTitle: "Professional",
    evidenceText:
      "LINK: https://linkedin.com/in/example\nTITLE: Example Person",
  });
  const enriched = verifyDecisionMakerFromEvidence({
    query: "dental clinic owners",
    currentTitle: "Professional",
    currentCompany: "Bright Smile Dental",
    evidenceText:
      "LINK: https://linkedin.com/in/example\nHEADLINE: Founder and Practice Owner at Bright Smile Dental",
  });

  assert.ok(initial.confidence < enriched.confidence);
  assert.strictEqual(enriched.titleMatched, true);
  assert.ok(enriched.confidence >= 7);
});

test("post-enrichment verification rejects confirmed weak title", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "agency owners",
    currentTitle: "Marketing Assistant",
    evidenceText:
      "LINK: https://linkedin.com/in/example\nEXPERIENCE: Marketing Assistant at Growth Co",
  });

  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test("decision-maker verification accepts executive acronyms and head roles", () => {
  for (const currentTitle of [
    "CRO",
    "Chief Revenue Officer",
    "CIO",
    "Head of Engineering",
    "VP of Sales",
  ]) {
    const result = verifyDecisionMakerFromEvidence({
      query: "find decision makers",
      currentTitle,
    });

    assert.strictEqual(result.titleMatched, true, currentTitle);
    assert.strictEqual(result.ignoredTitle, false, currentTitle);
    assert.ok(result.confidence >= 7, currentTitle);
  }
});

test("decision-maker verification rejects assistant-to-executive false positive", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "agency owners and CEOs",
    currentTitle: "Assistant to the CEO",
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test("decision-maker verification rejects student organization founder false positive", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "startup founders",
    currentTitle: "Co-Founder at Student Club",
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test("decision-maker verification does not treat product owner as company owner", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "business owners",
    currentTitle: "Product Owner",
  });

  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, false);
  assert.strictEqual(result.confidence, 5);
});

test("decision-maker verification does not treat principal IC titles as buyers", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "technology buyers",
    currentTitle: "Principal Engineer",
  });

  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test("decision-maker verification uses extracted seniority as authority evidence", () => {
  const result = verifyDecisionMakerFromEvidence({
    query: "clinic operators",
    currentTitle: "Professional",
    seniorityLevel: "Founder-Owner",
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, false);
  assert.ok(result.confidence >= 7);
});

test("findCompanyWebsite rejects social and job-board URLs and chooses official site", async () => {
  const website = await findCompanyWebsite({
    companyName: "Bright Smile Dental",
    location: "Austin",
    brightDataSearch: async () => [
      {
        title: "Bright Smile Dental | LinkedIn",
        url: "https://linkedin.com/company/bright-smile-dental",
        content: "Company page",
      },
      {
        title: "Bright Smile Dental jobs",
        url: "https://indeed.com/cmp/bright-smile-dental",
        content: "Jobs",
      },
      {
        title: "Bright Smile Dental - Family Dentistry",
        url: "https://brightsmiledental.com",
        content: "Official website for Bright Smile Dental in Austin",
      },
    ],
  });

  assert.strictEqual(website, "https://brightsmiledental.com");
});

test("findCompanyWebsite returns null when only blocked domains are present", async () => {
  const website = await findCompanyWebsite({
    companyName: "Blocked Co",
    brightDataSearch: async () => [
      {
        title: "Blocked Co | LinkedIn",
        url: "https://linkedin.com/company/blocked-co",
        content: "Company page",
      },
      {
        title: "Blocked Co reviews",
        url: "https://yelp.com/biz/blocked-co",
        content: "Reviews",
      },
    ],
  });

  assert.strictEqual(website, null);
});

test("findCompanyWebsite rejects one-label and news-article domains that only mention the company", async () => {
  const website = await findCompanyWebsite({
    companyName: "Cal AI",
    location: "Miami",
    brightDataSearch: async () => [
      {
        title: "Cal AI founder profile",
        url: "https://cnbc.com/young-founder-cal-ai",
        content: "Cal AI founder interview",
      },
      {
        title: "GoTo official",
        url: "https://goto/",
        content: "Cal AI partner",
      },
      {
        title: "Cal AI official website",
        url: "https://cal.ai",
        content: "Official Cal AI product site",
      },
    ],
  });

  assert.strictEqual(website, "https://cal.ai");
});

test("Bright Data classifies target gateway and malformed search responses as retryable target transients", () => {
  for (const message of [
    "HTTP 502 Bad Gateway",
    "status 503 Service Unavailable",
    "504 Gateway Timeout",
    "fetch failed",
    "Bright Data scrape_as_markdown returned empty body",
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, "target_transient");
    assert.strictEqual(classified.retryable, true);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, false);
  }
});

test("Bright Data classifies SERP non-JSON response (challenge page) as non-retryable target transient", () => {
  // Per official BD docs: HTTP 502 "verifying" (challenge page) requires >=15s wait before retry.
  // Any retry < 15s triggers failed_query_rejected lockout. Mark non-retryable -> Tavily fallback.
  for (const message of [
    "Unexpected non-JSON response from Bright Data for search_engine.",
    "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: <html>",
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, "target_transient");
    assert.strictEqual(classified.retryable, false);
    assert.strictEqual(classified.providerDisabled, false);
  }
});

test("Bright Data search retry recovers one transient gateway error", async () => {
  let attempts = 0;
  const retries: number[] = [];
  let retryNotifications = 0;
  const result = await executeBrightDataSearchWithRetry(
    async (attempt) => {
      attempts = attempt;
      if (attempt === 1) throw new Error("HTTP 502 Bad Gateway");
      return ["recovered"];
    },
    {
      maxRetries: 1,
      baseDelayMs: 0,
      jitterMs: 0,
      sleep: async (delayMs) => {
        retries.push(delayMs);
      },
      onRetry: () => {
        retryNotifications++;
      },
    },
  );

  assert.deepStrictEqual(result, ["recovered"]);
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(retries, [0]);
  assert.strictEqual(retryNotifications, 1);
});

test("Bright Data search retry stops after two physical attempts on retryable gateway error", async () => {
  let attempts = 0;
  await assert.rejects(
    executeBrightDataSearchWithRetry(
      async (attempt) => {
        attempts = attempt;
        throw new Error("HTTP 502 Bad Gateway");
      },
      { maxRetries: 1, baseDelayMs: 0, jitterMs: 0, sleep: async () => {} },
    ),
    (error: unknown) =>
      error instanceof BrightDataError &&
      error.reasonCode === "target_transient",
  );
  assert.strictEqual(attempts, 2);
});

test("Bright Data search retry never repeats non-retryable failures", async () => {
  for (const message of [
    "401 unauthorized invalid token",
    "quota credits exhausted",
    "HTTP 400 Request validation failed",
    // Non-JSON SERP = BD challenge/verification page. Per official docs: 15s wait required before
    // retry, so we mark it non-retryable and fall back to Tavily immediately.
    "Unexpected non-JSON response from Bright Data for search_engine.",
    "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: <html>",
    "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: This query recently failed and cannot be attempted at this time. Please try again later, after a minimum of 15 seconds.",
  ]) {
    let attempts = 0;
    await assert.rejects(
      executeBrightDataSearchWithRetry(
        async () => {
          attempts++;
          throw new Error(message);
        },
        { maxRetries: 1, baseDelayMs: 0, jitterMs: 0, sleep: async () => {} },
      ),
    );
    assert.strictEqual(attempts, 1, message);
  }
});

test("Bright Data classifies transport failures as retryable client resets", () => {
  for (const message of [
    "Connection closed",
    "SSE stream disconnected",
    "MCP error -32000: process exited",
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, "transport_transient");
    assert.strictEqual(classified.retryable, true);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, true);
  }
});

test("Bright Data classifies auth and quota failures as provider disabled", () => {
  for (const message of [
    "401 unauthorized invalid token",
    "403 forbidden",
    "quota credits exhausted",
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.providerDisabled, true);
    assert.ok(
      ["provider_auth", "provider_quota"].includes(classified.reasonCode),
    );
  }
});

test("Bright Data timeout and retry env defaults and clamps match MCP recommendations", (t) => {
  const oldBaseTimeout = process.env.BASE_TIMEOUT;
  const oldBrightDataTimeout = process.env.BRIGHTDATA_BASE_TIMEOUT;
  const oldRetries = process.env.BASE_MAX_RETRIES;
  t.after(() => {
    if (oldBaseTimeout === undefined) delete process.env.BASE_TIMEOUT;
    else process.env.BASE_TIMEOUT = oldBaseTimeout;
    if (oldBrightDataTimeout === undefined)
      delete process.env.BRIGHTDATA_BASE_TIMEOUT;
    else process.env.BRIGHTDATA_BASE_TIMEOUT = oldBrightDataTimeout;
    if (oldRetries === undefined) delete process.env.BASE_MAX_RETRIES;
    else process.env.BASE_MAX_RETRIES = oldRetries;
  });

  delete process.env.BASE_TIMEOUT;
  delete process.env.BRIGHTDATA_BASE_TIMEOUT;
  delete process.env.BASE_MAX_RETRIES;
  assert.strictEqual(baseTimeoutSeconds(), 180);
  assert.strictEqual(baseMaxRetries(), 2);

  process.env.BRIGHTDATA_BASE_TIMEOUT = "90";
  assert.strictEqual(baseTimeoutSeconds(), 90);
  process.env.BASE_TIMEOUT = "240";
  assert.strictEqual(baseTimeoutSeconds(), 240);
  process.env.BASE_MAX_RETRIES = "9";
  assert.strictEqual(baseMaxRetries(), 3);
  process.env.BASE_MAX_RETRIES = "-1";
  assert.strictEqual(baseMaxRetries(), 0);
});

test("Bright DataError preserves explicit classifier metadata", () => {
  const original = new BrightDataError("empty response", {
    reasonCode: "target_transient",
    retryable: true,
  });
  assert.strictEqual(classifyBrightDataError(original), original);
});

test("Bright Data treats MCP request validation as non-provider failure", () => {
  for (const message of [
    "MCP error -32602: Tool scrape_batch parameter validation failed: urls: Array must contain at most 5 element(s)",
    'HTTP 400: {"error":"Request validation failed","details":[{"message":"\"url\" must be a valid uri","type":"string.uri"}]}',
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, "request_invalid");
    assert.strictEqual(classified.retryable, false);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, false);
  }
});

test("Bright Data URL normalization encodes LinkedIn unicode slugs before MCP validation", () => {
  const unicodeUrl =
    "https://www.linkedin.com/in/james-pe" +
    String.fromCharCode(241) +
    "as-758a841b";
  assert.strictEqual(
    normalizeBrightDataUrl(unicodeUrl),
    "https://www.linkedin.com/in/james-pe%C3%B1as-758a841b",
  );
  assert.strictEqual(BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, 5);
});

test("Bright Data evidence batching keeps every target within the five-URL tool contract", () => {
  const urls = Array.from(
    { length: 21 },
    (_, index) => `https://example.com/${index + 1}`,
  );
  const batches = chunkBrightDataBatchItems(urls);

  assert.deepStrictEqual(
    batches.map((batch) => batch.length),
    [5, 5, 5, 5, 1],
  );
  assert.deepStrictEqual(batches.flat(), urls);
});

test("Bright Data search arguments match the installed MCP search_engine schema", () => {
  assert.strictEqual(normalizeBrightDataGeoLocation("US"), "us");
  assert.strictEqual(normalizeBrightDataGeoLocation("United States"), "us");
  assert.deepStrictEqual(
    buildBrightDataSearchArguments("AI founders", {
      country: "US",
      page: 1,
    }),
    {
      query: "AI founders",
      engine: "google",
      country: "us",
      page: 1,
    },
  );
});

const originalConnect = Client.prototype.connect;
const originalCallTool = Client.prototype.callTool;
const originalListTools = Client.prototype.listTools;
const BRIGHTDATA_MANAGED_KEYS = [
  "BRIGHTDATA_API_TOKEN",
  "BRIGHTDATA_PLAN",
  "BRIGHTDATA_MCP_TRANSPORT",
  "BRIGHTDATA_DATASET_ID",
  "BRIGHTDATA_SNAPSHOT_ID",
] as const;

const brightDataEnvSnapshot: Record<string, string | undefined> = {};
for (const key of BRIGHTDATA_MANAGED_KEYS) {
  brightDataEnvSnapshot[key] = process.env[key];
}

function restoreMocks() {
  Client.prototype.connect = originalConnect;
  Client.prototype.callTool = originalCallTool;
  Client.prototype.listTools = originalListTools;
  for (const key of BRIGHTDATA_MANAGED_KEYS) {
    if (brightDataEnvSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = brightDataEnvSnapshot[key] as string;
    }
  }
  resetBrightDataModuleState();
}

test("scrape_batch actually invoked on free tier when listTools() advertises it", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return {
      tools: [
        {
          name: "scrape_batch",
          description: "Scrape batch of URLs",
          inputSchema: {} as any,
        },
      ],
    };
  };

  let callToolName = "";
  let callToolArgs: any = null;
  Client.prototype.callTool = async (params) => {
    callToolName = params.name;
    callToolArgs = params.arguments;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { url: "https://example.com/1", markdown: "content 1" },
          ]),
        },
      ],
    } as any;
  };

  const results = await bd.scrapeBatchAsMarkdown(["https://example.com/1"]);

  assert.strictEqual(callToolName, "scrape_batch");
  assert.deepStrictEqual(callToolArgs, { urls: ["https://example.com/1"] });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].url, "https://example.com/1");
  assert.strictEqual(results[0].content, "content 1");

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.detected, true);
  assert.strictEqual(status.batchTool.runtimeVerified, true);
});

test("Free-mode isBrightDataFreeTier guard no longer short-circuits batch scraping", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  let listToolsCalled = false;
  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    listToolsCalled = true;
    return {
      tools: [
        {
          name: "scrape_batch",
          description: "Scrape batch of URLs",
          inputSchema: {} as any,
        },
      ],
    };
  };
  Client.prototype.callTool = async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { url: "https://example.com/1", markdown: "content 1" },
          ]),
        },
      ],
    } as any;
  };

  await bd.scrapeBatchAsMarkdown(["https://example.com/1"]);

  assert.strictEqual(listToolsCalled, true);
});

test("scrape_batch falls back to parallel single-page when scrape_batch is NOT advertised", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return {
      tools: [
        {
          name: "scrape_as_markdown",
          description: "Scrape single URL",
          inputSchema: {} as any,
        },
      ],
    };
  };

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    return {
      content: [{ type: "text", text: "single page content" }],
    } as any;
  };

  const results = await bd.scrapeBatchAsMarkdown([
    "https://example.com/1",
    "https://example.com/2",
  ]);

  assert.ok(toolCalls.includes("scrape_as_markdown"));
  assert.strictEqual(toolCalls.includes("scrape_batch"), false);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].content, "single page content");

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.detected, false);
  assert.strictEqual(status.batchTool.fallbackMode, "single_page_parallel");
});

test("Per-child partial-failure retry in batch scrape path", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return {
      tools: [
        {
          name: "scrape_batch",
          description: "Scrape batch of URLs",
          inputSchema: {} as any,
        },
      ],
    };
  };

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    if (params.name === "scrape_batch") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { url: "https://example.com/1", markdown: "valid content" },
              { url: "https://example.com/2", markdown: "" }, // failed/empty child
            ]),
          },
        ],
      } as any;
    }
    if (params.name === "scrape_as_markdown") {
      return {
        content: [{ type: "text", text: "retried single page content" }],
      } as any;
    }
    return { content: [] } as any;
  };

  const results = await bd.scrapeBatchAsMarkdown([
    "https://example.com/1",
    "https://example.com/2",
  ]);

  assert.ok(toolCalls.includes("scrape_batch"));
  assert.ok(toolCalls.includes("scrape_as_markdown"));
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].url, "https://example.com/1");
  assert.strictEqual(results[0].content, "valid content");
  assert.strictEqual(results[1].url, "https://example.com/2");
  assert.strictEqual(results[1].content, "retried single page content");

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.partialFailures, 1);
  assert.strictEqual(status.batchTool.partialSuccesses, 2);
});

test("Batch scraping retries a requested URL that the provider omits entirely", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "scrape_batch",
        description: "Scrape batch of URLs",
        inputSchema: {} as any,
      },
    ],
  });

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    if (params.name === "scrape_batch") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { url: "https://example.com/1", markdown: "valid content" },
            ]),
          },
        ],
      } as any;
    }
    return {
      content: [{ type: "text", text: "recovered omitted page" }],
    } as any;
  };

  const results = await bd.scrapeBatchAsMarkdown([
    "https://example.com/1",
    "https://example.com/2",
  ]);

  assert.deepStrictEqual(toolCalls, ["scrape_batch", "scrape_as_markdown"]);
  assert.deepStrictEqual(
    results.map((result: { url: string }) => result.url),
    ["https://example.com/1", "https://example.com/2"],
  );
  assert.strictEqual(results[1].content, "recovered omitted page");

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.partialFailures, 1);
  assert.strictEqual(status.batchTool.partialSuccesses, 2);
});

test("brightDataFreeTierCapabilities unavailable no longer lists scrape_batch", () => {
  const cap = brightDataFreeTierCapabilities();
  assert.strictEqual(cap.unavailable.includes("scrape_batch"), false);
  assert.strictEqual(cap.supported.includes("scrape_batch"), true);
});

test("empty-body SERP transients are detected separately from challenge pages", () => {
  // Empty 200 body: no "Response snippet" -> momentary hiccup the service can self-heal.
  assert.strictEqual(
    isEmptyBodySerpTransientError(
      new Error(
        "Tool 'search_engine' execution failed: Unexpected non-JSON response from Bright Data for search_engine.",
      ),
    ),
    true,
  );
  assert.strictEqual(
    isEmptyBodySerpTransientError(
      new Error(
        "Unexpected non-JSON response from Bright Data for search_engine.",
      ),
    ),
    true,
  );
  // Challenge page / lockout snippets must NOT be retried (>=15s BD per-query lockout).
  assert.strictEqual(
    isEmptyBodySerpTransientError(
      new Error(
        "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: <html>",
      ),
    ),
    false,
  );
  assert.strictEqual(
    isEmptyBodySerpTransientError(
      new Error(
        "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: This query recently failed and cannot be attempted at this time.",
      ),
    ),
    false,
  );
  assert.strictEqual(
    isEmptyBodySerpTransientError(new Error("HTTP 502 Bad Gateway")),
    false,
  );
});

test("empty-body recovery retries once internally then succeeds silently", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const retried: number[] = [];
  const result = await executeBrightDataSearchWithEmptyBodyRecovery(
    async () => {
      attempts++;
      if (attempts === 1)
        throw new Error(
          "Unexpected non-JSON response from Bright Data for search_engine.",
        );
      return ["recovered"];
    },
    {
      delayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: ({ attempt }) => {
        retried.push(attempt);
      },
    },
  );

  assert.deepStrictEqual(result, ["recovered"]);
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(sleeps, [5]);
  assert.deepStrictEqual(retried, [1]);
});

test("empty-body recovery never retries challenge or lockout variants", async () => {
  for (const message of [
    "Unexpected non-JSON response from Bright Data for search_engine. Response snippet: <html>",
    "Tool 'search_engine' execution failed: Unexpected non-JSON response from Bright Data for search_engine. Response snippet: This query recently failed and cannot be attempted at this time. Please try again later, after a minimum of 15 seconds.",
  ]) {
    let attempts = 0;
    await assert.rejects(
      executeBrightDataSearchWithEmptyBodyRecovery(
        async () => {
          attempts++;
          throw new Error(message);
        },
        { maxRetries: 1, delayMs: 0 },
      ),
    );
    assert.strictEqual(attempts, 1, message);
  }
});

test("empty-body recovery respects maxRetries=0 and passes other errors straight through", async () => {
  let emptyAttempts = 0;
  await assert.rejects(
    executeBrightDataSearchWithEmptyBodyRecovery(
      async () => {
        emptyAttempts++;
        throw new Error(
          "Unexpected non-JSON response from Bright Data for search_engine.",
        );
      },
      { maxRetries: 0, delayMs: 0 },
    ),
  );
  assert.strictEqual(emptyAttempts, 1);

  let otherAttempts = 0;
  await assert.rejects(
    executeBrightDataSearchWithEmptyBodyRecovery(
      async () => {
        otherAttempts++;
        throw new Error("HTTP 502 Bad Gateway");
      },
      { maxRetries: 2, delayMs: 0 },
    ),
  );
  assert.strictEqual(otherAttempts, 1);
});

test("MCP stderr filter drops handled transient error blocks including stack frames", () => {
  const state = createBrightDataMcpStderrFilter();
  const lines = [
    '[search_engine] executing (client=apex-crm-brightdata) {"query":"x","engine":"google","geo_location":"us"}',
    "[search_engine] error Error: Unexpected non-JSON response from Bright Data for search_engine.",
    "    at parse_google_search_response (file:///D:/work/AI/Apex%20crm/node_modules/@brightdata/mcp/search_utils.js:38:15)",
    "    at async Object.execute (file:///D:/work/AI/Apex%20crm/node_modules/@brightdata/mcp/server.js:1318:22)",
    "[search_engine] tool finished in 11122ms",
    '[search_engine] executing (client=apex-crm-brightdata) {"query":"y"}',
    "[search_engine] error Error: Unexpected non-JSON response from Bright Data for search_engine. Response snippet: This query recently failed and cannot be attempted at this time.",
    "[brightdata] zone check failed: real problem kept visible",
  ];
  const kept = lines.filter((line) =>
    filterBrightDataMcpStderrLine(state, line),
  );
  assert.deepStrictEqual(kept, [lines[0], lines[4], lines[5], lines[7]]);
  assert.strictEqual(state.droppedLines, 4);
});

test("parseBingMarkdownResults extracts organic search results and ignores navigation links", () => {
  const markdown = `
# Bing Search Results

[Skip to main content](https://www.bing.com/search?q=test)
[Microsoft Privacy](https://www.microsoft.com/privacy)

### [Alex Smith - Founder & CEO - TechCorp | LinkedIn](https://www.linkedin.com/in/alexsmith)
Alex Smith is the Founder and CEO of TechCorp, leading innovative AI engineering teams in New York.

### [Jane Doe - Head of AI - DataFlow | LinkedIn](https://www.linkedin.com/in/janedoe)
Experienced AI and Machine Learning leader. Currently scaling generative workflows at DataFlow.

[Next Page](https://www.bing.com/search?q=test&first=11)
`;

  const results = parseBingMarkdownResults(markdown);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(
    results[0].title,
    "Alex Smith - Founder & CEO - TechCorp | LinkedIn",
  );
  assert.strictEqual(results[0].url, "https://www.linkedin.com/in/alexsmith");
  assert.strictEqual(results[0].sourceEngine, "bing");
  assert.ok(results[0].content.includes("Founder and CEO of TechCorp"));
  assert.strictEqual(
    results[1].title,
    "Jane Doe - Head of AI - DataFlow | LinkedIn",
  );
  assert.strictEqual(results[1].url, "https://www.linkedin.com/in/janedoe");
  assert.strictEqual(results[1].sourceEngine, "bing");
  assert.ok(
    results[1].content.includes("Experienced AI and Machine Learning leader"),
  );
});

test("buildBrightDataSearchArguments preserves explicit engine choice", () => {
  const googleArgs = buildBrightDataSearchArguments("test query", {
    engine: "google",
  });
  assert.strictEqual(googleArgs.engine, "google");

  const bingArgs = buildBrightDataSearchArguments("test query", {
    engine: "bing",
  });
  assert.strictEqual(bingArgs.engine, "bing");
});

test("search telemetry tracking distinguishes Google primary vs Bing rescue accurately", async () => {
  const stats = {
    searchAttempted: 0,
    searchSucceeded: 0,
    searchGoogleAttempted: 0,
    searchGoogleSucceeded: 0,
    searchBingAttempted: 0,
    searchBingSucceeded: 0,
    searchBingRecovered: 0,
  };

  const mockBrightDataSearch = async (query: string, options: any = {}) => {
    options.onEngineAttempt?.("google");
    options.onEngineAttempt?.("bing");
    options.onBingFallback?.({ query, resultsCount: 2 });
    return [
      {
        title: "Result 1",
        url: "https://linkedin.com/in/1",
        content: "...",
        sourceProvider: "brightdata_search" as const,
        sourceEngine: "bing" as const,
      },
      {
        title: "Result 2",
        url: "https://linkedin.com/in/2",
        content: "...",
        sourceProvider: "brightdata_search" as const,
        sourceEngine: "bing" as const,
      },
    ];
  };

  const trackableSearch = async (query: string, options: any = {}) => {
    stats.searchAttempted++;
    const results = await mockBrightDataSearch(query, {
      ...options,
      onEngineAttempt: (engine: string) => {
        if (engine === "google") stats.searchGoogleAttempted++;
        else if (engine === "bing") stats.searchBingAttempted++;
        options.onEngineAttempt?.(engine);
      },
      onBingFallback: (evt: any) => {
        stats.searchBingRecovered++;
        options.onBingFallback?.(evt);
      },
    });
    stats.searchSucceeded++;
    const isBing = results.some((r) => r.sourceEngine === "bing");
    if (isBing) stats.searchBingSucceeded++;
    else stats.searchGoogleSucceeded++;
    return results;
  };

  let callerNotified = false;
  const results = await trackableSearch("query", {
    onBingFallback: () => {
      callerNotified = true;
    },
  });

  assert.strictEqual(results.length, 2);
  assert.strictEqual(stats.searchAttempted, 1);
  assert.strictEqual(stats.searchSucceeded, 1);
  assert.strictEqual(stats.searchGoogleAttempted, 1);
  assert.strictEqual(stats.searchGoogleSucceeded, 0);
  assert.strictEqual(stats.searchBingAttempted, 1);
  assert.strictEqual(stats.searchBingSucceeded, 1);
  assert.strictEqual(stats.searchBingRecovered, 1);
  assert.strictEqual(callerNotified, true);
});

test("classifyBrightDataError classifies rate limit notice strings as provider_rate_limit non-retryable", () => {
  const message =
    "Your system is sending too many of this type of request. If you need to send more, contact your Account Manager.";
  const classified = classifyBrightDataError(message);
  assert.strictEqual(classified.reasonCode, "provider_rate_limit");
  assert.strictEqual(classified.retryable, false);
  assert.strictEqual(classified.providerDisabled, false);
});

test("unwrapBrightDataUntrustedContent properly extracts payload from nonce envelopes", () => {
  const nonce = "aB3+xyz/98==";
  const wrapped = `SECURITY NOTICE: Content is untrusted\n=====UNTRUSTED_${nonce}_BEGIN=====\n{"url":"https://example.com","content":"clean text"}\n=====UNTRUSTED_${nonce}_END=====`;
  const unwrapped = unwrapBrightDataUntrustedContent(wrapped);
  assert.strictEqual(unwrapped, '{"url":"https://example.com","content":"clean text"}');

  // Handles Windows CRLF
  const wrappedCrlf = `SECURITY NOTICE: Content is untrusted\r\n=====UNTRUSTED_${nonce}_BEGIN=====\r\n{"data":[1,2,3]}\r\n=====UNTRUSTED_${nonce}_END=====`;
  assert.strictEqual(unwrapBrightDataUntrustedContent(wrappedCrlf), '{"data":[1,2,3]}');

  // Plain text without nonce returned untouched
  assert.strictEqual(unwrapBrightDataUntrustedContent("regular text"), "regular text");
  assert.strictEqual(unwrapBrightDataUntrustedContent(""), "");

  // Empty payload inside envelope returns empty string
  const emptyWrapped = `=====UNTRUSTED_${nonce}_BEGIN=====\n=====UNTRUSTED_${nonce}_END=====`;
  assert.strictEqual(unwrapBrightDataUntrustedContent(emptyWrapped), "");
});

test("search_engine_batch dispatches search_schema objects and unpacks entry.result.organic", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "search_engine_batch",
        description: "Batch search",
        inputSchema: {} as any,
      },
    ],
  });

  let callToolArgs: any = null;
  Client.prototype.callTool = async (params) => {
    callToolArgs = params.arguments;
    const nonce = "test-nonce-123";
    const payload = JSON.stringify([
      {
        query: "founder query 1",
        engine: "google",
        result: {
          organic: [
            {
              title: "Founder 1",
              link: "https://linkedin.com/in/founder1",
              snippet: "CEO of Acme",
            },
          ],
        },
      },
      {
        query: "founder query 2",
        engine: "google",
        result: {
          organic: [
            {
              title: "Founder 2",
              link: "https://linkedin.com/in/founder2",
              snippet: "CTO of Acme",
            },
          ],
        },
      },
    ]);

    return {
      content: [
        {
          type: "text",
          text: `=====UNTRUSTED_${nonce}_BEGIN=====\n${payload}\n=====UNTRUSTED_${nonce}_END=====`,
        },
      ],
    } as any;
  };

  const resultsMap = await brightDataSearchBatch(["founder query 1", "founder query 2"], {
    country: "US",
    page: 1,
  });

  // Verify callTool received array of search_schema objects with country and page
  assert.ok(callToolArgs && Array.isArray(callToolArgs.queries));
  assert.strictEqual(callToolArgs.queries.length, 2);
  assert.deepStrictEqual(callToolArgs.queries[0], {
    query: "founder query 1",
    engine: "google",
    country: "us",
    page: 1,
  });

  // Verify organic results unpacked from entry.result.organic
  assert.strictEqual(resultsMap.size, 2);
  const q1Results = resultsMap.get("founder query 1") || [];
  assert.strictEqual(q1Results.length, 1);
  assert.strictEqual(q1Results[0].title, "Founder 1");
  assert.strictEqual(q1Results[0].url, "https://linkedin.com/in/founder1");

  const q2Results = resultsMap.get("founder query 2") || [];
  assert.strictEqual(q2Results.length, 1);
  assert.strictEqual(q2Results[0].title, "Founder 2");
});

test("extractSchemaOrgSignals parses Organization, address, headcount, founders and socials", () => {
  const htmlWithLdJson = `
    <!DOCTYPE html>
    <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          "name": "Acme Robotics Inc",
          "legalName": "Acme Robotics Incorporated",
          "address": {
            "@type": "PostalAddress",
            "streetAddress": "123 Tech Boulevard",
            "addressLocality": "Austin",
            "addressRegion": "TX",
            "addressCountry": "US"
          },
          "numberOfEmployees": {
            "@type": "QuantitativeValue",
            "value": "75"
          },
          "founder": [
            { "@type": "Person", "name": "Jane Founder" },
            { "@type": "Person", "name": "John Builder" }
          ],
          "sameAs": [
            "https://www.linkedin.com/company/acme-robotics",
            "https://twitter.com/acmerobotics"
          ]
        }
        </script>
      </head>
      <body><h1>Welcome to Acme</h1></body>
    </html>
  `;

  const signals = extractSchemaOrgSignals(htmlWithLdJson);
  assert.strictEqual(signals.companyName, "Acme Robotics Inc");
  assert.strictEqual(signals.legalName, "Acme Robotics Incorporated");
  assert.strictEqual(signals.location, "123 Tech Boulevard, Austin, TX, US");
  assert.strictEqual(signals.headcount, "75");
  assert.strictEqual(signals.founders, "Jane Founder, John Builder");
  assert.ok(signals.socials?.includes("linkedin.com/company/acme-robotics"));
});

test("brightDataGetPersonProfile returns null on error record preventing cache poisoning", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "pro";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "run_scraper",
        description: "Run scraper",
        inputSchema: {} as any,
      },
    ],
  });

  Client.prototype.callTool = async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ready",
            data: [
              {
                url: "https://linkedin.com/in/nonexistent-user",
                error: "Profile not found or blocked by authwall",
              },
            ],
          }),
        },
      ],
    } as any;
  };

  const profile = await bd.brightDataGetPersonProfile("https://linkedin.com/in/nonexistent-user", 50_000);
  assert.strictEqual(profile, null);
});

test("brightDataGetPersonProfile returns null when status remains running", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "pro";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "run_scraper",
        description: "Run scraper",
        inputSchema: {} as any,
      },
      {
        name: "get_scraper_results",
        description: "Get scraper results",
        inputSchema: {} as any,
      },
    ],
  });

  Client.prototype.callTool = async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "running",
            snapshot_id: "snap-123",
          }),
        },
      ],
    } as any;
  };

  process.env.BRIGHTDATA_MIN_PROFILE_TIMEOUT_MS = "100";

  const profile = await bd.brightDataGetPersonProfile("https://linkedin.com/in/slow-enrichment", 100);
  assert.strictEqual(profile, null);
});

test("buildBrightDataSearchArguments clamps negative page and converts numeric cursor", () => {
  const negArgs = buildBrightDataSearchArguments("AI query", {
    page: -1,
    country: "US",
  });
  assert.strictEqual(negArgs.page, 0);

  const cursorArgs = buildBrightDataSearchArguments("AI query", {
    cursor: "3",
    country: "US",
  });
  assert.strictEqual(cursorArgs.page, 3);
});

test("brightDataSearchBatch honors sticky Bing and fires onEngineAttempt", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "search_engine_batch",
        description: "Batch search",
        inputSchema: {} as any,
      },
    ],
  });

  let engineAttempted = "";
  let calledEngineArg = "";
  Client.prototype.callTool = async (params) => {
    const q0 = (params.arguments as any)?.queries?.[0];
    calledEngineArg = q0?.engine;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              query: "test query",
              engine: calledEngineArg,
              result: {
                organic: [
                  { title: "Bing Title", link: "https://example.com/bing" },
                ],
              },
            },
          ]),
        },
      ],
    } as any;
  };

  const res = await brightDataSearchBatch(["test query"], {
    engine: "bing",
    onEngineAttempt: (e) => {
      engineAttempted = e;
    },
  });

  assert.strictEqual(engineAttempted, "bing");
  assert.strictEqual(calledEngineArg, "bing");
  assert.strictEqual(res.get("test query")?.[0]?.title, "Bing Title");
});

test("extractSchemaOrgSignals handles plural founders property and object legalName", () => {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Corporation",
    "name": "Apex AI",
    "legalName": { "@value": "Apex Intelligence Inc" },
    "founders": [
      { "@type": "Person", "name": "Elena Rostova" },
      "Marcus Vance"
    ]
  });

  const signals = extractSchemaOrgSignals(jsonLd);
  assert.strictEqual(signals.companyName, "Apex AI");
  assert.strictEqual(signals.legalName, "Apex Intelligence Inc");
  assert.strictEqual(signals.founders, "Elena Rostova, Marcus Vance");
});

test("executeRetrieveStage falls back to Tavily and records trace when Bright Data batch throws transport failure", async () => {
  const traces: any[] = [];
  const logs: string[] = [];
  let tavilyCalled = false;

  const mockCtx: any = {
    config: {
      sessionId: "test-bd-batch-fail",
      targetLimit: 10,
      contract: {
        brief: "founder",
        policyVersion: "test",
      },
      capacity: {
        candidateBatchSize: 2,
        tavilyPerRound: 1,
        brightDataPerRound: 1,
      },
      creditReservationEnabled: false,
    },
    state: {
      round: 1,
      brightDataStats: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        transportFailures: 0,
        processRestarts: 0,
        failureReasons: {},
      },
      freeTierBudget: {
        reserveBrightDataSearch: () => true,
        reserveTavilySearch: () => true,
      },
      abortController: new AbortController(),
      queryRuns: [
        { index: 0, providerUnits: 0, searchLatencyMs: 0 },
        { index: 1, providerUnits: 0, searchLatencyMs: 0 },
      ],
    },
    ports: {
      brightDataSearchBatch: async () => {
        throw new Error("getaddrinfo ENOTFOUND mcp.brightdata.com");
      },
      brightDataSearch: async () => {
        throw new Error("getaddrinfo ENOTFOUND mcp.brightdata.com");
      },
      tavilySearch: async (_q: string) => {
        tavilyCalled = true;
        return {
          items: [
            {
              title: "Jane Doe - Founder",
              url: "https://www.linkedin.com/in/janedoe",
              content: "Founder at Example",
            },
          ],
        };
      },
    },
    logEvent: (msg: string) => logs.push(msg),
    recordTrace: (event: any) => traces.push(event),
  };

  const roundPlans = [
    {
      executableQuery: "site:linkedin.com/in founder 1",
      item: { provider: "brightdata", priority: 1, tavily: {} },
    },
    {
      executableQuery: "site:linkedin.com/in founder 2",
      item: { provider: "brightdata", priority: 2, tavily: {} },
    },
  ];
  const queryRuns = roundPlans.map((p) => ({
    round: 1,
    query: p.executableQuery,
    rawCandidates: 0,
    searchLatencyMs: 0,
    providerUnits: 0,
  }));

  const input: any = {
    round: 1,
    roundPlans,
    queryRuns,
    discoveryProviderMode: "hybrid",
    brightDataSearchMode: "primary",
    brightDataReady: true,
    brightDataProviderDisabled: false,
    brightDataTransportRetryAfter: 0,
    brightDataSearchRetryMax: 0,
    brightDataSearchRetryBaseDelayMs: 10,
    tavilyCapabilities: { monthlyLimit: 1000, configured: true },
  };

  const output = await executeRetrieveStage(mockCtx, input);
  assert.ok(tavilyCalled, "Tavily fallback should be invoked when Bright Data batch encounters transport failure");
  assert.strictEqual(mockCtx.state.brightDataStats.processRestarts, 1);
  assert.strictEqual(mockCtx.state.brightDataStats.transportFailures, 2);

  const bdErrorTraces = traces.filter(
    (t) => t.operation === "brightdata_search" && t.status === "error",
  );
  assert.strictEqual(bdErrorTraces.length, 2, "Expected 2 brightdata error traces for chunk queries");

  const tavilyTraces = traces.filter(
    (t) => t.operation === "tavily_search" && t.status === "success",
  );
  assert.strictEqual(tavilyTraces.length, 2, "Expected 2 tavily success traces");

  assert.ok(output.roundItems.length > 0, "Expected roundItems from Tavily fallback");
  assert.strictEqual(output.roundItems[0].item.sourceProvider, "tavily");
  assert.strictEqual(output.roundItems[0].item.title, "Jane Doe - Founder");
});

test("brightDataSearchScrapers, getScraperDetails, and refreshScrapers execute successfully", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "pro";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  const calledTools: Array<{ name: string; args: any }> = [];
  Client.prototype.connect = async () => {};
  Client.prototype.callTool = async (params) => {
    calledTools.push({ name: params.name, args: params.arguments });
    if (params.name === "search_scrapers") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { dataset_id: "gd_l1viktl72bvl7bjuj0", name: "LinkedIn Person" },
            ]),
          },
        ],
      } as any;
    }
    if (params.name === "get_scraper_details") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              dataset_id: "gd_l1viktl72bvl7bjuj0",
              method: "collect_by_url",
            }),
          },
        ],
      } as any;
    }
    if (params.name === "refresh_scrapers") {
      return {
        content: [{ type: "text", text: JSON.stringify({ scrapers: 1250 }) }],
      } as any;
    }
    return { content: [] } as any;
  };

  const scrapers = await bd.brightDataSearchScrapers("linkedin", 5);
  assert.strictEqual(scrapers.length, 1);
  assert.strictEqual(scrapers[0].dataset_id, "gd_l1viktl72bvl7bjuj0");
  assert.deepStrictEqual(calledTools[0], {
    name: "search_scrapers",
    args: { query: "linkedin", limit: 5 },
  });

  const details = await bd.brightDataGetScraperDetails(
    "gd_l1viktl72bvl7bjuj0",
    "collect_by_url",
  );
  assert.ok(details);
  assert.strictEqual(details?.dataset_id, "gd_l1viktl72bvl7bjuj0");
  assert.strictEqual(details?.method, "collect_by_url");

  const refresh = await bd.brightDataRefreshScrapers();
  assert.strictEqual(refresh?.scrapers, 1250);
});

test("All 14 Scraping Browser automation wrappers invoke respective FastMCP tools", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "pro";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  const calls: Record<string, any> = {};
  Client.prototype.connect = async () => {};
  Client.prototype.callTool = async (params) => {
    calls[params.name] = params.arguments;
    return {
      content: [{ type: "text", text: `Success for ${params.name}` }],
    } as any;
  };

  await bd.brightDataBrowserNavigate("https://example.com/login", "US");
  assert.ok(calls["scraping_browser_navigate"]);
  assert.strictEqual(calls["scraping_browser_navigate"].country, "US");

  await bd.brightDataBrowserSnapshot(true);
  assert.ok(calls["scraping_browser_snapshot"]);
  assert.strictEqual(calls["scraping_browser_snapshot"].filtered, true);

  await bd.brightDataBrowserClick("ref-12", "Submit Button");
  assert.deepStrictEqual(calls["scraping_browser_click_ref"], {
    ref: "ref-12",
    element: "Submit Button",
  });

  await bd.brightDataBrowserType("ref-15", "Search", "CEO", true);
  assert.deepStrictEqual(calls["scraping_browser_type_ref"], {
    ref: "ref-15",
    element: "Search",
    text: "CEO",
    submit: true,
  });

  await bd.brightDataBrowserFillForm([
    { name: "email", type: "textbox", ref: "1", value: "test@example.com" },
  ]);
  assert.strictEqual(calls["scraping_browser_fill_form"].fields.length, 1);

  await bd.brightDataBrowserWaitForRef("ref-20", "Header", 5000);
  assert.deepStrictEqual(calls["scraping_browser_wait_for_ref"], {
    ref: "ref-20",
    element: "Header",
    timeout: 5000,
  });

  await bd.brightDataBrowserScroll();
  assert.ok("scraping_browser_scroll" in calls);

  await bd.brightDataBrowserScrollToRef("ref-99", "Footer");
  assert.deepStrictEqual(calls["scraping_browser_scroll_to_ref"], {
    ref: "ref-99",
    element: "Footer",
  });

  await bd.brightDataBrowserGetText();
  assert.ok("scraping_browser_get_text" in calls);

  await bd.brightDataBrowserGetHtml(true);
  assert.deepStrictEqual(calls["scraping_browser_get_html"], { full_page: true });

  await bd.brightDataBrowserScreenshot(false);
  assert.deepStrictEqual(calls["scraping_browser_screenshot"], { full_page: false });

  await bd.brightDataBrowserNetworkRequests();
  assert.ok("scraping_browser_network_requests" in calls);

  await bd.brightDataBrowserGoBack();
  assert.ok("scraping_browser_go_back" in calls);

  await bd.brightDataBrowserGoForward();
  assert.ok("scraping_browser_go_forward" in calls);
});

test("scrapeBatchAsMarkdown and brightDataScrapeAsLdJson support ld_json, html, and text formats", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "free";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      {
        name: "scrape_batch",
        description: "Scrape batch of URLs",
        inputSchema: {} as any,
      },
      {
        name: "scrape_as_markdown",
        description: "Scrape single URL",
        inputSchema: {} as any,
      },
    ],
  });

  let batchArgsCalled: any = null;
  let singleArgsCalled: any = null;
  Client.prototype.callTool = async (params) => {
    if (params.name === "scrape_batch") {
      batchArgsCalled = params.arguments;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                url: "https://example.com/data",
                content: '{"@type":"Organization","name":"Acme"}',
                format: "ld_json",
              },
            ]),
          },
        ],
      } as any;
    }
    if (params.name === "scrape_as_markdown") {
      singleArgsCalled = params.arguments;
      const args = (params.arguments || {}) as Record<string, any>;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: args.url,
              content: '{"@type":"Corporation","name":"SoloCorp"}',
              format: args.format,
            }),
          },
        ],
      } as any;
    }
    return { content: [] } as any;
  };

  const batchResults = await bd.scrapeBatchAsMarkdown(
    ["https://example.com/data"],
    undefined,
    undefined,
    "ld_json",
  );
  assert.strictEqual(batchResults.length, 1);
  assert.strictEqual(batchResults[0].format, "ld_json");
  assert.deepStrictEqual(batchArgsCalled, {
    urls: ["https://example.com/data"],
    format: "ld_json",
  });

  const singleLdJson = await bd.brightDataScrapeAsLdJson("https://example.com/ld");
  assert.ok(singleLdJson);
  assert.strictEqual(singleArgsCalled.format, "ld_json");

  const singleText = await bd.brightDataScrapeAsText("https://example.com/text");
  assert.ok(singleText);
  assert.strictEqual(singleArgsCalled.format, "text");
});

test("getBrightDataCapabilities surfaces all 30 Pro tools and integrates runtime listTools discovery", async (t) => {
  t.after(restoreMocks);
  resetBrightDataModuleState();
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_PLAN = "pro";
  process.env.BRIGHTDATA_MCP_TRANSPORT = "local";

  assert.strictEqual(bd.BRIGHTDATA_PRO_SUPPORTED_TOOLS.length, 30);
  assert.ok(bd.BRIGHTDATA_PRO_SUPPORTED_TOOLS.includes("scraping_browser_navigate"));
  assert.ok(bd.BRIGHTDATA_PRO_SUPPORTED_TOOLS.includes("search_scrapers"));
  assert.ok(bd.BRIGHTDATA_PRO_SUPPORTED_TOOLS.includes("chatgpt_ai_insights"));

  const initialCaps = bd.getBrightDataCapabilities();
  assert.strictEqual(initialCaps.plan, "pro");
  if (initialCaps.plan === "pro") {
    assert.ok(initialCaps.supportedTools.includes("scraping_browser_fill_form"));
    assert.ok(initialCaps.supportedTools.includes("get_scraper_details"));
  }

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [
      { name: "custom_account_tool", inputSchema: {} as any },
      { name: "search_engine", inputSchema: {} as any },
    ],
  });

  const discoveredCaps = await bd.discoverBrightDataCapabilities();
  assert.ok(discoveredCaps.discoveredTools);
  assert.ok(discoveredCaps.discoveredTools.includes("custom_account_tool"));
  if (discoveredCaps.plan === "pro") {
    assert.ok(discoveredCaps.supportedTools.includes("custom_account_tool"));
    assert.ok(discoveredCaps.unavailableTools.includes("scraping_browser_fill_form"));
  }
});


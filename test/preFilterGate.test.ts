import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSnippetNoise, buildCleanEvidence } from "../server/leadSearch/stages/extractStage.js";
import { canonicalLinkedInIdentity, getLinkedInHandle, isValidLinkedInHandle } from "../src/utils/leadDedupe.js";

test("Fast Pre-Filter Gate: extracts LinkedIn handles and canonical identities correctly", () => {
  const profileUrl = "https://www.linkedin.com/in/alex-smith-tech";
  const handle = getLinkedInHandle(profileUrl);
  assert.equal(handle, "alex-smith-tech");
  assert.equal(isValidLinkedInHandle(handle), true);
  assert.equal(canonicalLinkedInIdentity(profileUrl), "linkedin:alex-smith-tech");

  const postUrl = "https://www.linkedin.com/posts/johndoe_ai-automation-activity-123456";
  assert.equal(getLinkedInHandle(postUrl), "johndoe");
  assert.equal(canonicalLinkedInIdentity(postUrl), "linkedin:johndoe");

  const nonLinkedInUrl = "https://techcrunch.com/2025/02/ai-agencies-uk-funding";
  assert.equal(getLinkedInHandle(nonLinkedInUrl), "");
  assert.equal(canonicalLinkedInIdentity(nonLinkedInUrl), "");
});

test("Fast Pre-Filter Gate: snippet cleaning removes HTML noise and cookie notices", () => {
  const noisySnippet = `
    <div>Welcome to our AI agency.</div>
    <span>Cookie Settings | Accept All | Privacy Policy</span>
    We specialize in bespoke enterprise LLM workflows &amp; AI consulting.
    <a href="/terms">Terms of Service</a>
  `;
  const cleaned = cleanSnippetNoise(noisySnippet);
  assert.ok(!cleaned.includes("<div>"));
  assert.ok(!cleaned.includes("Cookie Settings"));
  assert.ok(!cleaned.includes("&amp;"));
  assert.ok(cleaned.includes("We specialize in bespoke enterprise LLM workflows"));
});

test("Fast Pre-Filter Gate: buildCleanEvidence formats compact, noise-free block", () => {
  const item = {
    url: "https://www.linkedin.com/in/test-founder",
    title: "Founder &amp; CEO - NextGen AI",
    content: "<p>We help businesses implement generative AI agents. Cookie Settings Accept All.</p>",
  };
  const block = buildCleanEvidence(item);
  assert.ok(block.includes("LINK: https://www.linkedin.com/in/test-founder"));
  assert.ok(block.includes("Founder"));
  assert.ok(!block.includes("<p>"));
  assert.ok(!block.includes("Cookie Settings"));
  assert.ok(block.includes("We help businesses implement generative AI agents."));
});

test("Fast Pre-Filter Gate: snippet rescue duplicate detection catches existing CRM identity", () => {
  const existingCrmKeys = new Set(["linkedin:rescued-lead"]);
  const snippet = "Check out our profile at https://www.linkedin.com/in/rescued-lead for more info.";
  const match = snippet.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9_\u0080-\uffff-]+/i);
  assert.ok(match?.[0]);
  const rescuedUrl = match[0];
  const identity = canonicalLinkedInIdentity(rescuedUrl);
  assert.equal(identity, "linkedin:rescued-lead");
  assert.equal(existingCrmKeys.has(identity), true);
});


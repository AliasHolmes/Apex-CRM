import test from "node:test";
import assert from "node:assert/strict";

import { buildOutboundPrompt } from "../server/services/outboundPrompt.js";

test("generate-outbound includes mined evidence, qualification context, and notes in prompt structure", () => {
  const mockLead = {
    profile: {
      fullName: "Marcus Vance",
      currentTitle: "VP of Engineering",
      currentCompany: "Hyperion Cloud",
      industry: "Enterprise Software",
      location: "Seattle, WA",
      summary: "Leading multi-cloud engineering infrastructure.",
    },
    evidence: {
      snippets: [
        "Hyperion Cloud recently completed a $25M Series B expansion.",
        "Engineering team scaled from 20 to 65 developers in the last 6 months.",
      ],
      evidenceBlock: "Full scraped summary of cloud migration case studies.",
    },
    qualification: {
      verdict: "qualified",
      explanation: "Direct VP decision maker managing 50+ engineers with active hiring intent.",
    },
    notes: "Follow up regarding Kubernetes observability pipeline.",
  };

  const prompt = buildOutboundPrompt({
    profile: mockLead.profile,
    evidence: mockLead.evidence,
    qualification: mockLead.qualification,
    notes: mockLead.notes,
  });

  // Assert prompt composition logic includes all grounded context
  assert.ok(prompt.includes("Marcus Vance"));
  assert.ok(prompt.includes("Hyperion Cloud"));
  assert.ok(prompt.includes("Series B expansion"));
  assert.ok(prompt.includes("scaled from 20 to 65"));
  assert.ok(prompt.includes("Direct VP decision maker"));
  assert.ok(prompt.includes("Kubernetes observability pipeline"));
});

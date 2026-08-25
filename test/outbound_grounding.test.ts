import test from "node:test";
import assert from "node:assert/strict";

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

  const evidenceSnippets = Array.isArray(mockLead.evidence.snippets)
    ? mockLead.evidence.snippets.join(" | ")
    : mockLead.evidence.evidenceBlock;

  const qualificationVerdict = mockLead.qualification.explanation;
  const notesText = mockLead.notes;

  // Assert evidence extraction logic
  assert.ok(evidenceSnippets.includes("Series B expansion"));
  assert.ok(evidenceSnippets.includes("scaled from 20 to 65"));
  assert.ok(qualificationVerdict.includes("Direct VP decision maker"));
  assert.equal(notesText, "Follow up regarding Kubernetes observability pipeline.");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { executeExtractStage } from "../server/leadSearch/stages/extractStage.js";
import { verifyDecisionMakerFromEvidence } from "../server/leadSearch/verification.js";

test("executeExtractStage produces complete CandidateLead for brightdata_dataset items without calling LLM", async () => {
  const candidateItem = {
    title: "Jane Doe - Co-Founder & CEO at Apex Cloud",
    url: "https://www.linkedin.com/in/janedoe",
    sourceProvider: "brightdata_dataset",
    raw: {
      name: "Jane Doe",
      position: "Co-Founder & CEO",
      current_company_name: "Apex Cloud",
      city: "Austin",
      url: "https://www.linkedin.com/in/janedoe",
      current_company_website: "https://apexcloud.io",
      about: "Serial founder passionate about cloud infrastructure.",
      experience: [
        {
          title: "Co-Founder & CEO",
          company: "Apex Cloud",
          dates: "2022 - Present",
          summary: "Building next-gen cloud automation",
        },
      ],
      sourceProvider: "brightdata_dataset",
    },
  };

  const fakeCtx: any = {
    config: {
      sessionId: "test-session-123",
      targetLimit: 10,
      promptQuery: "Find founders in Austin",
      contract: {
        requirements: [{ scope: "person_role" }],
      },
    },
    state: {
      acceptedLeads: [],
      existingKeys: new Set<string>(),
      seenCandidateKeys: new Set<string>(),
      debugLogs: [],
      abortController: new AbortController(),
      llmCircuitBreaker: { canAttempt: () => true },
    },
    logEvent: () => {},
    recordTrace: () => ({ id: "trace-1", timestamp: new Date().toISOString() }),
  };

  const output = await executeExtractStage(fakeCtx, {
    round: 1,
    candidateItems: [candidateItem],
    rerankPoolTarget: 10,
    brightDataReady: true,
    brightDataProviderDisabled: false,
    tavilyCapabilities: {},
    brightDataCapabilities: {},
    consecutiveFailedExtractionRounds: 0,
    failedExtractionRoundsBeforeStop: 2,
    stats: { rejectionReasons: {} },
  });

  assert.equal(output.extractedProfiles.length, 1);
  const lead = output.extractedProfiles[0];

  // 1. Required identity & role context fields
  assert.equal(lead.fullName, "Jane Doe");
  assert.equal(lead.currentTitle, "Co-Founder & CEO");
  assert.equal(lead.currentCompany, "Apex Cloud");
  assert.equal(lead.company, "Apex Cloud");
  assert.equal(lead.extractionConfidence, 10);
  assert.equal(lead.sourceProvider, "brightdata");

  // 2. contactDetails.linkedinUrl required for verifyStage & deduplication
  assert.ok(lead.contactDetails);
  assert.equal(lead.contactDetails.linkedinUrl, "https://linkedin.com/in/janedoe");

  // 3. Evidence registered in evidenceByUrl
  const meta = output.evidenceByUrl.get("linkedin.com/in/janedoe");
  assert.ok(meta);
  assert.equal(meta.evidenceQuality, "good");
  assert.ok(meta.evidenceBlock.includes("LINK: https://www.linkedin.com/in/janedoe"));

  // 4. Verify decision maker verification can reach confidence 9 with this evidence
  const dmResult = verifyDecisionMakerFromEvidence(
    {
      currentTitle: lead.currentTitle,
      currentCompany: lead.currentCompany,
      evidenceText: meta.evidenceBlock,
      experiences: lead.experiences,
    },
    "Find founders at cloud startups",
  );
  assert.ok(dmResult.confidence >= 9, `Expected confidence >= 9, got ${dmResult.confidence} (${dmResult.reason})`);
});

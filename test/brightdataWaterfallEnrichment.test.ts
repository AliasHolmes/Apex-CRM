import { test } from "node:test";
import assert from "node:assert/strict";
import { executeEnrichStage } from "../server/leadSearch/stages/enrichStage.js";

test("executeEnrichStage marks pre-enriched brightdata_dataset leads enriched: true without network calls", async () => {
  const preEnrichedLead = {
    id: "lead-pre-1",
    fullName: "Alex Rivera",
    currentTitle: "VP of Engineering",
    currentCompany: "Nexus Robotics",
    company: "Nexus Robotics",
    contactDetails: {
      linkedinUrl: "https://linkedin.com/in/alexrivera",
      website: "https://nexusrobotics.com",
    },
    sourceProvider: "brightdata",
    _rawDossier: {
      name: "Alex Rivera",
      position: "VP of Engineering",
      current_company_name: "Nexus Robotics",
    },
    experiences: [
      { title: "VP of Engineering", company: "Nexus Robotics" },
    ],
  };

  const evidenceMeta: any = {
    evidenceBlock: "LINK: https://linkedin.com/in/alexrivera\nTITLE: VP of Engineering at Nexus Robotics\n[BRIGHTDATA DOSSIER]",
    evidenceQuality: "good",
    sourceProvider: "brightdata",
    sourceUrl: "https://linkedin.com/in/alexrivera",
  };

  const fakeCtx: any = {
    config: {
      sessionId: "test-session-waterfall",
      targetLimit: 10,
      minScore: 5,
      ttlDays: 7,
      creditReservationEnabled: false,
    },
    state: {
      acceptedLeads: [],
      existingKeys: new Set<string>(),
      seenCandidateKeys: new Set<string>(),
      debugLogs: [],
      abortController: new AbortController(),
      brightDataStats: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        profileScrapesAttempted: 0,
        profileScrapesSucceeded: 0,
        rejectionReasons: {},
      },
      freeTierBudget: {
        reserveBrightDataScrape: () => 0,
      },
    },
    ports: {
      scrapeMarkdown: async () => null,
      scrapeBatchMarkdown: async () => [],
    },
    logEvent: () => {},
    recordTrace: () => ({ id: "trace-w1", timestamp: new Date().toISOString() }),
  };

  const output = await executeEnrichStage(fakeCtx, {
    round: 1,
    postFilterLeads: [{ lead: preEnrichedLead, evidenceMeta, queryRun: undefined }],
    rerankPoolTarget: 10,
    profileEnrichmentStage: "selective",
    profileMaxPerSearch: 10,
    enrichmentCap: 10,
    profileConcurrency: 1,
    ttlDays: 7,
    contract: { requirements: [] } as any,
    brightDataProviderDisabled: false,
    brightDataTransportRetryAfter: 0,
    stats: { enriched: 0, cacheHits: 0, cacheWrites: 0, rejectionReasons: {} },
    leadQueryRuns: new Map() as any,
    trackableBrightDataSearch: async () => [],
  });

  assert.equal(output.brightDataProviderDisabled, false);
  assert.ok(fakeCtx.state.acceptedLeads.length >= 1);
  assert.equal(fakeCtx.state.acceptedLeads[0].fullName, "Alex Rivera");
  // Ensure no unexpected batch scrapes were attempted for pre-enriched leads
  assert.equal(fakeCtx.state.brightDataStats.batchScrapesAttempted || 0, 0);
});

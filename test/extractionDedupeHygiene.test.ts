import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLinkedInUrl, extractLinkedInUsername } from "../server/services/linkedinEvidence.js";

test("Extraction deduplication only registers keys for successfully extracted profiles", () => {
  const seenCandidateKeys = new Set<string>();

  // Mock successful extraction of lead1 and lead2
  const extractedLeads = [
    {
      fullName: "Alex Miller",
      currentTitle: "Founder & CEO",
      currentCompany: "Nexus AI",
      contactDetails: { linkedinUrl: "https://www.linkedin.com/in/alexmiller-ceo" }
    },
    {
      fullName: "Sarah Connor",
      currentTitle: "Managing Director",
      currentCompany: "Apex Growth",
      contactDetails: { linkedinUrl: "https://www.linkedin.com/in/sarah-connor-growth" }
    }
  ];

  for (const lead of extractedLeads) {
    const url = lead.contactDetails?.linkedinUrl || "";
    const username = extractLinkedInUsername(url);
    const normalized = normalizeLinkedInUrl(url);
    if (username) seenCandidateKeys.add(`linkedin:${username}`);
    if (username) seenCandidateKeys.add(username);
    if (normalized) seenCandidateKeys.add(normalized);
  }

  assert.ok(seenCandidateKeys.has("linkedin:alexmiller-ceo"));
  assert.ok(seenCandidateKeys.has("linkedin:sarah-connor-growth"));

  // Verify that an unextracted snippet URL from a failed/empty chunk is NOT in seenCandidateKeys
  const unextractedSnippetUrl = "https://www.linkedin.com/in/nate-garcia-agency";
  const unextractedUsername = extractLinkedInUsername(unextractedSnippetUrl);
  assert.ok(!seenCandidateKeys.has(`linkedin:${unextractedUsername}`));
  assert.ok(!seenCandidateKeys.has(unextractedUsername));
});

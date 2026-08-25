import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFtsQuery,
  getLeadsDb,
  readLeadsSummary,
  upsertLeadWithIdentity,
  deleteLead,
} from "../server/db.js";

test("sanitizeFtsQuery safely sanitizes plain and complex search strings", () => {
  assert.equal(sanitizeFtsQuery(""), null);
  assert.equal(sanitizeFtsQuery("   "), null);
  assert.equal(sanitizeFtsQuery("CEO"), '"CEO"*');
  assert.equal(sanitizeFtsQuery("Alex Smith"), '"Alex"* "Smith"*');
  // Strips FTS operators and special characters
  assert.equal(
    sanitizeFtsQuery('Alex "AND" OR NOT NEAR Smith!@#'),
    '"Alex"* "Smith"*'
  );
  // Preserves hyphens and dots within words
  assert.equal(
    sanitizeFtsQuery("alex-smith test.user@example.com"),
    '"alex-smith"* "test.user@example.com"*'
  );
});

test("SQLite FTS5 indexes leads and supports instant text search across fields", () => {
  const testId1 = `test-fts-${Date.now()}-1`;
  const testId2 = `test-fts-${Date.now()}-2`;

  try {
    // Insert test leads
    upsertLeadWithIdentity({
      id: testId1,
      fullName: "Jonathan FTS Tester",
      company: "Quantum Cybernetics Inc",
      title: "Chief AI Architect",
      stage: "NEW",
      reviewStatus: "UNREVIEWED",
      nextAction: "NONE",
      notes: "Met at the AI summit in San Francisco",
      tags: ["AI", "Architecture", "Enterprise"],
      profile: {
        fullName: "Jonathan FTS Tester",
        currentCompany: "Quantum Cybernetics Inc",
        currentTitle: "Chief AI Architect",
        contactDetails: { email: "jonathan.fts@quantumcyber.io" },
      },
    });

    upsertLeadWithIdentity({
      id: testId2,
      fullName: "Evelyn FTS Engineer",
      company: "Starlight Dynamics",
      title: "Lead DevOps Specialist",
      stage: "CONTACTED",
      reviewStatus: "QUALIFIED",
      nextAction: "EMAIL",
      notes: "Looking to deploy Kubernetes pipelines",
      tags: ["Kubernetes", "DevOps"],
      profile: {
        fullName: "Evelyn FTS Engineer",
        currentCompany: "Starlight Dynamics",
        currentTitle: "Lead DevOps Specialist",
        contactDetails: { email: "evelyn.fts@starlight.io" },
      },
    });

    // Test search by name
    const byName = readLeadsSummary({ search: "Jonathan" });
    assert.ok(byName.leads.some((l) => l.id === testId1));

    // Test search by company
    const byCompany = readLeadsSummary({ search: "Quantum Cybernetics" });
    assert.ok(byCompany.leads.some((l) => l.id === testId1));

    // Test search by notes
    const byNotes = readLeadsSummary({ search: "Kubernetes pipelines" });
    assert.ok(byNotes.leads.some((l) => l.id === testId2));

    // Test search by tags
    const byTag = readLeadsSummary({ search: "Architecture" });
    assert.ok(byTag.leads.some((l) => l.id === testId1));

    // Test search in summaryOnly mode
    const summarySearch = readLeadsSummary({
      search: "Starlight",
      summaryOnly: true,
    });
    assert.ok(summarySearch.leads.some((l) => l.id === testId2));
    assert.equal(summarySearch.leads.find((l) => l.id === testId2)?.company, "Starlight Dynamics");

    // Test update trigger synchronization
    upsertLeadWithIdentity({
      id: testId1,
      fullName: "Jonathan FTS Tester",
      company: "Quantum Cybernetics Inc",
      title: "Chief AI Architect",
      stage: "NEW",
      notes: "Updated note mentioning Blockchain integration",
      tags: ["AI", "Blockchain"],
      profile: {
        fullName: "Jonathan FTS Tester",
        currentCompany: "Quantum Cybernetics Inc",
        currentTitle: "Chief AI Architect",
      },
    });

    const byUpdatedNote = readLeadsSummary({ search: "Blockchain" });
    assert.ok(byUpdatedNote.leads.some((l) => l.id === testId1));

    // Test search by punctuation only returns 0 results
    const byPunctuation = readLeadsSummary({ search: "### !!! ???" });
    assert.equal(byPunctuation.leads.length, 0);

    // Test delete trigger synchronization
    deleteLead(testId1);
    const afterDelete = readLeadsSummary({ search: "Blockchain" });
    assert.ok(!afterDelete.leads.some((l) => l.id === testId1));
  } finally {
    deleteLead(testId1);
    deleteLead(testId2);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-identity-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

const {
  getLeadsDb,
  closeLeadsDb,
  upsertLeadWithIdentity,
  buildLeadIdentityKeys,
  deleteLead,
} = await import("../server/db.ts");

const { candidateStableId, normalizeCandidateKey } = await import(
  "../server/leadSearch/discoveryEngine.ts"
);

test.after(() => {
  closeLeadsDb();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch {}
});

test("Stream 2: Identity Keys Harmonization & Parity", async (t) => {
  await t.test("buildLeadIdentityKeys generates all 3 keys even when LinkedIn is present", () => {
    const lead = {
      fullName: "Jane Founder",
      currentCompany: "Quantum AI Inc",
      email: "jane@quantumai.com",
      contactDetails: {
        linkedinUrl: "https://www.linkedin.com/in/jane-founder-123/",
        email: "jane@quantumai.com",
      },
    };

    const keys = buildLeadIdentityKeys(lead);
    assert.ok(keys.has("linkedin:jane-founder-123"), "Must contain LinkedIn key");
    assert.ok(keys.has("email:jane@quantumai.com"), "Must contain email key");
    assert.ok(
      keys.has("name_company:jane founder::quantum ai inc"),
      "Must contain name_company key even when LinkedIn is present",
    );
  });

  await t.test("CRM lead with LinkedIn matches incoming candidate with only name+company", () => {
    const db = getLeadsDb();

    // 1. Insert CRM lead who has a LinkedIn profile
    const crmLead = {
      id: "crm-lead-alice",
      fullName: "Alice Wonderland",
      currentCompany: "Apex Innovations",
      currentTitle: "CEO",
      contactDetails: {
        linkedinUrl: "https://www.linkedin.com/in/alice-wonderland/",
      },
    };
    const insertRes = upsertLeadWithIdentity(crmLead);
    assert.equal(insertRes.disposition, "created");

    // Verify lead_identities has both linkedin and name_company
    const identities = db
      .prepare("SELECT identity_key FROM lead_identities WHERE lead_id = ?")
      .all("crm-lead-alice") as { identity_key: string }[];
    const idKeys = new Set(identities.map((i) => i.identity_key));
    assert.ok(idKeys.has("linkedin:alice-wonderland"));
    assert.ok(idKeys.has("name_company:alice wonderland::apex innovations"));

    // 2. Incoming candidate has NO LinkedIn URL, only name and company
    const webCandidate = {
      id: "web-lead-candidate-2",
      fullName: "Alice Wonderland",
      currentCompany: "Apex Innovations",
      currentTitle: "Chief Executive Officer",
    };
    const dupRes = upsertLeadWithIdentity(webCandidate);
    assert.equal(
      dupRes.disposition,
      "duplicate",
      "Must detect duplicate on name+company even when incoming lead lacks LinkedIn",
    );
    assert.equal(dupRes.lead.id, "crm-lead-alice");
  });

  await t.test("candidateStableId outputs name_company format and handles legacy text: format", () => {
    const candidate = {
      fullName: "Bob Smith",
      currentCompany: "Acme Labs",
    };
    const id = candidateStableId(candidate);
    assert.equal(id, "name_company:bob smith::acme labs");

    // Legacy checkpoint backward compatibility translation
    const legacyKey = "text:charlie brown@peanuts inc";
    const normalized = normalizeCandidateKey(legacyKey);
    assert.equal(normalized, "name_company:charlie brown::peanuts inc");
  });

  await t.test("deleteLead removes all identities from lead_identities", () => {
    const db = getLeadsDb();
    deleteLead("crm-lead-alice");

    const remainingIdentities = db
      .prepare("SELECT * FROM lead_identities WHERE lead_id = ?")
      .all("crm-lead-alice");
    assert.equal(
      remainingIdentities.length,
      0,
      "All identities must be deleted when lead is deleted",
    );
  });
});

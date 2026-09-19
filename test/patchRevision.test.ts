import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";

const testDbPath = path.join(
  os.tmpdir(),
  `test-patch-rev-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  upsertLeadWithIdentity,
  readStoredLeadById,
} from "../server/db.js";
import { rebaseLeadChanges } from "../src/lib/leadMutations.js";
import apiRouter from "../server/routes/api.js";
import type { Lead } from "../src/types.js";

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

let server: Server;
let baseUrl: string;

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test("Stream 5 - PATCH Revision Validation & Bulk Per-Item Conflicts", async (t) => {
  // Seed an existing lead
  const initialLead = {
    id: "lead-test-1",
    profile: {
      fullName: "Alice Smith",
      currentCompany: "Acme Corp",
      currentTitle: "Chief Executive Officer",
    },
    stage: "SCRAPED",
    reviewStatus: "PENDING",
    revision: 1,
    createdAt: new Date().toISOString(),
  };
  upsertLeadWithIdentity(initialLead, { requireExisting: false });

  await t.test("PATCH /leads/:id fails with 400 if revision is omitted on existing lead", async () => {
    const res = await fetch(`${baseUrl}/api/leads/lead-test-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead: {
          profile: {
            fullName: "Alice Smith",
            currentCompany: "Acme Corp",
            currentTitle: "CEO",
          },
          stage: "ENRICHED",
          // revision omitted!
        },
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.code, "REVISION_REQUIRED");
  });

  await t.test("PATCH /leads/:id succeeds when matching integer revision is provided", async () => {
    const res = await fetch(`${baseUrl}/api/leads/lead-test-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead: {
          profile: {
            fullName: "Alice Smith",
            currentCompany: "Acme Corp",
            currentTitle: "CEO",
          },
          stage: "ENRICHED",
          revision: 1,
        },
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.lead.revision, 2);
    assert.equal(body.lead.stage, "ENRICHED");
  });

  await t.test("PATCH /leads/:id returns 409 conflict when revision is stale", async () => {
    const res = await fetch(`${baseUrl}/api/leads/lead-test-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead: {
          profile: {
            fullName: "Alice Smith",
            currentCompany: "Acme Corp",
            currentTitle: "CEO",
          },
          stage: "SEQUENCE ACTIVE",
          revision: 1, // Stale! Current DB revision is 2
        },
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 409);
    assert.equal(body.code, "LEAD_REVISION_CONFLICT");
    assert.equal(body.lead.revision, 2);
  });

  await t.test("POST /leads/bulk with perItemConflict commits non-conflicting leads while returning conflicts", async () => {
    // Seed lead 2
    const lead2 = {
      id: "lead-test-2",
      profile: {
        fullName: "Bob Jones",
        currentCompany: "Beta LLC",
        currentTitle: "CTO",
      },
      stage: "SCRAPED",
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    upsertLeadWithIdentity(lead2, { requireExisting: false });

    // Bulk update: lead-test-1 has STALE revision 1 (conflict), lead-test-2 has VALID revision 1
    const res = await fetch(`${baseUrl}/api/leads/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requireExisting: true,
        perItemConflict: true,
        leads: [
          {
            id: "lead-test-1",
            profile: {
              fullName: "Alice Smith",
              currentCompany: "Acme Corp",
              currentTitle: "CEO",
            },
            stage: "CONVERTED",
            revision: 1, // STALE (server has 2)
          },
          {
            id: "lead-test-2",
            profile: {
              fullName: "Bob Jones",
              currentCompany: "Beta LLC",
              currentTitle: "CTO",
            },
            stage: "ENRICHED",
            revision: 1, // VALID (server has 1)
          },
        ],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.conflictCount, 1);
    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].incomingId, "lead-test-1");
    assert.equal(body.conflicts[0].lead.revision, 2);

    // Verify Bob was committed to DB
    assert.equal(body.updatedCount, 1);
    const bobInDb = readStoredLeadById("lead-test-2");
    assert.equal(bobInDb?.stage, "ENRICHED");
    assert.equal(bobInDb?.revision, 2);

    // Verify Alice was NOT modified by the conflicting write
    const aliceInDb = readStoredLeadById("lead-test-1");
    assert.equal(aliceInDb?.stage, "ENRICHED"); // Still ENRICHED, not CONVERTED
    assert.equal(aliceInDb?.revision, 2);
  });

  await t.test("rebaseLeadChanges resolves conflict and allows clean second-attempt persistence", async () => {
    const serverAlice = readStoredLeadById("lead-test-1") as unknown as Lead;
    const desiredAlice: Lead = {
      ...serverAlice,
      stage: "CONVERTED",
      notes: "Closed deal with Alice",
    };
    const baselineAlice: Lead = {
      ...serverAlice,
      stage: "SCRAPED",
    };

    const rebased = rebaseLeadChanges(serverAlice, desiredAlice, baselineAlice);
    assert.equal(rebased.revision, serverAlice.revision);
    assert.equal(rebased.stage, "CONVERTED");
    assert.equal(rebased.notes, "Closed deal with Alice");

    // Persist rebased lead
    const res = await fetch(`${baseUrl}/api/leads/lead-test-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead: rebased }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.lead.revision, 3);
    assert.equal(body.lead.stage, "CONVERTED");
    assert.equal(body.lead.notes, "Closed deal with Alice");
  });
});

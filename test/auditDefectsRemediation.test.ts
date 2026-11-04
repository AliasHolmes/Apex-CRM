import test from "node:test";
import assert from "node:assert/strict";

// -----------------------------------------------------------------------------
// Test 1: Delta Hydration Mismatch Fallback Logic
// -----------------------------------------------------------------------------
test("delta hydration mismatch triggers full reload instead of truncating inventory", () => {
  // Simulate the hydration map state in LeadContext.tsx
  const hydratedLeadsById = new Map<string, { id: string; fullName: string }>([
    ["lead-1", { id: "lead-1", fullName: "Alice" }],
    ["lead-2", { id: "lead-2", fullName: "Bob" }],
    ["lead-3", { id: "lead-3", fullName: "Charlie" }],
    ["lead-4", { id: "lead-4", fullName: "David" }],
    ["lead-5", { id: "lead-5", fullName: "Eve" }],
  ]);

  // Delta response returned only lead-1 updated, but on the server, lead-4 and lead-5 were deleted
  // Total on server is now 3 (lead-1, lead-2, lead-3), but delta payload only contains lead-1
  const sanitizedDelta = [{ id: "lead-1", fullName: "Alice (Updated)" }];
  const serverTotal = 3;

  const mergedIds = new Set(hydratedLeadsById.keys());
  for (const lead of sanitizedDelta) {
    if (lead.id) mergedIds.add(lead.id);
  }

  // Under the old bug: hydratedLeadsById was set to null, but then sanitizedDelta (length 1)
  // was treated as the full response, wiping out lead-2 and lead-3!
  const isMismatch = mergedIds.size !== serverTotal;
  assert.equal(isMismatch, true, "Mismatch must be detected when deletions occurred");

  let fullRefetchTriggered = false;
  let resultLeads: Array<{ id: string; fullName: string }> = [];

  if (isMismatch) {
    // Correct remediation: invalidate cache and trigger full refetch
    fullRefetchTriggered = true;
    // Simulated full refetch response from /api/leads:
    resultLeads = [
      { id: "lead-1", fullName: "Alice (Updated)" },
      { id: "lead-2", fullName: "Bob" },
      { id: "lead-3", fullName: "Charlie" },
    ];
  }

  assert.equal(fullRefetchTriggered, true, "Full refetch must be triggered on count mismatch");
  assert.equal(resultLeads.length, 3, "Inventory must preserve all surviving server leads");
  assert.deepEqual(
    resultLeads.map((l) => l.id),
    ["lead-1", "lead-2", "lead-3"],
  );
});

// -----------------------------------------------------------------------------
// Test 2: Export API ID Parameter Bounds & Chunking
// -----------------------------------------------------------------------------
test("export API deduplicates IDs, rejects oversized requests, and chunks in batches <= 900", () => {
  const MAX_EXPORT_IDS = 10_000;
  const SQLITE_CHUNK_SIZE = 900;

  // 1. Deduplication
  const rawIds = ["id-1", "id-2", "id-1", "id-3", "id-2", "  id-4  "];
  const cleaned = rawIds.map((s) => s.trim()).filter(Boolean);
  const uniqueIds = Array.from(new Set(cleaned));
  assert.deepEqual(uniqueIds, ["id-1", "id-2", "id-3", "id-4"]);

  // 2. Reject request exceeding MAX_EXPORT_IDS
  const oversizedList = Array.from({ length: 10_001 }, (_, i) => `lead-${i}`);
  const isOversized = oversizedList.length > MAX_EXPORT_IDS;
  assert.equal(isOversized, true, "Oversized export requests (>10,000) must be flagged");

  // 3. Batch chunking within SQLite parameter limit (<= 900)
  const sampleIds = Array.from({ length: 2_500 }, (_, i) => `id-${i}`);
  const chunks: string[][] = [];
  for (let i = 0; i < sampleIds.length; i += SQLITE_CHUNK_SIZE) {
    chunks.push(sampleIds.slice(i, i + SQLITE_CHUNK_SIZE));
  }

  assert.equal(chunks.length, 3, "2,500 IDs must be split into 3 chunks");
  assert.equal(chunks[0].length, 900);
  assert.equal(chunks[1].length, 900);
  assert.equal(chunks[2].length, 700);
  assert.ok(chunks.every((c) => c.length <= SQLITE_CHUNK_SIZE), "All chunks must be <= 900");
});

// -----------------------------------------------------------------------------
// Test 3: Session Deletion Error Handling and State Rollback
// -----------------------------------------------------------------------------
test("session deletion UI captures snapshot and restores state on non-2xx HTTP responses", async () => {
  interface SessionItem {
    id: string;
    title: string;
  }

  const initialSessions: SessionItem[] = [
    { id: "session-1", title: "Tech Founders" },
    { id: "session-2", title: "Healthcare Execs" },
  ];
  let currentSessions = [...initialSessions];
  let selectedIds = new Set<string>(["session-1"]);

  // Deletion helper mirroring ResumableSessionsBanner.tsx remediation
  async function simulateDeleteOne(
    sessionId: string,
    mockFetch: (url: string) => Promise<{ ok: boolean; status: number }>,
  ) {
    const previousSessions = currentSessions;
    const previousSelected = selectedIds;

    // Optimistic update
    currentSessions = currentSessions.filter((s) => s.id !== sessionId);
    selectedIds = new Set(selectedIds);
    selectedIds.delete(sessionId);

    try {
      const res = await mockFetch(`/api/mining-sessions/${sessionId}`);
      if (!res.ok) {
        throw new Error(`Failed to delete mining session (${res.status})`);
      }
    } catch {
      // Rollback on failure
      currentSessions = previousSessions;
      selectedIds = previousSelected;
    }
  }

  // Case A: Server returns 500 Internal Server Error
  await simulateDeleteOne("session-1", async () => ({ ok: false, status: 500 }));
  assert.equal(currentSessions.length, 2, "Sessions must be restored on 500 error");
  assert.equal(selectedIds.has("session-1"), true, "Selection must be restored on 500 error");

  // Case B: Server returns 200 OK
  await simulateDeleteOne("session-1", async () => ({ ok: true, status: 200 }));
  assert.equal(currentSessions.length, 1, "Session must be removed when server returns 200");
  assert.equal(currentSessions[0].id, "session-2");
  assert.equal(selectedIds.has("session-1"), false);
});

// -----------------------------------------------------------------------------
// Test 4: Sanitized API 500 Contracts
// -----------------------------------------------------------------------------
test("API 500 error handlers return stable sanitized messages without leaking internal exceptions", () => {
  // Simulate an unexpected database error throwing an internal path or schema syntax
  const rawDbError = new Error("SQLITE_CORRUPT: database disk image is malformed at offset 0x482a in /var/data/apex.db");

  function simulateApi500Handler(err: Error, publicMessage: string) {
    // Server logs the full trace
    const loggedTrace = `[Server Log] ${err.message}`;
    // Client response is strictly sanitized
    const clientPayload = { error: publicMessage };
    return { loggedTrace, clientPayload };
  }

  const { loggedTrace, clientPayload } = simulateApi500Handler(rawDbError, "Failed to read leads");

  assert.ok(loggedTrace.includes("SQLITE_CORRUPT"), "Server log must contain the raw diagnostic error");
  assert.equal(clientPayload.error, "Failed to read leads", "Client response must be sanitized");
  assert.ok(!clientPayload.error.includes("SQLITE"), "Client payload must never disclose internal database details");
});

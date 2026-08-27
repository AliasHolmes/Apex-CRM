import test from "node:test";
import assert from "node:assert/strict";

test("Safety net admits unknown and qualified candidates while rejecting explicit hard_fail", () => {
  const judgmentInsight = new Map<string, { status: string; score: number }>();
  judgmentInsight.set("c1", { status: "qualified", score: 9 });
  judgmentInsight.set("c2", { status: "unknown", score: 5 });
  judgmentInsight.set("c3", { status: "hard_fail", score: -100 });
  // c4 is unjudged (not in map)

  const candidates = [
    { lead: { name: "Alice" }, index: 1, id: "c1" },
    { lead: { name: "Bob" }, index: 2, id: "c2" },
    { lead: { name: "Charlie" }, index: 3, id: "c3" },
    { lead: { name: "David" }, index: 4, id: "c4" },
  ];

  const safetyNetFilter = (entry: (typeof candidates)[0]) => {
    const insight = judgmentInsight.get(entry.id);
    return !insight || insight.status !== "hard_fail";
  };

  const admitted = candidates.filter(safetyNetFilter);
  assert.equal(admitted.length, 3);
  assert.deepEqual(
    admitted.map((c) => c.lead.name),
    ["Alice", "Bob", "David"],
  );
  assert.equal(
    admitted.some((c) => c.lead.name === "Charlie"),
    false,
    "Hard fail candidate must be rejected from safety net",
  );
});

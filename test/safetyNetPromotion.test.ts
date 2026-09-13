import test from "node:test";
import assert from "node:assert/strict";

import { isEligibleForSafetyNet } from "../server/leadSearch/stages/judgeStage.js";
import { buildDeterministicProspectContract } from "../server/leadSearch/prospectContract.js";

test("Safety net admits unknown and qualified candidates while rejecting explicit hard_fail and contradictions", () => {
  const contract = buildDeterministicProspectContract(
    "B2B SaaS CEOs in United States, exclude agencies",
    {},
  );

  const judgmentInsight = new Map<string, { status: string; score: number }>();
  judgmentInsight.set("c1", { status: "qualified", score: 9 });
  judgmentInsight.set("c2", { status: "unknown", score: 5 });
  judgmentInsight.set("c3", { status: "hard_fail", score: -100 });

  const candidates = [
    { lead: { name: "Alice", currentTitle: "CEO", currentCompany: "CloudScale Inc" }, index: 1, id: "c1" },
    { lead: { name: "Bob", currentTitle: "Chief Executive Officer", currentCompany: "TechFlow" }, index: 2, id: "c2" },
    { lead: { name: "Charlie", currentTitle: "CEO", currentCompany: "Agency Marketing Co" }, index: 3, id: "c3" },
    { lead: { name: "David", currentTitle: "CEO", currentCompany: "Dataview Systems" }, index: 4, id: "c4" },
    { lead: { name: "Eve", currentTitle: "CEO", currentCompany: "Failed Inc", _autoFailed: true }, index: 5, id: "c5" },
  ];

  const admitted = candidates.filter((entry) => {
    const insight = judgmentInsight.get(entry.id);
    return isEligibleForSafetyNet(entry.lead, contract, insight);
  });

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
  assert.equal(
    admitted.some((c) => c.lead.name === "Eve"),
    false,
    "Auto-failed candidate must be rejected from safety net",
  );
});

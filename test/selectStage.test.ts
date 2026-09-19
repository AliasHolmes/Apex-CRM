import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-select-stage-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import { determineSelectionShortfall } from "../server/leadSearch/stages/selectStage.js";

test("Stream 4 - Selection Stage Off-by-One Fix", async (t) => {
  await t.test("when qualified count equals targetLimit, isShortfall is FALSE (hit target runs execute intent)", () => {
    const isShortfall = determineSelectionShortfall(10, 10);
    assert.equal(isShortfall, false, "Hitting target exactly must not trigger shortfall bypass");
  });

  await t.test("when qualified count exceeds targetLimit, isShortfall is FALSE", () => {
    const isShortfall = determineSelectionShortfall(15, 10);
    assert.equal(isShortfall, false);
  });

  await t.test("when qualified count is less than targetLimit, isShortfall is TRUE", () => {
    const isShortfall = determineSelectionShortfall(9, 10);
    assert.equal(isShortfall, true, "Strictly fewer leads than target is a shortfall");
  });
});

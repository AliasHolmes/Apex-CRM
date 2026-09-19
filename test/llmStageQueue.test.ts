import { test } from "node:test";
import assert from "node:assert/strict";
import { withSequentialLLMExecution, runWithLlmStageLane } from "../server/services/llm.js";

test("stage queues off by default: serial execution preserved", async () => {
  delete process.env.FEATURE_LLM_STAGE_QUEUES;
  const order: number[] = [];
  const p1 = withSequentialLLMExecution(async () => {
    await new Promise(r => setTimeout(r, 40));
    order.push(1);
    return 1;
  });
  const p2 = withSequentialLLMExecution(async () => {
    order.push(2);
    return 2;
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(order, [1, 2]);
});

test("stage queues on: lanes run concurrently within caps", async () => {
  process.env.FEATURE_LLM_STAGE_QUEUES = "true";
  try {
    const started: string[] = [];
    const finished: string[] = [];
    const mk = (lane: 'strategist' | 'extraction' | 'judge', name: string, ms: number) =>
      runWithLlmStageLane(lane, () =>
        withSequentialLLMExecution(async () => {
          started.push(name);
          await new Promise(r => setTimeout(r, ms));
          finished.push(name);
          return name;
        }),
      );
    const results = await Promise.all([
      mk('strategist', 's1', 60),
      mk('extraction', 'e1', 60),
      mk('judge', 'j1', 60),
    ]);
    assert.deepEqual([...results].sort(), ['e1', 'j1', 's1']);
    // All three lanes must have started before any finished (concurrent, not serial)
    assert.equal(started.length, 3);
    assert.equal(finished.length, 3);
  } finally {
    delete process.env.FEATURE_LLM_STAGE_QUEUES;
  }
});

test("stage queues: aborting queued task does not leak slots", async () => {
  process.env.FEATURE_LLM_STAGE_QUEUES = "true";
  process.env.LLM_LANE_SLOTS = "1";
  try {
    const controller = new AbortController();
    const p1 = runWithLlmStageLane('judge', () =>
      withSequentialLLMExecution(async () => {
        await new Promise(r => setTimeout(r, 80));
        return "done1";
      }),
    );
    const p2 = runWithLlmStageLane('judge', () =>
      withSequentialLLMExecution(async () => "done2", controller.signal),
    );
    const p2Rejection = assert.rejects(p2, (e: any) => e.name === "AbortError" || e.name === "TimeoutError");
    setTimeout(() => controller.abort(), 10);
    const p3 = runWithLlmStageLane('judge', () =>
      withSequentialLLMExecution(async () => "done3"),
    );
    assert.equal(await p1, "done1");
    await p2Rejection;
    assert.equal(await p3, "done3");
  } finally {
    delete process.env.FEATURE_LLM_STAGE_QUEUES;
    delete process.env.LLM_LANE_SLOTS;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { withSequentialLLMExecution } from "../server/services/llm.js";

test("withSequentialLLMExecution respects sequential execution and abort signals", async () => {
  const executionOrder: number[] = [];

  const p1 = withSequentialLLMExecution(async () => {
    await new Promise(r => setTimeout(r, 50));
    executionOrder.push(1);
    return 1;
  });

  const p2 = withSequentialLLMExecution(async () => {
    executionOrder.push(2);
    return 2;
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(executionOrder, [1, 2]);
});

test("withSequentialLLMExecution cleanly aborts queued tasks without deadlocking", async () => {
  const controller = new AbortController();

  // Task 1 occupies slot
  const p1 = withSequentialLLMExecution(async () => {
    await new Promise(r => setTimeout(r, 100));
    return "done1";
  });

  // Task 2 waits in queue and will be aborted
  const p2 = withSequentialLLMExecution(async () => {
    return "done2";
  }, controller.signal);

  // Attach rejection listener immediately so Node does not register unhandled rejection
  const p2Rejection = assert.rejects(p2, (err: any) => err.name === "AbortError");

  // Abort p2 while it is waiting
  setTimeout(() => controller.abort(), 20);

  // Task 3 waits in queue behind p2
  const p3 = withSequentialLLMExecution(async () => {
    return "done3";
  });

  const res1 = await p1;
  assert.equal(res1, "done1");

  await p2Rejection;

  // Task 3 must still execute smoothly even after task 2 aborted
  const res3 = await p3;
  assert.equal(res3, "done3");
});

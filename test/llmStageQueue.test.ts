import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireProviderSlot,
  releaseProviderSlot,
  getProviderActiveSlots,
  waitForProviderSlot,
} from "../server/services/llm.js";

test("slot waiting queue resolves in FIFO order on slot release", async () => {
  const dummyProvider = {
    id: "primary" as const,
    name: "Byesu",
    baseUrl: "https://byesu.com/v1",
    model: "gpt-5.5",
    apiKey: "test-key",
  };

  // Acquire the 1 slot
  acquireProviderSlot("primary");
  assert.equal(getProviderActiveSlots("primary"), 1);

  const order: string[] = [];
  const p1 = waitForProviderSlot(() => [dummyProvider], null, 5000, false).then(() => {
    order.push("first");
  });
  const p2 = waitForProviderSlot(() => [dummyProvider], null, 5000, false).then(() => {
    order.push("second");
  });

  // Release initial slot -> pumps p1
  releaseProviderSlot("primary");
  await p1;
  assert.equal(order[0], "first");

  // Release slot held by p1 -> pumps p2
  releaseProviderSlot("primary");
  await p2;
  assert.deepEqual(order, ["first", "second"]);

  // Clean up
  releaseProviderSlot("primary");
  assert.equal(getProviderActiveSlots("primary"), 0);
});

test("interactive requests acquire priority in slot waiting queue", async () => {
  const dummyProvider = {
    id: "primary" as const,
    name: "Byesu",
    baseUrl: "https://byesu.com/v1",
    model: "gpt-5.5",
    apiKey: "test-key",
  };

  acquireProviderSlot("primary");
  const order: string[] = [];

  const batchWait = waitForProviderSlot(() => [dummyProvider], null, 5000, false).then(() => {
    order.push("batch");
  });
  const interactiveWait = waitForProviderSlot(() => [dummyProvider], null, 5000, true).then(() => {
    order.push("interactive");
  });

  // Release slot -> interactive should be prioritized ahead of normal batch
  releaseProviderSlot("primary");
  await Promise.race([batchWait, interactiveWait]);
  assert.equal(order[0], "interactive");

  // Release slot held by interactive -> batch resolves
  releaseProviderSlot("primary");
  await batchWait;
  assert.deepEqual(order, ["interactive", "batch"]);

  // Clean up
  releaseProviderSlot("primary");
  assert.equal(getProviderActiveSlots("primary"), 0);
});

test("aborting a queued waiter does not leak provider slots or throw unhandled", async () => {
  const dummyProvider = {
    id: "primary" as const,
    name: "Byesu",
    baseUrl: "https://byesu.com/v1",
    model: "gpt-5.5",
    apiKey: "test-key",
  };

  acquireProviderSlot("primary");
  const controller = new AbortController();

  const queuedWait = waitForProviderSlot(() => [dummyProvider], controller.signal, 5000, false);
  const rejectExpect = assert.rejects(queuedWait, (err: any) => err.name === "AbortError");

  controller.abort();
  await rejectExpect;

  // Release slot and verify no leftover waiter consumed it
  releaseProviderSlot("primary");
  assert.equal(getProviderActiveSlots("primary"), 0);
});

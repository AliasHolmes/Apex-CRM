import assert from "node:assert/strict";
import test from "node:test";

import { EXTRACT_PROMPT_VERSION } from "../server/leadSearch/stages/extractStage.js";
import { JUDGE_PROMPT_VERSION } from "../server/leadSearch/stages/judgeStage.js";
import { STRATEGIST_PROMPT_VERSION } from "../server/leadSearch/stages/planStage.js";
import { STRATEGIST_PROMPT_VERSION as STRATEGIST_PROMPT_VERSION_REEXPORT } from "../server/leadSearch/strategist.js";
import {
  summarizeLLM,
  MiningTelemetryRecorder,
  setLlmStageLogger,
  type LlmStageLogEntry,
} from "../server/leadSearch/telemetry.js";

test("Prompt version constants are defined and follow semver prefix format", () => {
  assert.equal(EXTRACT_PROMPT_VERSION, "v1.0.0");
  assert.equal(JUDGE_PROMPT_VERSION, "v1.0.0");
  assert.equal(STRATEGIST_PROMPT_VERSION, "v1.0.0");
  assert.equal(STRATEGIST_PROMPT_VERSION_REEXPORT, "v1.0.0");
});

test("summarizeLLM preserves promptVersion in LLM telemetry summary", () => {
  const summary = summarizeLLM(
    "extraction",
    "prompt text",
    { leads: [] },
    250,
    0,
    [],
    undefined,
    EXTRACT_PROMPT_VERSION,
  );

  assert.equal(summary.purpose, "extraction");
  assert.equal(summary.promptVersion, "v1.0.0");
});

test("MiningTelemetryRecorder records promptVersion on trace events and forwards to stage logger", () => {
  const capturedStageLogs: LlmStageLogEntry[] = [];
  setLlmStageLogger((entry) => {
    capturedStageLogs.push(entry);
  });

  try {
    const recorder = new MiningTelemetryRecorder(
      "session-pv-test",
      "test query",
      5,
      new Date().toISOString(),
    );

    recorder.record({
      phase: "extraction",
      operation: "llm_extract_chunk",
      status: "success",
      provider: "llm",
      latencyMs: 300,
      promptVersion: EXTRACT_PROMPT_VERSION,
      llm: summarizeLLM(
        "extraction",
        "sample prompt",
        [],
        300,
        0,
        [],
        undefined,
        EXTRACT_PROMPT_VERSION,
      ),
      metadata: {
        promptVersion: EXTRACT_PROMPT_VERSION,
      },
    });

    recorder.record({
      phase: "candidate_processing",
      operation: "incremental_finalist_judge",
      status: "success",
      provider: "llm",
      latencyMs: 400,
      promptVersion: JUDGE_PROMPT_VERSION,
      llm: summarizeLLM(
        "incremental_finalist_judge",
        "sample judge prompt",
        {},
        400,
        0,
        [],
        undefined,
        JUDGE_PROMPT_VERSION,
      ),
      metadata: {
        promptVersion: JUDGE_PROMPT_VERSION,
      },
    });

    recorder.record({
      phase: "strategy",
      operation: "strategist_planning",
      status: "success",
      provider: "llm",
      latencyMs: 200,
      promptVersion: STRATEGIST_PROMPT_VERSION,
      llm: summarizeLLM(
        "strategy",
        "sample strat prompt",
        [],
        200,
        0,
        [],
        undefined,
        STRATEGIST_PROMPT_VERSION,
      ),
      metadata: {
        promptVersion: STRATEGIST_PROMPT_VERSION,
      },
    });

    const trace = recorder.getTrace();
    assert.equal(trace.events.length, 3);

    const extractEvent = trace.events.find((e) => e.phase === "extraction");
    assert.ok(extractEvent);
    assert.equal(extractEvent.promptVersion, "v1.0.0");
    assert.equal(extractEvent.llm?.promptVersion, "v1.0.0");
    assert.equal(extractEvent.metadata?.promptVersion, "v1.0.0");

    const judgeEvent = trace.events.find((e) => e.phase === "candidate_processing");
    assert.ok(judgeEvent);
    assert.equal(judgeEvent.promptVersion, "v1.0.0");
    assert.equal(judgeEvent.llm?.promptVersion, "v1.0.0");
    assert.equal(judgeEvent.metadata?.promptVersion, "v1.0.0");

    const planEvent = trace.events.find((e) => e.phase === "strategy");
    assert.ok(planEvent);
    assert.equal(planEvent.promptVersion, "v1.0.0");
    assert.equal(planEvent.llm?.promptVersion, "v1.0.0");
    assert.equal(planEvent.metadata?.promptVersion, "v1.0.0");

    assert.equal(capturedStageLogs.length, 3);
    assert.equal(capturedStageLogs[0].promptVersion, "v1.0.0");
    assert.equal(capturedStageLogs[1].promptVersion, "v1.0.0");
    assert.equal(capturedStageLogs[2].promptVersion, "v1.0.0");
  } finally {
    setLlmStageLogger(null);
  }
});

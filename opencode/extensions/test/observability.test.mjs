import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAnalytics } from "../src/analytics-metrics.ts";
import { collectCacheUsage, summarizeCache } from "../src/cache-metrics.ts";

test("analytics projects durable events to deduplicated, content-free counts", () => {
  const events = [
    { id: "run", type: "session.execution.started", data: { sessionID: "s" } },
    {
      id: "step",
      type: "session.step.ended",
      data: {
        finish: "tool-calls",
        cost: 0.004,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
        privatePrompt: "must not survive",
      },
    },
    { id: "step", type: "session.step.ended", data: { finish: "stop", cost: 20, tokens: { input: 500 } } },
    { id: "tool-start", type: "session.tool.input.started", data: { id: "t", name: "read", text: "private path" } },
    { id: "tool-call", type: "session.tool.called", data: { id: "t", executed: true, input: { path: "/secret" } } },
    { id: "tool-fail", type: "session.tool.failed", data: { id: "t", executed: true, error: { message: "secret" } } },
    { id: "skill", type: "session.skill.activated", data: { name: "review", text: "private skill body" } },
    { id: "done", type: "session.execution.succeeded", data: { sessionID: "s" } },
  ];
  const result = summarizeAnalytics(events);
  assert.equal(result.responseCycles, 1);
  assert.equal(result.generations, 1);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.reportedCostUsd, 0.004);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolErrors, 1);
  assert.deepEqual(result.tools.read, { calls: 1, failures: 1 });
  assert.deepEqual(result.skills, { review: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|path/);
});

test("cache metrics use host counters and leave absent pricing estimates out", () => {
  const records = collectCacheUsage([
    { id: "a", type: "session.step.ended", data: { cost: 0.03, tokens: { input: 25, cache: { read: 75, write: 0 } } } },
    { id: "a", type: "session.step.ended", data: { cost: 5, tokens: { input: 500, cache: { read: 0, write: 0 } } } },
    { id: "b", type: "session.step.ended", data: { cost: 0, tokens: { input: 0, cache: { read: 0, write: 0 } } } },
  ]);
  const metrics = summarizeCache(records);
  assert.equal(metrics.requestCount, 2);
  assert.equal(metrics.promptTokens, 100);
  assert.equal(metrics.hitRatePercent, 75);
  assert.equal(metrics.samples[1].hitRatePercent, null);
  assert.equal(metrics.reportedCostUsd, 0.03);
  assert.equal("estimatedSavings" in metrics, false);
});

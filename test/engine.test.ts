import assert from "node:assert/strict";
import test from "node:test";
import { TokenSpeedEngine } from "../src/engine";

const config = {
  slidingWindow: 1000,
  graphHistoryMs: 1000,
  graphSampleInterval: 250,
  countStrategy: "direct" as const,
  useProviderTokens: true,
  endTpsBehavior: "average" as const,
};

function makeEngine(): TokenSpeedEngine {
  const engine = new TokenSpeedEngine();
  engine.initialize(config);
  return engine;
}

test("request wall start includes TTFT before decode start", () => {
  const engine = makeEngine();
  const originalNow = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    engine.startTTFT();
    now = 250;
    engine.start();
    const metrics = engine.graphMetrics();
    assert.equal(metrics.requestStartedAt, 100);
    assert.equal(metrics.startedAt, 250);
  } finally {
    Date.now = originalNow;
  }
});

test("all decode chunks merge into one estimated series and final reconciliation cannot spike it", () => {
  const engine = makeEngine();
  engine.start();
  engine.recordDelta("answer");
  engine.sampleGraph(1000);
  engine.recordDelta("reasoning");
  engine.recordDelta('{"tool":"write"}');
  engine.sampleGraph(1250);
  const before = engine.graphMetrics();
  const samplesBefore = [...before.samples];

  engine.stop();
  engine.reconcileTotal(42);
  assert.equal(engine.sampleGraph(1500), false);
  const after = engine.graphMetrics();
  assert.deepEqual(after.samples, samplesBefore);
  assert.equal(after.decodeTokens, 3);
  assert.equal(after.totalTokens, 42);
  assert.equal(after.totalEstimated, false);
  assert.equal(after.seriesEstimated, true);
  assert.ok(after.peakTps > 0);
});

test("progressive usage is per response, ignores initialized zero, and never double-counts fallback chunks", () => {
  const engine = makeEngine();
  engine.start();
  engine.recordDelta("reported zero", 0);
  assert.equal(engine.tokenCount, 1, "initialized usageOutput=0 must not suppress the live estimate");
  assert.equal(engine.totalEstimated, true);
  assert.equal(engine.graphMetrics().decodeTokens, 1);

  engine.recordDelta("usage update", 5);
  assert.equal(engine.tokenCount, 5);
  engine.beginAssistantResponse();
  engine.recordDelta("fallback second response");
  assert.equal(engine.tokenCount, 6, "completed provider total plus one fallback estimate");
  assert.equal(engine.totalEstimated, true);
});

test("progressive usage counts every provider token in batched stream deltas", () => {
  const engine = makeEngine();
  engine.start();
  engine.recordDelta("first batch", 8);
  engine.recordDelta("second batch", 16);

  assert.equal(engine.graphMetrics().decodeTokens, 16);
  assert.equal(engine.tokenCount, 16);
  assert.equal(engine.totalEstimated, false);
});

test("live config updates preserve decode metrics and graph history", () => {
  const engine = makeEngine();
  engine.start();
  engine.recordDelta("one");
  engine.sampleGraph(1000);
  engine.recordDelta("two");
  engine.sampleGraph(1250);
  const before = engine.graphMetrics();
  engine.updateConfig({ ...config, slidingWindow: 2000, countStrategy: "estimate", useProviderTokens: false, endTpsBehavior: "last" });
  const after = engine.graphMetrics();
  assert.equal(after.decodeTokens, before.decodeTokens);
  assert.deepEqual(after.samples, before.samples);
  assert.equal(after.peakTps, before.peakTps);
});

test("tool pause excludes decode time and completed history/peak freeze", () => {
  const engine = makeEngine();
  engine.start();
  engine.sampleGraph(1000);
  engine.recordDelta("chunk");
  engine.sampleGraph(1250);
  const peak = engine.graphMetrics().peakTps;
  engine.pause();
  assert.equal(engine.sampleGraph(1500), false, "tool execution is not a zero TPS sample");
  engine.recordDelta("resumed");
  assert.ok(engine.graphMetrics().meanTps >= 0);

  engine.stop();
  const frozen = [...engine.graphMetrics().samples];
  assert.equal(engine.sampleGraph(1750), false);
  assert.deepEqual(engine.graphMetrics().samples, frozen);
  assert.equal(engine.graphMetrics().peakTps, peak);
});

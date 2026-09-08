import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TokenSpeedEngine } from "../src/engine";
import { renderGraphLines } from "../src/graph-render";
import type { RenderGraphMetrics } from "../src/graph-render";

const metrics: RenderGraphMetrics = {
  samples: [
    { timestamp: 0, decodeTps: 0, meanTps: 0 },
    { timestamp: 250, decodeTps: 40, meanTps: 20 },
    { timestamp: 500, decodeTps: 8, meanTps: 16 },
  ],
  currentTps: 8,
  peakTps: 40,
  meanTps: 16,
  decodeTokens: 13,
  totalTokens: 13,
  totalEstimated: true,
  seriesEstimated: true,
  elapsedMs: 1240,
  startedAt: 1,
  ttft: 310,
  state: "streaming",
};

test("terminal sample can be captured before the engine freezes completed history", () => {
  const engine = new TokenSpeedEngine();
  engine.initialize({
    slidingWindow: 1000,
    graphHistoryMs: 1000,
    graphSampleInterval: 250,
    countStrategy: "direct",
    useProviderTokens: false,
    endTpsBehavior: "average",
  });
  engine.start();
  const startedAt = Date.now();
  engine.sampleGraph(startedAt);
  engine.recordDelta("short response");
  engine.sampleGraph(startedAt + 1000);
  const samples = [...engine.graphMetrics().samples];
  assert.equal(samples.length, 2);
  assert.ok(samples[1]!.decodeTps > 0);
  engine.stop();
  assert.deepEqual(engine.graphMetrics().samples, samples);
});

test("Braille graph rendering obeys width and responsive height", () => {
  for (const width of [1, 8, 32, 67, 68, 80, 120]) {
    const lines = renderGraphLines(metrics, width, 30000, 6);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= (width < 68 ? 9 : 11));
  }
});

test("ANSI-painted graph rendering remains within requested width", () => {
  const paint = (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`;
  for (const width of [8, 40, 100]) {
    const lines = renderGraphLines(metrics, width, 30000, 6, paint);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `ANSI width ${width}`);
  }
});

test("responsive rows label interactive and aggregate semantics, with opaque per-decoder summaries when wide", () => {
  for (const width of [60, 160]) {
    const lines = renderGraphLines({
      ...metrics,
      activeChildCount: 2,
      aggregateCurrentTps: 18,
      aggregateMeanTps: 24,
      aggregatePeakTps: 80,
      decoderSummaries: [
        { label: "Parent", currentTps: 8, meanTps: 16, peakTps: 40, state: "streaming" },
        { label: "Child 2-dead", currentTps: 10, meanTps: 12, peakTps: 20, state: "streaming" },
        { label: "Child 2-cafe", currentTps: 0, meanTps: 9, peakTps: 18, state: "complete" },
      ],
    }, width, 30000, 6).join("\n");
    assert.match(lines, /Interactive.*Now.*Mean.*Peak/);
    assert.match(lines, /Aggregate capacity.*Now.*Mean.*Peak/);
    assert.match(lines, width < 68 ? /First 310 ms/ : /First response 310 ms/);
    if (width >= 96) {
      assert.match(lines, /Decoders: Parent/);
      assert.match(lines, /Child 2-dead/);
      assert.match(lines, /Child 2-cafe/);
    } else assert.doesNotMatch(lines, /Decoders:/);
  }
});

test("final authoritative total removes only total tilde and keeps estimated decode legend", () => {
  const finalMetrics = { ...metrics, totalTokens: 42, totalEstimated: false, state: "complete" as const };
  const lines = renderGraphLines(finalMetrics, 100, 30000, 6).join("\n");
  assert.match(lines, /smoothed decode \(est\.\)/);
  assert.match(lines, /running mean/);
  assert.match(lines, /Total output 42 tok/);
  assert.doesNotMatch(lines, /Total output ~42/);
});

test("per-decoder renderer fails closed for non-opaque labels", () => {
  const lines = renderGraphLines({
    ...metrics,
    decoderSummaries: [
      { label: "Parent", currentTps: 8, meanTps: 16, peakTps: 40, state: "streaming" },
      { label: "Child 0-dead", currentTps: 2, meanTps: 2, peakTps: 3, state: "complete" },
      { label: "agent/model/path/prompt secret", currentTps: 9, meanTps: 9, peakTps: 9, state: "streaming" },
    ],
  }, 140, 30000, 6).join("\n");
  assert.match(lines, /Parent/);
  assert.match(lines, /Child 0-dead/);
  assert.doesNotMatch(lines, /secret|agent\/model\/path\/prompt/);
});

test("graph rendering sanitizes nonfinite metrics and dimensions", () => {
  const poisoned = {
    ...metrics,
    samples: [{ timestamp: 0, decodeTps: NaN, meanTps: Infinity }],
    currentTps: Infinity,
    meanTps: NaN,
    peakTps: -Infinity,
    totalTokens: Infinity,
    elapsedMs: NaN,
    ttft: Infinity,
  };
  const lines = renderGraphLines(poisoned, Infinity, 30000, NaN);
  assert.deepEqual(lines, [""]);
  const safeLines = renderGraphLines(poisoned, 80, 30000, NaN);
  assert.ok(safeLines.every((line) => !/NaN|Infinity/.test(line)));
});

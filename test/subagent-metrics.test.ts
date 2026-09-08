import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FleetAggregator } from "../src/subagent-aggregate";
import { filterSnapshotsForRequest } from "../src/subagent-metrics";
import { childIdForRun, hashSessionId, readSnapshots, sidecarDirectory, sidecarRoot, validateSnapshot, writeSnapshot, type SubagentSnapshot } from "../src/subagent-metrics";

const snapshot = (overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
  schemaVersion: 1, parentSessionHash: hashSessionId("parent-a"), childId: childIdForRun("run-a", 0), index: 0, pid: 123,
  timestamp: 1_000, startedAt: 900, state: "streaming", currentTps: 10, meanTps: 8, peakTps: 12,
  decodeTokens: 5, totalTokens: 5, totalEstimated: true, firstResponseMs: 100, activeDecodeMs: 100, ...overrides,
});

test("sidecar persists opaque numeric/state metadata only and hardens root permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-speed-test-"));
  const first = snapshot();
  const path = await writeSnapshot(first, root);
  const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
  assert.doesNotMatch(raw, /run-a|research|model/i);
  assert.match(raw, new RegExp(first.childId));
  assert.equal((await stat(sidecarRoot(root))).mode & 0o777, 0o700);
  assert.equal((await readSnapshots(first.parentSessionHash, { root, staleMs: 1000, retentionMs: 10000, now: () => 1500 })).length, 1);
  assert.notEqual(hashSessionId("parent-a"), hashSessionId("parent-b"));
  assert.equal(validateSnapshot({ ...first, runId: "secret" }), undefined);
  assert.equal(validateSnapshot({ ...first, agent: "research" }), undefined);
  assert.equal(validateSnapshot({ ...first, modelId: "private-model" }), undefined);
  assert.equal(validateSnapshot({ ...first, currentTps: Infinity }), undefined);
  assert.equal(validateSnapshot({ ...first, timestamp: Number.MAX_SAFE_INTEGER }), undefined);
  assert.equal(validateSnapshot({ ...first, index: 1.5 }), undefined);
});

test("reader rejects malformed/stale input, retains completed totals, and deduplicates opaque child IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-speed-test-"));
  const first = snapshot();
  await writeSnapshot(first, root);
  await writeSnapshot(snapshot({ pid: 124, timestamp: 2_000, totalTokens: 9 }), root);
  const dir = sidecarDirectory(first.parentSessionHash, root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "broken.json"), "not json");
  const fresh = await readSnapshots(first.parentSessionHash, { root, staleMs: 500, retentionMs: 10000, now: () => 2200 });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.totalTokens, 9);
  const doneId = childIdForRun("done", 1);
  await writeSnapshot(snapshot({ childId: doneId, index: 1, state: "complete", timestamp: 1000, totalTokens: 7 }), root);
  const retained = await readSnapshots(first.parentSessionHash, { root, staleMs: 500, retentionMs: 5000, now: () => 2200 });
  assert.equal(retained.find((item) => item.childId === doneId)?.totalTokens, 7);
  const expired = await readSnapshots(first.parentSessionHash, { root, staleMs: 500, retentionMs: 5000, now: () => 7000 });
  assert.equal(expired.length, 0);
});

const parent = (overrides: Record<string, unknown> = {}) => ({
  samples: [], currentTps: 20, peakTps: 20, meanTps: 20, decodeTokens: 10, totalTokens: 10, totalEstimated: true,
  seriesEstimated: true as const, elapsedMs: 1000, startedAt: 100, requestStartedAt: 100, ttft: 80, state: "streaming" as const, ...overrides,
});

test("interactive max and aggregate sum keep independent weighted means, peaks, and idle-gap exclusion", () => {
  const aggregate = new FleetAggregator();
  aggregate.aggregate(parent(), [], 1000, 10000);
  const second = aggregate.aggregate(parent({ currentTps: 10 }), [snapshot({ currentTps: 40, totalTokens: 4, decodeTokens: 4 })], 2000, 10000);
  assert.equal(second.currentTps, 40, "interactive TPS is the fastest one decoder, not the sum");
  assert.equal(second.aggregateCurrentTps, 50);
  assert.equal(second.peakTps, 40);
  assert.equal(second.aggregatePeakTps, 50);
  assert.equal(second.meanTps, 20, "the parent-only first interval remains request history");
  assert.equal(second.aggregateMeanTps, 20);
  const idle = aggregate.aggregate(parent({ state: "paused", currentTps: 0 }), [], 3000, 10000);
  assert.equal(idle.meanTps, 30);
  assert.equal(idle.aggregateMeanTps, 35);
  const resumed = aggregate.aggregate(parent({ state: "complete", currentTps: 0 }), [snapshot({ currentTps: 40 })], 4000, 10000);
  assert.equal(resumed.meanTps, 30, "paused-to-active boundary excludes the idle interval");
  assert.equal(resumed.aggregateMeanTps, 35);
  const continued = aggregate.aggregate(parent({ state: "complete", currentTps: 0 }), [snapshot({ currentTps: 20 })], 5000, 10000);
  assert.ok(Math.abs(continued.meanTps - 100 / 3) < 1e-9);
  assert.ok(Math.abs(continued.aggregateMeanTps! - 110 / 3) < 1e-9);
  assert.equal(continued.activeChildren.length, 1);
});

test("root first response is not shortened by a later child-local TTFT", () => {
  const aggregate = new FleetAggregator();
  const result = aggregate.aggregate(parent({ ttft: 80 }), [snapshot({ firstResponseMs: 1 })], 1_000);
  assert.equal(result.ttft, 80);
});

test("parent-only interactive and aggregate metrics are equal", () => {
  const aggregate = new FleetAggregator();
  const first = aggregate.aggregate(parent({ currentTps: 17, peakTps: 17 }), [], 1000);
  const second = aggregate.aggregate(parent({ currentTps: 9 }), [], 2000);
  assert.equal(first.currentTps, first.aggregateCurrentTps);
  assert.equal(second.currentTps, second.aggregateCurrentTps);
  assert.equal(second.peakTps, second.aggregatePeakTps);
  assert.equal(second.meanTps, second.aggregateMeanTps);
});

test("new parent request resets timeline and retained children are filtered by parent start", () => {
  const aggregate = new FleetAggregator();
  aggregate.aggregate(parent({ startedAt: 100, currentTps: 80 }), [snapshot({ startedAt: 100, currentTps: 30 })], 1000);
  const next = aggregate.aggregate(parent({ requestStartedAt: 1_900, startedAt: 2_000, currentTps: 7, totalTokens: 2 }), [], 2100);
  assert.equal(next.currentTps, 7);
  assert.equal(next.aggregateCurrentTps, 7);
  assert.equal(next.samples.length, 1, "new request has no prior timeline points");
  assert.equal(next.totalTokens, 2);
  const retained = [snapshot({ startedAt: 100 }), snapshot({ childId: childIdForRun("new", 0), startedAt: 2_000 })];
  assert.deepEqual(filterSnapshotsForRequest(retained, 2_000).map((item) => item.startedAt), [2_000]);
});

test("duplicate child indexes receive distinct opaque suffixes", () => {
  const aggregate = new FleetAggregator();
  const children = [
    snapshot({ childId: "aaaa000000000000000000000000000000000000000000000000000000000000", index: 3 }),
    snapshot({ childId: "aaab000000000000000000000000000000000000000000000000000000000000", index: 3 }),
  ];
  const result = aggregate.aggregate(parent(), children, 1_000);
  const labels = result.decoderSummaries.filter((summary) => summary.label.startsWith("Child 3-")).map((summary) => summary.label);
  assert.equal(new Set(labels).size, 2);
  assert.ok(labels.every((label) => /^Child 3-[a-f0-9]+$/.test(label)));
});

test("whole-request timeline is bounded while retaining endpoints and a spike", () => {
  const aggregate = new FleetAggregator();
  for (let i = 0; i < 80; i++) {
    aggregate.aggregate(parent({ currentTps: i === 8 ? 999 : 5 }), [], 1_000 + i * 250, 1_000, 250);
  }
  const result = aggregate.aggregate(parent({ currentTps: 6 }), [], 21_000, 1_000, 250);
  assert.ok(result.samples.length <= 16);
  assert.equal(result.samples[0]!.timestamp, 1_000);
  assert.equal(result.samples.at(-1)!.timestamp, 21_000);
  assert.ok(result.samples.some((point) => point.decodeTps === 999), "adaptive buckets retain the early spike");
});

test("completion freezes end-to-end wall time from user request and a late child reopens it", () => {
  const aggregate = new FleetAggregator();
  const completeParent = parent({ state: "complete", currentTps: 0, requestStartedAt: 50, startedAt: 100 });
  const done = aggregate.aggregate(completeParent, [], 1_000);
  const frozen = aggregate.aggregate(completeParent, [], 2_000);
  assert.equal(done.wallMs, 950, "wall time includes the 50ms before decode began");
  assert.equal(frozen.wallMs, 950);
  assert.equal(frozen.samples.length, done.samples.length, "completion polling does not append an idle tail");
  const late = snapshot({ childId: childIdForRun("late", 0), startedAt: 100, state: "streaming", currentTps: 25 });
  const reopened = aggregate.aggregate(completeParent, [late], 3_000);
  assert.equal(reopened.state, "streaming");
  assert.equal(reopened.wallMs, 2_950);
  const completed = aggregate.aggregate(completeParent, [{ ...late, state: "complete", currentTps: 0 }], 4_000);
  assert.equal(completed.state, "complete");
  assert.equal(completed.wallMs, 3_950);
});

test("zero-token estimated children do not taint an authoritative fleet total", () => {
  const aggregate = new FleetAggregator();
  const result = aggregate.aggregate(parent({ totalTokens: 42, totalEstimated: false }), [snapshot({ totalTokens: 0, totalEstimated: true })], 1000);
  assert.equal(result.totalTokens, 42);
  assert.equal(result.totalEstimated, false);
});

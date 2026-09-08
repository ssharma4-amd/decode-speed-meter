import assert from "node:assert/strict";
import test from "node:test";
import { UniformSpeedSampler } from "../src/sampler";

test("uniform sampler records decode zeroes, bounds history, and retains full-run peak", () => {
  const sampler = new UniformSpeedSampler(1000, 250);
  sampler.sample(0, 0, 0);
  const active = sampler.sample(250, 10, 8);
  const stalled = sampler.sample(500, 10, 6);
  assert.equal(active.decodeTps, 40);
  assert.ok(active.smoothedTps! > 8 && active.smoothedTps! < 9);
  assert.equal(active.meanTps, 8);
  assert.equal(stalled.decodeTps, 0);
  assert.ok(stalled.smoothedTps! > 6.8 && stalled.smoothedTps! < 7);
  assert.equal(stalled.meanTps, 6);

  for (let at = 750; at <= 4000; at += 250) sampler.sample(at, 10, 4);
  assert.ok(sampler.getSamples().length <= 6);
  assert.ok(sampler.getSamples().every((sample) => sample.timestamp >= 3000));
  assert.equal(sampler.peakTps, 40);
  assert.ok(sampler.smoothedPeakTps > 8 && sampler.smoothedPeakTps < 9);
});

test("rebase prevents a paused interval from becoming an artificial low speed", () => {
  const sampler = new UniformSpeedSampler(1000, 250);
  sampler.sample(0, 0, 0);
  sampler.sample(250, 5, 20);
  sampler.rebase(10_000, 5);
  const resumed = sampler.sample(10_250, 10, 20);
  assert.equal(resumed.decodeTps, 20);
  assert.ok(resumed.smoothedTps! > 7.8 && resumed.smoothedTps! < 8);
});

test("reset clears history, baseline, and peak", () => {
  const sampler = new UniformSpeedSampler(1000, 250);
  sampler.sample(0, 0, 0);
  sampler.sample(250, 4, 16);
  sampler.reset();
  const fresh = sampler.sample(500, 4, 0);
  assert.equal(fresh.decodeTps, 0);
  assert.equal(sampler.peakTps, 0);
});

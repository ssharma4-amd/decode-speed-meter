import assert from "node:assert/strict";
import test from "node:test";
import { Validator } from "../src/validation";

const valid = {
  tpsSlow: 0,
  tpsMedium: 15,
  tpsFast: 30,
  tpsBlazing: 45,
  colorSlow: "#ff4444",
  colorMedium: "#ffaa00",
  colorFast: "#00ff88",
  colorBlazing: "#44ddff",
  slidingWindow: 1000,
  display: "tps" as const,
  useProviderTokens: false,
  countStrategy: "direct" as const,
  endTpsBehavior: "average" as const,
  icon: "⚡",
  updateInterval: 0,
  graphEnabled: true,
  graphHistoryMs: 30000,
  graphSampleInterval: 250,
  graphHeight: 6,
  includeSubagents: true,
  subagentStaleMs: 3000,
  subagentRetentionMs: 600000,
};

test("graph validation accepts inclusive boundaries and rejects out-of-range values", () => {
  const atBounds = Validator.validate({
    ...valid,
    graphHistoryMs: 1000,
    graphSampleInterval: 1000,
    graphHeight: 12,
  });
  assert.equal(atBounds.config.graphHistoryMs, 1000);
  assert.equal(atBounds.config.graphSampleInterval, 1000);
  assert.equal(atBounds.config.graphHeight, 12);

  const invalid = Validator.validate({
    ...valid,
    graphEnabled: "yes",
    graphHistoryMs: 120001,
    graphSampleInterval: 99,
    graphHeight: 2,
  } as unknown as typeof valid);
  assert.equal(invalid.config.graphEnabled, true);
  assert.equal(invalid.config.graphHistoryMs, 30000);
  assert.equal(invalid.config.graphSampleInterval, 250);
  assert.equal(invalid.config.graphHeight, 6);
  assert.equal(invalid.errors.length, 4);
});

test("subagent freshness is at least two child report intervals", () => {
  const corrected = Validator.validate({ ...valid, graphSampleInterval: 1000, subagentStaleMs: 500 });
  assert.equal(corrected.config.subagentStaleMs, 3000);
  assert.ok(corrected.errors.some((error) => error.includes("child reports cannot outlive freshness")));
  const derived = Validator.validate({ ...valid, graphSampleInterval: 1000, subagentStaleMs: 1500 });
  assert.equal(derived.config.subagentStaleMs, 3000);
  assert.ok(derived.config.subagentStaleMs >= 2 * derived.config.graphSampleInterval);
});

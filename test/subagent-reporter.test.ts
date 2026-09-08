import assert from "node:assert/strict";
import test from "node:test";
import { TokenSpeedEngine } from "../src/engine";
import { SubagentReporter } from "../src/subagent-reporter";

const environment = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_CHILD_INDEX"] as const;

test("child reporter fails closed without a run ID or valid nonnegative integer index", () => {
  const before = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  try {
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = "parent";
    delete process.env.PI_SUBAGENT_RUN_ID;
    process.env.PI_SUBAGENT_CHILD_INDEX = "0";
    const reporter = new SubagentReporter(new TokenSpeedEngine(), () => 250);
    assert.equal(reporter.enabled, false);
    process.env.PI_SUBAGENT_RUN_ID = "private-run";
    process.env.PI_SUBAGENT_CHILD_INDEX = "-1";
    assert.equal(reporter.enabled, false);
    process.env.PI_SUBAGENT_CHILD_INDEX = "not-a-number";
    assert.equal(reporter.enabled, false);
    process.env.PI_SUBAGENT_CHILD_INDEX = "2";
    assert.equal(reporter.enabled, true);
  } finally {
    for (const key of environment) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

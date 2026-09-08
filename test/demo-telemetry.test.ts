import assert from "node:assert/strict";
import test from "node:test";
import { DemoTelemetry } from "../demo/telemetry";

test("demo telemetry captures a short RPC response and authoritative total", () => {
  const originalNow = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    const telemetry = new DemoTelemetry(() => now);
    telemetry.handleRpcEvent({ type: "message_start", message: { role: "user", content: "hello" } });
    now = 200;
    telemetry.handleRpcEvent({ type: "agent_start" });
    telemetry.handleRpcEvent({ type: "message_start", message: { role: "assistant", content: [] } });
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    now = 250;
    telemetry.handleRpcEvent({ type: "message_update", usage: { output: 1 }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    now = 350;
    telemetry.handleRpcEvent({
      type: "agent_end",
      messages: [{ role: "assistant", usage: { output: 7 } }],
    });

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.state, "complete");
    assert.equal(snapshot.totalTokens, 7);
    assert.equal(snapshot.totalEstimated, false);
    assert.equal(snapshot.ttftMs, 150);
    assert.ok(snapshot.timeline.length >= 2);
    assert.ok(snapshot.peakTps > 0);
    assert.equal(snapshot.wallMs, 250);
  } finally {
    Date.now = originalNow;
  }
});

test("content-block starts do not create near-zero-interval peak samples", () => {
  const originalNow = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    const telemetry = new DemoTelemetry(() => now);
    telemetry.handleRpcEvent({ type: "message_start", message: { role: "user" } });
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
    now = 101;
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
    now = 201;
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    now = 301;
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    now = 401;
    telemetry.handleRpcEvent({ type: "agent_end", messages: [] });
    assert.ok(telemetry.snapshot().peakTps < 100);
  } finally {
    Date.now = originalNow;
  }
});

test("demo telemetry excludes a tool pause until generation resumes", () => {
  const originalNow = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    const telemetry = new DemoTelemetry(() => now);
    telemetry.handleRpcEvent({ type: "message_start", message: { role: "user" } });
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
    now = 150;
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end" } });
    now = 5150;
    assert.equal(telemetry.sample(), false);
    telemetry.handleRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    now = 5250;
    telemetry.sample();
    assert.ok(telemetry.snapshot().decodeMs < 1000);
  } finally {
    Date.now = originalNow;
  }
});

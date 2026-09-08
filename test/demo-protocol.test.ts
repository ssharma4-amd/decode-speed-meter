import assert from "node:assert/strict";
import test from "node:test";
import { JsonlDecoder, isAllowedOrigin, validateClientCommand } from "../demo/protocol";

test("demo bridge exposes only its bounded RPC command allowlist", () => {
  assert.deepEqual(validateClientCommand({ type: "prompt", message: "hello" }), { ok: true, command: { type: "prompt", message: "hello" } });
  assert.equal(validateClientCommand({ type: "prompt", message: "" }).ok, false);
  assert.equal(validateClientCommand({ type: "bash", command: "rm -rf /" }).ok, false);
  assert.equal(validateClientCommand({ type: "set_model", provider: "x", modelId: "y" }).ok, false);
  assert.deepEqual(validateClientCommand({ type: "extension_ui_response", id: "one", confirmed: true }), {
    ok: true,
    command: { type: "extension_ui_response", id: "one", confirmed: true },
  });
});

test("JSONL decoder uses LF framing and preserves Unicode separators inside JSON", () => {
  const values: unknown[] = [];
  const errors: Error[] = [];
  const decoder = new JsonlDecoder((value) => values.push(value), (error) => errors.push(error));
  const encoded = Buffer.from('{"text":"one\u2028two"}\r\n{"type":"agent_start"}\n');
  decoder.push(encoded.subarray(0, 11));
  decoder.push(encoded.subarray(11));
  decoder.end();
  assert.deepEqual(values, [{ text: "one\u2028two" }, { type: "agent_start" }]);
  assert.deepEqual(errors, []);
});

test("WebSocket origin validation permits only same local demo origins", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:8790", 8790), true);
  assert.equal(isAllowedOrigin("http://localhost:8790", 8790), true);
  assert.equal(isAllowedOrigin("https://example.com", 8790), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999", 8790), false);
});

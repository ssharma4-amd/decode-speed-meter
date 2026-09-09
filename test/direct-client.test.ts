import assert from "node:assert/strict";
import test from "node:test";
import { DirectInferenceClient } from "../demo/direct-client";

test("direct client streams OpenAI-compatible SSE and preserves provider usage", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    const body = [
      'data: {"choices":[{"delta":{"content":"DIRECT"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"_OK"}}]}',
      '',
      'data: {"choices":[],"usage":{"completion_tokens":2}}',
      '',
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const events: Record<string, unknown>[] = [];
    const client = new DirectInferenceClient({
      baseUrl: "https://gateway.test/v1",
      model: "test-model",
      apiKey: "secret",
      apiVersion: "preview",
      user: "tester",
      timeoutMs: 5_000,
      emit: (event) => events.push(event),
      onError: (message) => { throw new Error(message); },
    });
    await client.prompt("Say hello");

    assert.equal(calls[0]?.url, "https://gateway.test/v1/chat/completions");
    assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer secret");
    const request = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, {
      include_usage: true,
      continuous_usage_stats: true,
    });
    assert.equal(request.messages[0].content, "Say hello");
    assert.equal(events.find((event) => event.type === "agent_start")?.type, "agent_start");
    assert.deepEqual(events.filter((event) => event.type === "message_update").map((event) => (event.assistantMessageEvent as Record<string, unknown>).type), ["thinking_start", "text_start", "text_delta", "text_delta"]);
    const end = events.find((event) => event.type === "agent_end");
    assert.deepEqual(end?.messages, [{ role: "assistant", usage: { output: 2 } }]);
    assert.deepEqual(client.messages().at(-1)?.content, [{ type: "text", text: "DIRECT_OK" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

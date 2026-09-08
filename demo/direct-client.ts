import type { DemoPhase } from "./telemetry";

type Emit = (event: Record<string, unknown>) => void;
type ChatMessage = { role: "user" | "assistant"; content: string };
type DirectClientOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiVersion?: string;
  user?: string;
  emit: Emit;
  onError: (message: string) => void;
};

/** Minimal server-side OpenAI Chat Completions client for vLLM-compatible gateways. */
export class DirectInferenceClient {
  private readonly history: ChatMessage[] = [];
  private controller?: AbortController;
  private streaming = false;

  constructor(private readonly options: DirectClientOptions) {}

  get isStreaming(): boolean { return this.streaming; }

  state(): Record<string, unknown> {
    return {
      model: {
        id: this.options.model,
        name: this.options.model,
        provider: "AMD gateway",
        api: "openai-chat-completions",
        baseUrl: this.options.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      thinkingLevel: "off",
      isStreaming: this.streaming,
      isCompacting: false,
      sessionId: "direct-gateway-session",
      messageCount: this.history.length,
      pendingMessageCount: 0,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    };
  }

  messages(): { role: string; content: { type: "text"; text: string }[] }[] {
    return this.history.map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.content }],
    }));
  }

  async prompt(message: string): Promise<void> {
    if (this.streaming) {
      this.options.onError("The direct gateway is already generating a response.");
      return;
    }

    const userMessage = message.trim();
    this.history.push({ role: "user", content: userMessage });
    this.options.emit({ type: "agent_start" });
    this.options.emit({ type: "message_start", message: { role: "user", content: userMessage } });
    this.options.emit({ type: "message_start", message: { role: "assistant", content: [] } });

    const controller = new AbortController();
    this.controller = controller;
    this.streaming = true;
    let assistant = "";
    let usageOutput: number | undefined;
    let settled = false;

    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      if (assistant) this.history.push({ role: "assistant", content: assistant });
      if (error) this.options.onError(error);
      this.options.emit({
        type: "agent_end",
        messages: usageOutput === undefined ? [] : [{ role: "assistant", usage: { output: usageOutput } }],
      });
      this.options.emit({ type: "agent_settled" });
      this.controller = undefined;
      this.streaming = false;
    };

    try {
      const response = await fetch(this.completionsUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.options.model,
          messages: this.history,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Gateway returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
      }
      if (!response.body) throw new Error("Gateway returned no streaming response body");

      let started = false;
      for await (const payload of readSse(response.body)) {
        if (payload === "[DONE]") break;
        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(payload) as Record<string, unknown>; }
        catch { continue; }

        const usage = readUsage(chunk);
        if (usage !== undefined) usageOutput = usage;
        const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
        const delta = record(choice?.delta);
        if (!delta) continue;

        const reasoning = firstText(delta, ["reasoning_content", "reasoning", "reasoning_text"]);
        if (reasoning) {
          if (!started) {
            this.options.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
            started = true;
          }
          this.options.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: reasoning }, usage: usageEvent(usageOutput) });
        }

        const content = textContent(delta.content);
        if (content) {
          if (!started || phaseWasThinking(delta, reasoning)) {
            this.options.emit({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
            started = true;
          }
          assistant += content;
          this.options.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: content }, usage: usageEvent(usageOutput) });
        }
      }
      finish();
    } catch (error) {
      if (controller.signal.aborted) finish();
      else finish(error instanceof Error ? error.message : String(error));
    }
  }

  abort(): void { this.controller?.abort(); }

  newSession(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.streaming = false;
    this.history.length = 0;
  }

  private completionsUrl(): string {
    const base = this.options.baseUrl.replace(/\/$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
      headers["Ocp-Apim-Subscription-Key"] = this.options.apiKey;
    }
    if (this.options.apiVersion) headers["api-version"] = this.options.apiVersion;
    if (this.options.user) headers.user = this.options.user;
    return headers;
  }
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = record(part);
    return typeof item?.text === "string" ? item.text : "";
  }).join("");
}

function firstText(value: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) if (typeof value[field] === "string" && value[field]) return value[field] as string;
  return "";
}

function readUsage(chunk: Record<string, unknown>): number | undefined {
  const usage = record(chunk.usage);
  if (!usage) return undefined;
  for (const key of ["completion_tokens", "output_tokens", "output"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function usageEvent(output: number | undefined): Record<string, unknown> | undefined {
  return output === undefined ? undefined : { output };
}

// A reasoning field and content may coexist in a single chunk. Content should
// transition the dashboard into output after reasoning has started.
function phaseWasThinking(delta: Record<string, unknown>, reasoning: string): boolean {
  return Boolean(reasoning && delta.content);
}

// Keep this import-free marker useful to callers documenting emitted phases.
export type DirectPhase = DemoPhase;

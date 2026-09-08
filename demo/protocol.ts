import { StringDecoder } from "node:string_decoder";

export const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;
export const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type ClientCommandResult =
  | { ok: true; command: JsonRecord }
  | { ok: false; error: string };

/** Allow only the small native Pi RPC surface exposed by the demo. */
export function validateClientCommand(value: unknown): ClientCommandResult {
  const input = record(value);
  if (!input || typeof input.type !== "string") return { ok: false, error: "Invalid command" };

  if (input.type === "prompt") {
    if (typeof input.message !== "string" || input.message.trim().length === 0) return { ok: false, error: "Prompt is empty" };
    if (Buffer.byteLength(input.message, "utf8") > MAX_CLIENT_MESSAGE_BYTES) return { ok: false, error: "Prompt is too large" };
    const streamingBehavior = input.streamingBehavior;
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
      return { ok: false, error: "Invalid streaming behavior" };
    }
    return { ok: true, command: { type: "prompt", message: input.message, ...(streamingBehavior ? { streamingBehavior } : {}) } };
  }

  if (input.type === "abort" || input.type === "new_session" || input.type === "get_state" || input.type === "get_messages") {
    return { ok: true, command: { type: input.type } };
  }

  if (input.type === "extension_ui_response") {
    if (typeof input.id !== "string" || input.id.length < 1 || input.id.length > 200) return { ok: false, error: "Invalid UI response id" };
    if (input.cancelled === true) return { ok: true, command: { type: input.type, id: input.id, cancelled: true } };
    if (typeof input.confirmed === "boolean") return { ok: true, command: { type: input.type, id: input.id, confirmed: input.confirmed } };
    if (typeof input.value === "string" && Buffer.byteLength(input.value, "utf8") <= MAX_CLIENT_MESSAGE_BYTES) {
      return { ok: true, command: { type: input.type, id: input.id, value: input.value } };
    }
    return { ok: false, error: "Invalid UI response" };
  }

  return { ok: false, error: "Command is not available in this demo" };
}

/** Strict LF-framed JSONL decoder matching Pi RPC's protocol requirements. */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly onValue: (value: unknown) => void, private readonly onError: (error: Error) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  private drain(flush: boolean): void {
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_LINE_BYTES && !this.buffer.includes("\n")) {
      this.onError(new Error("Pi RPC emitted an oversized JSONL record"));
      this.buffer = "";
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = stripCarriageReturn(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      this.parse(line);
    }
    if (flush && this.buffer.length > 0) {
      this.parse(stripCarriageReturn(this.buffer));
      this.buffer = "";
    }
  }

  private parse(line: string): void {
    if (!line) return;
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
      this.onError(new Error("Pi RPC emitted an oversized JSONL record"));
      return;
    }
    try { this.onValue(JSON.parse(line)); }
    catch (error) { this.onError(error instanceof Error ? error : new Error(String(error))); }
  }
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") && Number(url.port || 80) === port;
  } catch { return false; }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

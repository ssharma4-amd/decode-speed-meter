import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DirectInferenceClient } from "./direct-client";
import { JsonlDecoder, isAllowedOrigin, MAX_CLIENT_MESSAGE_BYTES, validateClientCommand } from "./protocol";
import { DemoTelemetry } from "./telemetry";

const host = "127.0.0.1";
const port = integer(process.env.PI_SPEED_DEMO_PORT, 8790, 1024, 65535);
const cwd = process.env.PI_SPEED_DEMO_CWD || process.cwd();
const piBin = process.env.PI_BIN || "pi";
const token = randomBytes(24).toString("base64url");
const publicDir = join(process.cwd(), "demo", "public");
const mode = process.env.PI_SPEED_DEMO_MODE || (process.env.LLM_GATEWAY_KEY || process.env.PI_OPENAI_BASE_URL || process.env.PI_OPENAI_MODEL ? "direct" : "pi");
const directMode = mode === "direct";
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

if (mode !== "direct" && mode !== "pi") throw new Error(`Unsupported PI_SPEED_DEMO_MODE: ${mode}`);

let telemetry = new DemoTelemetry();
let closed = false;
let requestCounter = 0;
let agent: ChildProcessWithoutNullStreams | undefined;

const server = createServer((request, response) => { void serve(request, response); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

const decoder = new JsonlDecoder(
  (value) => emitRpc(value),
  (error) => broadcast({ type: "bridge_error", message: `Invalid Pi RPC output: ${error.message}` }),
);

const directBaseUrl = process.env.PI_OPENAI_BASE_URL || "https://llm-api.amd.com/OpenAI";
const directIsAmdGateway = directBaseUrl.includes("llm-api.amd.com");
const directClient = directMode ? new DirectInferenceClient({
  baseUrl: directBaseUrl,
  model: process.env.PI_OPENAI_MODEL || "gpt-5.6-sol",
  apiKey: process.env.PI_OPENAI_API_KEY || process.env.LLM_GATEWAY_KEY,
  apiVersion: process.env.PI_OPENAI_API_VERSION ?? (directIsAmdGateway ? "preview" : undefined),
  user: process.env.PI_OPENAI_USER ?? (directIsAmdGateway ? "anandaku" : undefined),
  emit: emitRpc,
  onError: (message) => broadcast({ type: "bridge_error", message }),
}) : undefined;

if (!directMode) {
  const piArgs = ["--mode", "rpc"];
  if (process.env.PI_SPEED_DEMO_PERSIST !== "1") piArgs.push("--no-session");
  agent = spawn(piBin, piArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  agent.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  agent.stdout.on("end", () => decoder.end());
  agent.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.error(`[pi] ${message}`);
      broadcast({ type: "bridge_notice", message: "Pi wrote a diagnostic to the demo server console." });
    }
  });
  agent.on("error", (error) => {
    console.error(`Could not start ${piBin}:`, error.message);
    broadcast({ type: "bridge_error", message: `Could not start Pi: ${error.message}` });
  });
  agent.on("exit", (code, signal) => {
    if (closed) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    console.error(`Pi RPC exited with ${reason}`);
    broadcast({ type: "bridge_error", message: `Pi RPC exited with ${reason}` });
  });
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const authorized = url.pathname === "/ws" && url.searchParams.get("token") === token && isAllowedOrigin(request.headers.origin, port);
  if (!authorized) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
});

sockets.on("connection", (socket) => {
  send(socket, { type: "hello", protocolVersion: 1, cwd, mode });
  send(socket, { type: "telemetry", snapshot: telemetry.snapshot() });
  if (directClient) {
    sendResponse(socket, nextId("state"), "get_state", directClient.state());
    sendResponse(socket, nextId("messages"), "get_messages", { messages: directClient.messages() });
  } else {
    sendPi({ id: nextId("state"), type: "get_state" });
    sendPi({ id: nextId("messages"), type: "get_messages" });
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      send(socket, { type: "bridge_error", message: "Binary WebSocket messages are not supported." });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString()); }
    catch {
      send(socket, { type: "bridge_error", message: "Invalid JSON command." });
      return;
    }
    const checked = validateClientCommand(parsed);
    if (!checked.ok) {
      send(socket, { type: "bridge_error", message: checked.error });
      return;
    }
    handleCommand(checked.command);
  });
});

const sampleTimer = setInterval(() => {
  if (!telemetry.isStreaming) return;
  telemetry.sample();
  broadcastTelemetry();
}, 100);
sampleTimer.unref();

server.listen(port, host, () => {
  const url = `http://${host}:${port}/#token=${token}`;
  console.log("\nAMD Megakernels demo is ready.");
  console.log(`Open: ${url}`);
  console.log(`Mode: ${mode === "direct" ? "direct OpenAI-compatible gateway" : "Pi RPC compatibility"}`);
  if (directClient) console.log(`Gateway: ${directBaseUrl}`);
  console.log(`Session persistence: ${process.env.PI_SPEED_DEMO_PERSIST === "1" ? "enabled" : "disabled (default)"}`);
  console.log("Press Ctrl+C to stop.\n");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function handleCommand(command: Record<string, unknown>): void {
  if (!directClient) {
    if (command.type === "new_session") {
      telemetry = new DemoTelemetry();
      broadcastTelemetry();
    }
    sendPi({ id: nextId(String(command.type)), ...command });
    return;
  }

  const type = command.type;
  if (type === "prompt") {
    void directClient.prompt(String(command.message));
  } else if (type === "abort") {
    directClient.abort();
  } else if (type === "new_session") {
    directClient.newSession();
    telemetry = new DemoTelemetry();
    broadcastTelemetry();
    emitRpc({ id: nextId("state"), type: "response", command: "get_state", success: true, data: directClient.state() });
  } else if (type === "get_state") {
    emitRpc({ id: nextId("state"), type: "response", command: "get_state", success: true, data: directClient.state() });
  } else if (type === "get_messages") {
    emitRpc({ id: nextId("messages"), type: "response", command: "get_messages", success: true, data: { messages: directClient.messages() } });
  } else if (type === "extension_ui_response") {
    emitRpc({ id: nextId("ui"), type: "response", command: "extension_ui_response", success: true, data: {} });
  }
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const entry = staticFiles.get(url.pathname);
  if (request.method !== "GET" || !entry) {
    response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(join(publicDir, entry.file));
    response.writeHead(200, { ...securityHeaders(entry.type), "Cache-Control": "no-store", "Content-Length": body.length });
    response.end(body);
  } catch {
    response.writeHead(500, securityHeaders("text/plain; charset=utf-8"));
    response.end("Demo asset unavailable");
  }
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://${host}:${port} ws://localhost:${port}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendPi(command: Record<string, unknown>): void {
  if (!agent?.stdin.writable) {
    broadcast({ type: "bridge_error", message: "Pi RPC input is unavailable." });
    return;
  }
  agent.stdin.write(`${JSON.stringify(command)}\n`);
}

function emitRpc(value: unknown): void {
  if (!isRecord(value)) return;
  broadcast({ type: "rpc", event: value });
  if (typeof value.type === "string" && telemetry.handleRpcEvent(value)) broadcastTelemetry();
}

function sendResponse(socket: WebSocket, id: string, command: string, data: unknown): void {
  send(socket, { type: "rpc", event: { id, type: "response", command, success: true, data } });
}

function broadcastTelemetry(): void { broadcast({ type: "telemetry", snapshot: telemetry.snapshot() }); }

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function nextId(kind: string): string {
  requestCounter += 1;
  return `demo:${kind}:${requestCounter}`;
}

function shutdown(): void {
  if (closed) return;
  closed = true;
  clearInterval(sampleTimer);
  directClient?.abort();
  for (const socket of sockets.clients) socket.close(1001, "Server shutting down");
  sockets.close();
  server.close();
  if (agent?.exitCode === null) agent.kill("SIGTERM");
  setTimeout(() => process.exit(0), 100).unref();
}

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

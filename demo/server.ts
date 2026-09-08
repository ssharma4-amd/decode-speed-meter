import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { JsonlDecoder, isAllowedOrigin, MAX_CLIENT_MESSAGE_BYTES, validateClientCommand } from "./protocol";
import { DemoTelemetry } from "./telemetry";

const host = "127.0.0.1";
const port = integer(process.env.PI_SPEED_DEMO_PORT, 8790, 1024, 65535);
const cwd = process.env.PI_SPEED_DEMO_CWD || process.cwd();
const piBin = process.env.PI_BIN || "pi";
const token = randomBytes(24).toString("base64url");
const publicDir = join(process.cwd(), "demo", "public");
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

let telemetry = new DemoTelemetry();
let closed = false;
let requestCounter = 0;

const piArgs = ["--mode", "rpc"];
if (process.env.PI_SPEED_DEMO_PERSIST !== "1") piArgs.push("--no-session");
const agent: ChildProcessWithoutNullStreams = spawn(piBin, piArgs, {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const server = createServer((request, response) => { void serve(request, response); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

const decoder = new JsonlDecoder(
  (value) => {
    broadcast({ type: "rpc", event: value });
    if (isRecord(value) && telemetry.handleRpcEvent(value)) broadcastTelemetry();
  },
  (error) => broadcast({ type: "bridge_error", message: `Invalid Pi RPC output: ${error.message}` }),
);
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
  send(socket, { type: "hello", protocolVersion: 1, cwd });
  send(socket, { type: "telemetry", snapshot: telemetry.snapshot() });
  sendPi({ id: nextId("state"), type: "get_state" });
  sendPi({ id: nextId("messages"), type: "get_messages" });

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
    if (checked.command.type === "new_session") {
      telemetry = new DemoTelemetry();
      broadcastTelemetry();
    }
    sendPi({ id: nextId(String(checked.command.type)), ...checked.command });
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
  console.log("\nPi Speed Demo is ready.");
  console.log(`Open: ${url}`);
  console.log(`Agent cwd: ${cwd}`);
  console.log(`Session persistence: ${process.env.PI_SPEED_DEMO_PERSIST === "1" ? "enabled" : "disabled (default)"}`);
  console.log("Press Ctrl+C to stop.\n");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
    response.writeHead(200, {
      ...securityHeaders(entry.type),
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
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
  if (!agent.stdin.writable) {
    broadcast({ type: "bridge_error", message: "Pi RPC input is unavailable." });
    return;
  }
  agent.stdin.write(`${JSON.stringify(command)}\n`);
}

function broadcastTelemetry(): void {
  broadcast({ type: "telemetry", snapshot: telemetry.snapshot() });
}

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
  for (const socket of sockets.clients) socket.close(1001, "Server shutting down");
  sockets.close();
  server.close();
  if (agent.exitCode === null) agent.kill("SIGTERM");
  setTimeout(() => process.exit(0), 100).unref();
}

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

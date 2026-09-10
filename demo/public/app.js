const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const markdownParser = window.marked;
const markdownSanitizer = window.DOMPurify;
const markdownRenderer = markdownParser?.Renderer ? new markdownParser.Renderer() : undefined;
if (markdownRenderer) markdownRenderer.html = ({ text }) => escapeHtml(text);
const markdownSanitizeOptions = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["audio", "button", "embed", "form", "iframe", "input", "object", "script", "select", "source", "style", "textarea", "video"],
  FORBID_ATTR: ["style"],
};
const elements = {
  telemetry: document.querySelector(".telemetry"), connection: $("connection"), thinking: $("thinking-indicator"), output: $("output-indicator"),
  current: $("current-speed"), currentLabel: $("current-label"), meanSpeed: $("mean-speed"), peak: $("peak-speed"), total: $("total-tokens"), totalKind: $("total-kind"), first: $("first-response"),
  duration: $("duration"), requestState: $("request-state"), max: $("chart-max"), grid: $("chart-grid"), speed: $("speed-line"),
  mean: $("mean-line"), area: $("speed-area"), point: $("speed-point"), flame: $("flame-marker"), messages: $("messages"), welcome: $("welcome"),
  notice: $("notice"), form: $("composer"), prompt: $("prompt"), send: $("send"), abort: $("abort"), newSession: $("new-session"), model: $("model-name"),
};

let socket;
let connected = false;
let busy = false;
let reconnectDelay = 700;
let activeAssistant;
const toolElements = new Map();

buildGrid();
connect();

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.prompt.value.trim();
  if (!message || !connected) return;
  send({ type: "prompt", message, ...(busy ? { streamingBehavior: "followUp" } : {}) });
  elements.prompt.value = "";
  elements.prompt.focus();
});
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
elements.abort.addEventListener("click", () => send({ type: "abort" }));
elements.newSession.addEventListener("click", () => {
  if (!window.confirm("Start a fresh in-memory inference session?")) return;
  send({ type: "new_session" });
  clearConversation();
});

function connect() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) {
    setConnection("Missing connection token", "error");
    showNotice("Open the complete URL printed by npm run demo.");
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  setConnection("Connecting…");
  socket.addEventListener("open", () => {
    connected = true;
    reconnectDelay = 700;
    setConnection("Connected", "connected");
    syncControls();
  });
  socket.addEventListener("message", (event) => {
    try { handleServerMessage(JSON.parse(event.data)); }
    catch { showNotice("Received an invalid bridge message."); }
  });
  socket.addEventListener("close", () => {
    connected = false;
    busy = false;
    setConnection("Disconnected — reconnecting…", "error");
    syncControls();
    window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 1.7);
  });
  socket.addEventListener("error", () => setConnection("Connection error", "error"));
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function handleServerMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "telemetry") return renderTelemetry(message.snapshot);
  if (message.type === "bridge_error") return showNotice(message.message || "Bridge error");
  if (message.type === "bridge_notice") return showNotice(message.message || "Bridge notice", 3000);
  if (message.type === "rpc") handleRpc(message.event);
}

function handleRpc(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "agent_start") {
    busy = true;
    syncControls();
    return;
  }
  if (event.type === "agent_settled") {
    busy = false;
    syncControls();
    return;
  }
  if (event.type === "response") {
    if (!event.success) showNotice(event.error || `${event.command || "Command"} failed`);
    if (event.command === "get_state" && event.success) renderState(event.data);
    if (event.command === "get_messages" && event.success && Array.isArray(event.data?.messages)) renderHistory(event.data.messages);
    return;
  }
  if (event.type === "message_start") return handleMessageStart(event.message);
  if (event.type === "message_update") return handleMessageUpdate(event.assistantMessageEvent);
  if (event.type === "tool_execution_start") return updateTool(event.toolCallId, event.toolName, "running", event.args);
  if (event.type === "tool_execution_update") return updateTool(event.toolCallId, event.toolName, "running", event.partialResult);
  if (event.type === "tool_execution_end") return updateTool(event.toolCallId, event.toolName, event.isError ? "error" : "complete", event.result);
  if (event.type === "extension_ui_request") return handleExtensionUi(event);
  if (event.type === "extension_error") showNotice(`Extension error: ${event.error || "unknown error"}`);
}

function handleMessageStart(message) {
  if (!message || typeof message !== "object") return;
  if (message.role === "user") appendUser(extractText(message.content));
  if (message.role === "assistant") activeAssistant = appendAssistant();
}

function handleMessageUpdate(update) {
  if (!update || typeof update !== "object") return;
  if (!activeAssistant) activeAssistant = appendAssistant();
  if (update.type === "text_delta") appendAssistantText(activeAssistant, update.delta || "");
  if (update.type === "thinking_delta") {
    activeAssistant.thinking.hidden = false;
    activeAssistant.thinking.open = true;
    activeAssistant.thinkingText.textContent += update.delta || "";
  }
  if (update.type === "toolcall_start") updateTool(update.id, update.toolName, "preparing");
  if (update.type === "toolcall_delta") updateToolArgument(update.contentIndex, update.delta || "");
  if (update.type === "toolcall_end" && update.toolCall) updateTool(update.toolCall.id, update.toolCall.name, "prepared", update.toolCall.arguments);
  scrollToLatest();
}

function renderHistory(messages) {
  if (busy || activeAssistant) return;
  clearConversation();
  for (const message of messages) {
    if (message?.role === "user") appendUser(extractText(message.content));
    if (message?.role === "assistant") renderAssistantMessage(message);
    if (message?.role === "toolResult") updateTool(message.toolCallId, message.toolName, message.isError ? "error" : "complete", message.content);
  }
}

function renderAssistantMessage(message) {
  const view = appendAssistant();
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "text") view.markdown += block.text || "";
    if (block?.type === "thinking") {
      view.thinking.hidden = false;
      view.thinkingText.textContent += block.thinking || "";
    }
    if (block?.type === "toolCall") updateTool(block.id, block.name, "prepared", block.arguments);
  }
  renderAssistantMarkdown(view);
  activeAssistant = undefined;
}

function appendUser(content) {
  if (!content) return;
  hideWelcome();
  const message = node("article", "message user");
  message.textContent = content;
  elements.messages.append(message);
  scrollToLatest();
}

function appendAssistant() {
  hideWelcome();
  const message = node("article", "message assistant");
  message.append(node("div", "message-label", "Assistant"));
  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.hidden = true;
  thinking.append(node("summary", "", "Reasoning"));
  const thinkingText = node("pre");
  thinking.append(thinkingText);
  const answer = node("div", "answer");
  const tools = node("div", "tools");
  message.append(thinking, answer, tools);
  elements.messages.append(message);
  return { message, thinking, thinkingText, answer, tools, markdown: "", renderPending: false };
}

function appendAssistantText(view, text) {
  view.markdown += text;
  if (view.renderPending) return;
  view.renderPending = true;
  window.requestAnimationFrame(() => {
    view.renderPending = false;
    if (!view.answer.isConnected) return;
    renderAssistantMarkdown(view);
  });
}

function renderAssistantMarkdown(view) {
  if (!markdownParser?.parse || !markdownSanitizer?.sanitize) {
    view.answer.textContent = view.markdown;
    return;
  }

  const html = markdownParser.parse(view.markdown, { gfm: true, breaks: true, renderer: markdownRenderer });
  view.answer.innerHTML = markdownSanitizer.sanitize(html, markdownSanitizeOptions);
  decorateMarkdown(view.answer);
}

function decorateMarkdown(answer) {
  for (const code of answer.querySelectorAll("pre > code")) {
    const languageClass = Array.from(code.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length).replace(/[^a-z0-9_+#.-]/gi, "");
    if (language) code.parentElement.dataset.language = language;
  }

  for (const table of answer.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("table-scroll")) continue;
    const wrapper = node("div", "table-scroll");
    table.before(wrapper);
    wrapper.append(table);
  }

  for (const link of answer.querySelectorAll("a[href]")) {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}

function updateTool(id, name, state, payload) {
  if (!id) return;
  if (!activeAssistant) activeAssistant = appendAssistant();
  let view = toolElements.get(id);
  if (!view) {
    const details = document.createElement("details");
    details.className = "tool";
    const summary = node("summary");
    const output = node("pre");
    details.append(summary, output);
    activeAssistant.tools.append(details);
    view = { details, summary, output };
    toolElements.set(id, view);
  }
  view.details.classList.toggle("error", state === "error");
  view.summary.textContent = `${name || "tool"} · ${state}`;
  if (payload !== undefined) view.output.textContent = stringify(payload);
  scrollToLatest();
}

function updateToolArgument(contentIndex, delta) {
  const current = Array.from(toolElements.values()).at(-1);
  if (current) current.output.textContent += delta;
}

function renderState(state) {
  const model = state?.model;
  elements.model.textContent = model ? `${model.provider}/${model.id} · thinking ${state.thinkingLevel || "off"}` : "No model selected";
  busy = Boolean(state?.isStreaming);
  syncControls();
}

function renderTelemetry(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  elements.telemetry.classList.toggle("streaming", snapshot.state === "streaming");
  const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  const latestSmoothed = timeline.at(-1)?.currentTps;
  const liveCurrent = latestSmoothed === undefined ? snapshot.currentTps : latestSmoothed;
  // Once a turn completes, the last interval is normally zero because there
  // is no new token. Show the turn's average instead of a misleading 0.
  const displayCurrent = snapshot.state === "complete" ? snapshot.meanTps : liveCurrent;
  const waitingForFirstToken = snapshot.state === "streaming" && snapshot.decodeTokens === 0 && snapshot.ttftMs === 0;
  elements.currentLabel.textContent = snapshot.state === "complete"
    ? "Last turn average"
    : waitingForFirstToken ? "Waiting for first token" : "Interactive decode";
  elements.current.textContent = `${formatNumber(displayCurrent)} est. tok/s`;
  elements.meanSpeed.textContent = formatNumber(snapshot.meanTps);
  elements.peak.textContent = formatNumber(snapshot.peakTps);
  elements.total.textContent = `${snapshot.totalEstimated && snapshot.totalTokens ? "~" : ""}${Math.round(safe(snapshot.totalTokens)).toLocaleString()}`;
  elements.totalKind.textContent = snapshot.totalEstimated ? "estimated output" : "provider output";
  elements.first.textContent = duration(snapshot.ttftMs);
  elements.duration.textContent = duration(snapshot.wallMs);
  elements.requestState.textContent = snapshot.state || "idle";
  elements.thinking.classList.toggle("active", snapshot.phase === "thinking");
  elements.output.classList.toggle("active", snapshot.phase === "output" || snapshot.phase === "tool");
  renderChart(timeline);
}

function renderChart(points) {
  const width = 760, top = 13, bottom = 110;
  const maximum = Math.max(1, ...points.flatMap((point) => [safe(point.currentTps), safe(point.meanTps)]));
  elements.max.textContent = formatNumber(maximum);
  if (!points.length) {
    elements.speed.setAttribute("d", ""); elements.mean.setAttribute("d", ""); elements.area.setAttribute("d", "");
    elements.point.hidden = true; elements.flame.hidden = true; return;
  }
  const first = safe(points[0].timestamp), last = Math.max(first + 1, safe(points.at(-1).timestamp));
  const xy = (point, field) => [8 + (width - 16) * (safe(point.timestamp) - first) / (last - first), bottom - (bottom - top) * safe(point[field]) / maximum];
  const path = (field) => points.map((point, index) => `${index ? "L" : "M"}${xy(point, field).map((value) => value.toFixed(2)).join(",")}`).join(" ");
  const speedPath = path("currentTps");
  elements.speed.setAttribute("d", speedPath);
  elements.mean.setAttribute("d", path("meanTps"));
  const firstPoint = xy(points[0], "currentTps"), lastPoint = xy(points.at(-1), "currentTps");
  elements.area.setAttribute("d", `${speedPath} L${lastPoint[0]},${bottom} L${firstPoint[0]},${bottom} Z`);
  elements.point.hidden = points.length !== 1;
  elements.point.setAttribute("cx", String(lastPoint[0])); elements.point.setAttribute("cy", String(lastPoint[1]));
  const peak = points.reduce((best, point) => safe(point.currentTps) > safe(best.currentTps) ? point : best, points[0]);
  const peakPoint = xy(peak, "currentTps");
  elements.flame.hidden = false;
  elements.flame.setAttribute("transform", `translate(${peakPoint[0]} ${Math.max(18, peakPoint[1] - 7)})`);
}

function handleExtensionUi(request) {
  const id = request.id;
  if (!id) return;
  if (request.method === "confirm") {
    send({ type: "extension_ui_response", id, confirmed: window.confirm(`${request.title || "Confirm"}\n\n${request.message || ""}`) });
  } else if (request.method === "select") {
    const options = Array.isArray(request.options) ? request.options : [];
    const value = window.prompt(`${request.title || "Select"}\n\n${options.map((item, i) => `${i + 1}. ${item}`).join("\n")}\n\nEnter a number:`);
    const selected = options[Number(value) - 1];
    send(selected === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: selected });
  } else if (request.method === "input" || request.method === "editor") {
    const value = window.prompt(request.title || "Input", request.prefill || "");
    send(value === null ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value });
  } else if (request.method === "notify") {
    showNotice(request.message || "Notification", 4000);
  }
}

function syncControls() {
  elements.send.disabled = !connected;
  elements.abort.disabled = !connected || !busy;
  elements.newSession.disabled = !connected || busy;
}

function setConnection(text, className = "") {
  elements.connection.textContent = text;
  elements.connection.className = `connection ${className}`.trim();
}

function clearConversation() {
  elements.messages.replaceChildren(elements.welcome);
  elements.welcome.hidden = false;
  activeAssistant = undefined;
  toolElements.clear();
}

function hideWelcome() { elements.welcome.hidden = true; }
function scrollToLatest() { window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })); }
function safe(value) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0; }
function formatNumber(value) { return safe(value).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function duration(value) { const milliseconds = safe(value); return milliseconds ? milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s` : "—"; }
function stringify(value) { try { return typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { return String(value); } }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function extractText(content) { if (typeof content === "string") return content; return Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => item.text || "").join("") : ""; }
function node(tag, className = "", value = "") { const element = document.createElement(tag); if (className) element.className = className; if (value) element.textContent = value; return element; }
function showNotice(message, timeout = 6500) { elements.notice.textContent = message; elements.notice.hidden = false; window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => { elements.notice.hidden = true; }, timeout); }
function buildGrid() { for (let i = 0; i < 4; i++) { const line = document.createElementNS(NS, "line"); const y = 13 + i * 32; line.setAttribute("x1", "8"); line.setAttribute("x2", "752"); line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y)); line.setAttribute("class", "grid-line"); elements.grid.append(line); } }

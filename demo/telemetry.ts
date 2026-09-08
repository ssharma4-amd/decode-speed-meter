import { TokenSpeedEngine } from "../src/engine";

export type DemoPhase = "idle" | "thinking" | "output" | "tool";
type DemoState = "streaming" | "paused" | "complete" | "idle";
interface DemoSnapshot {
  schemaVersion: 1;
  sessionHash: string;
  timestamp: number;
  requestStartedAt: number;
  state: DemoState;
  currentTps: number;
  meanTps: number;
  peakTps: number;
  aggregateCurrentTps: number;
  aggregateMeanTps: number;
  aggregatePeakTps: number;
  decodeTokens: number;
  totalTokens: number;
  totalEstimated: boolean;
  wallMs: number;
  decodeMs: number;
  ttftMs: number;
  timeline: { timestamp: number; currentTps: number; meanTps: number; aggregateTps: number }[];
  decoders: { label: string; currentTps: number; meanTps: number; peakTps: number; state: DemoState }[];
}

type RpcRecord = Record<string, unknown>;

const engineConfig = {
  slidingWindow: 1000,
  graphHistoryMs: 30000,
  graphSampleInterval: 100,
  countStrategy: "direct" as const,
  useProviderTokens: true,
  endTpsBehavior: "average" as const,
};

/** Adapts native Pi RPC events to the same numeric snapshot used by the extension dashboard. */
export class DemoTelemetry {
  private readonly engine = new TokenSpeedEngine();
  private completedAt = 0;
  private phase: DemoPhase = "idle";

  constructor(private readonly now: () => number = Date.now) {
    this.engine.initialize(engineConfig);
  }

  get isStreaming(): boolean { return this.engine.isStreaming; }
  get currentPhase(): DemoPhase { return this.phase; }

  handleRpcEvent(event: RpcRecord): boolean {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start") {
      const message = record(event.message);
      if (message?.role === "user") {
        this.engine.startTTFT();
        this.completedAt = 0;
        this.phase = "thinking";
        return true;
      }
      if (message?.role === "assistant") this.engine.beginAssistantResponse();
      return false;
    }

    if (type === "agent_start") {
      this.phase = "thinking";
      return true;
    }

    if (type === "message_update") {
      const update = record(event.assistantMessageEvent);
      const updateType = typeof update?.type === "string" ? update.type : "";
      if (updateType === "text_start" || updateType === "thinking_start" || updateType === "toolcall_start") {
        const wasStreaming = this.engine.isStreaming;
        this.engine.start();
        // Establish one zero-token baseline for the response. A streamed
        // response can contain several content-block starts in rapid
        // succession; sampling each one would divide by ~0 ms and fabricate
        // peaks such as hundreds of tok/s.
        if (!wasStreaming) this.engine.sampleGraph(this.now());
        this.phase = updateType === "text_start" ? "output" : updateType === "toolcall_start" ? "tool" : "thinking";
        return true;
      }
      if (updateType === "text_delta" || updateType === "thinking_delta" || updateType === "toolcall_delta") {
        this.engine.stopTTFT();
        const usage = record(event.usage);
        const output = number(usage?.output);
        this.engine.recordDelta(typeof update?.delta === "string" ? update.delta : "", output);
        this.phase = updateType === "text_delta" ? "output" : updateType === "toolcall_delta" ? "tool" : "thinking";
        return true;
      }
      if (updateType === "toolcall_end") {
        this.engine.pause();
        this.phase = "tool";
        return true;
      }
      return false;
    }

    if (type === "tool_execution_start" || type === "tool_execution_update") {
      this.phase = "tool";
      return true;
    }

    if (type === "agent_end") {
      if (this.engine.isStreaming) this.engine.sampleGraph(this.now());
      this.engine.stop();
      const messages = Array.isArray(event.messages) ? event.messages : [];
      let hasUsage = false;
      const total = messages.reduce((sum, item) => {
        const message = record(item);
        const usage = record(message?.usage);
        const output = message?.role === "assistant" ? number(usage?.output) : undefined;
        if (output === undefined) return sum;
        hasUsage = true;
        return sum + output;
      }, 0);
      this.engine.reconcileTotal(hasUsage ? total : undefined);
      this.completedAt = this.now();
      this.phase = "output";
      return true;
    }

    if (type === "agent_settled") {
      this.phase = "idle";
      return true;
    }
    return false;
  }

  sample(): boolean {
    return this.engine.sampleGraph(this.now());
  }

  snapshot(): DemoSnapshot & { phase: DemoPhase } {
    const metrics = this.engine.graphMetrics();
    const requestStartedAt = metrics.requestStartedAt || metrics.startedAt;
    const wallEnd = this.completedAt || this.now();
    return {
      schemaVersion: 1,
      sessionHash: "0".repeat(32),
      timestamp: this.now(),
      requestStartedAt,
      state: metrics.state,
      phase: this.phase,
      currentTps: metrics.currentTps,
      meanTps: metrics.meanTps,
      peakTps: metrics.peakTps,
      aggregateCurrentTps: metrics.currentTps,
      aggregateMeanTps: metrics.meanTps,
      aggregatePeakTps: metrics.peakTps,
      decodeTokens: metrics.decodeTokens,
      totalTokens: metrics.totalTokens,
      totalEstimated: metrics.totalEstimated,
      wallMs: requestStartedAt > 0 ? Math.max(0, wallEnd - requestStartedAt) : 0,
      decodeMs: metrics.elapsedMs,
      ttftMs: metrics.ttft,
      timeline: metrics.samples.map((sample) => ({
        timestamp: sample.timestamp,
        currentTps: sample.smoothedTps ?? sample.decodeTps,
        meanTps: sample.meanTps,
        aggregateTps: sample.smoothedTps ?? sample.decodeTps,
      })),
      decoders: [{
        label: "Parent",
        currentTps: metrics.state === "streaming" ? metrics.currentTps : 0,
        meanTps: metrics.meanTps,
        peakTps: metrics.peakTps,
        state: metrics.state,
      }],
    };
  }
}

function record(value: unknown): RpcRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

import { TokenSpeedEngine } from "./engine";
import { childIdForRun, hashSessionId, type SubagentSnapshot, writeSnapshot } from "./subagent-metrics";

const child = () => process.env.PI_SUBAGENT_CHILD === "1";

interface ChildIdentity {
  childId: string;
  index: number;
}

function childIdentity(): ChildIdentity | undefined {
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  const rawIndex = process.env.PI_SUBAGENT_CHILD_INDEX;
  if (!runId || !rawIndex || !/^\d+$/.test(rawIndex)) return undefined;
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) return undefined;
  return { index, childId: childIdForRun(runId, index) };
}

/** Child-only sampler/writer. It owns the child sampler so headless children never mount a TUI graph. */
export class SubagentReporter {
  private timer?: ReturnType<typeof setInterval>;
  private writeChain: Promise<void> = Promise.resolve();
  private parentHash?: string;
  private identity?: ChildIdentity;
  private hasStarted = false;

  constructor(private readonly engine: TokenSpeedEngine, private readonly interval: () => number) {}
  /** Fail closed if the orchestrator's run ID or numeric child slot is absent. */
  get enabled(): boolean {
    return child() && !!process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID && !!childIdentity();
  }

  start(): void {
    this.dispose();
    if (!this.enabled) return;
    this.parentHash = hashSessionId(process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID!);
    this.identity = childIdentity();
    this.hasStarted = false;
  }

  /** Start one bounded sampler only once decoding is active; never write per delta. */
  notify(): void {
    if (!this.identity || this.timer || !this.engine.isStreaming) return;
    this.hasStarted = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.interval());
    this.timer.unref?.();
  }
  /** State boundaries are useful promptly, unlike every transport delta. */
  publishState(): Promise<void> { return this.publish(); }
  /** Capture a terminal sample before the parent stops this child engine. */
  captureFinalSample(): void {
    if (this.engine.isStreaming) this.engine.sampleGraph();
  }
  /** Queue and await the final completed snapshot before an async lifecycle handler returns. */
  complete(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.hasStarted ? this.publish() : this.writeChain;
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.parentHash = undefined;
    this.identity = undefined;
  }

  private tick(): void {
    // No GraphController is attached in child mode; this is the only child sampler.
    if (this.engine.isStreaming) this.engine.sampleGraph();
    void this.publish();
  }
  private publish(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return this.writeChain;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeSnapshot(snapshot))
      .then(() => undefined)
      .catch(() => undefined);
    return this.writeChain;
  }
  private snapshot(): SubagentSnapshot | undefined {
    const parentSessionHash = this.parentHash;
    const identity = this.identity;
    if (!parentSessionHash || !identity) return undefined;
    const metrics = this.engine.graphMetrics();
    return {
      schemaVersion: 1,
      parentSessionHash,
      childId: identity.childId,
      index: identity.index,
      pid: process.pid,
      timestamp: Date.now(),
      startedAt: metrics.requestStartedAt,
      state: metrics.state,
      currentTps: metrics.currentTps,
      meanTps: metrics.meanTps,
      peakTps: metrics.peakTps,
      decodeTokens: metrics.decodeTokens,
      totalTokens: metrics.totalTokens,
      totalEstimated: metrics.totalEstimated,
      firstResponseMs: metrics.ttft,
      activeDecodeMs: metrics.elapsedMs,
    };
  }
}

export function isSubagentChild(): boolean { return child(); }

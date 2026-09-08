import type { RenderGraphMetrics } from "./graph-render";
import type { GraphMetrics } from "./engine";
import type { SpeedSample } from "./sampler";
import type { SubagentSnapshot } from "./subagent-metrics";

export interface DecoderSummary {
  /** Parent or an opaque child-slot label; never a run/session/model identifier. */
  label: string;
  currentTps: number;
  meanTps: number;
  peakTps: number;
  state: "streaming" | "paused" | "complete" | "idle";
}

type FleetMetrics = RenderGraphMetrics & {
  activeChildren: SubagentSnapshot[];
  decoderSummaries: DecoderSummary[];
};

/**
 * Builds a request-scoped overview. Interactive TPS is the maximum active
 * decoder rate; aggregate TPS is the concurrent sum (fleet capacity).
 */
export class FleetAggregator {
  private samples: SpeedSample[] = [];
  private aggregateSamples: SpeedSample[] = [];
  private interactivePeak = 0;
  private aggregatePeak = 0;
  private interactiveWeightedTokens = 0;
  private aggregateWeightedTokens = 0;
  private activeMs = 0;
  private previous?: { timestamp: number; interactiveTps: number; aggregateTps: number; active: boolean };
  private parentDecodeStartedAt = 0;
  private requestStartedAt = 0;
  private completedWallMs?: number;
  private knownChildren = new Set<string>();

  reset(requestStartedAt = 0, parentDecodeStartedAt = requestStartedAt): void {
    this.samples = [];
    this.aggregateSamples = [];
    this.interactivePeak = 0;
    this.aggregatePeak = 0;
    this.interactiveWeightedTokens = 0;
    this.aggregateWeightedTokens = 0;
    this.activeMs = 0;
    this.previous = undefined;
    this.parentDecodeStartedAt = parentDecodeStartedAt;
    this.requestStartedAt = requestStartedAt;
    this.completedWallMs = undefined;
    this.knownChildren.clear();
  }

  aggregate(parent: GraphMetrics, children: readonly SubagentSnapshot[], now = Date.now(), historyMs = 30000, sampleIntervalMs = 250): FleetMetrics {
    // A new parent start is the sole request boundary. GraphController also
    // performs this check before accepting sidecars, so this is a safe guard
    // for direct users of the aggregator.
    if (parent.startedAt > 0 && parent.startedAt !== this.parentDecodeStartedAt) {
      this.reset(parent.requestStartedAt || parent.startedAt, parent.startedAt);
    }

    const activeChildren = children.filter((child) => child.state === "streaming");
    const activeDecoders = [
      ...(parent.state === "streaming" ? [parent.currentTps] : []),
      ...activeChildren.map((child) => child.currentTps),
    ];
    const active = activeDecoders.length > 0;
    const currentTps = active ? Math.max(...activeDecoders) : 0;
    const aggregateCurrentTps = activeDecoders.reduce((sum, tps) => sum + tps, 0);
    const lateChild = children.some((child) => !this.knownChildren.has(child.childId));
    for (const child of children) this.knownChildren.add(child.childId);
    const requestComplete = parent.state === "complete" && children.every((child) => child.state === "complete" || child.state === "idle");
    const wasComplete = this.completedWallMs !== undefined;
    if (lateChild || !requestComplete) this.completedWallMs = undefined;

    // Keep polling after completion for late children, but do not let those
    // polls append an ever-growing idle tail to the frozen request timeline.
    if (!wasComplete || lateChild || !requestComplete) {
      // The preceding sample describes the interval ending at this observation.
      // An inactive endpoint rebases the next interval so idle/tool gaps cannot
      // be charged to either weighted mean.
      if (this.previous?.active) {
        const elapsed = Math.max(0, now - this.previous.timestamp);
        this.activeMs += elapsed;
        this.interactiveWeightedTokens += this.previous.interactiveTps * elapsed / 1000;
        this.aggregateWeightedTokens += this.previous.aggregateTps * elapsed / 1000;
      }
      this.previous = { timestamp: now, interactiveTps: currentTps, aggregateTps: aggregateCurrentTps, active };
      if (active) {
        this.interactivePeak = Math.max(this.interactivePeak, currentTps);
        this.aggregatePeak = Math.max(this.aggregatePeak, aggregateCurrentTps);
      }
      const sampledMean = this.activeMs === 0 ? 0 : this.interactiveWeightedTokens / (this.activeMs / 1000);
      const sampledAggregateMean = this.activeMs === 0 ? 0 : this.aggregateWeightedTokens / (this.activeMs / 1000);
      this.samples.push({ timestamp: now, decodeTps: currentTps, meanTps: sampledMean });
      this.aggregateSamples.push({ timestamp: now, decodeTps: aggregateCurrentTps, meanTps: sampledAggregateMean });
      const budget = sampleBudget(historyMs, sampleIntervalMs);
      this.samples = downsampleTimeline(this.samples, budget);
      this.aggregateSamples = downsampleTimeline(this.aggregateSamples, budget);
    }
    const meanTps = this.activeMs === 0 ? 0 : this.interactiveWeightedTokens / (this.activeMs / 1000);
    const aggregateMeanTps = this.activeMs === 0 ? 0 : this.aggregateWeightedTokens / (this.activeMs / 1000);

    const sources = [parent, ...children];
    const state: RenderGraphMetrics["state"] = active
      ? "streaming"
      : parent.state === "paused" || children.some((child) => child.state === "paused")
        ? "paused"
        : requestComplete
          ? "complete"
          : "idle";
    if (this.requestStartedAt > 0 && requestComplete && this.completedWallMs === undefined) {
      this.completedWallMs = Math.max(0, now - this.requestStartedAt);
    }
    const wallMs = this.requestStartedAt === 0 ? 0 : this.completedWallMs ?? Math.max(0, now - this.requestStartedAt);

    return {
      samples: this.samples,
      aggregateSamples: this.aggregateSamples,
      currentTps,
      peakTps: this.interactivePeak,
      meanTps,
      aggregateCurrentTps,
      aggregatePeakTps: this.aggregatePeak,
      aggregateMeanTps,
      decodeTokens: parent.decodeTokens + children.reduce((sum, child) => sum + child.decodeTokens, 0),
      totalTokens: parent.totalTokens + children.reduce((sum, child) => sum + child.totalTokens, 0),
      // An estimate with no tokens does not make an otherwise authoritative
      // aggregate total uncertain.
      totalEstimated: sources.some((source) => source.totalTokens > 0 && source.totalEstimated),
      seriesEstimated: true,
      elapsedMs: parent.elapsedMs + children.reduce((sum, child) => sum + child.activeDecodeMs, 0),
      wallMs,
      // User-visible first response belongs to the root request; child TTFTs
      // begin later and must not make the apparent end-to-end latency shorter.
      ttft: parent.ttft,
      startedAt: this.requestStartedAt,
      state,
      activeChildCount: activeChildren.length,
      activeChildren,
      decoderSummaries: [
        { label: "Parent", currentTps: parent.state === "streaming" ? parent.currentTps : 0, meanTps: parent.meanTps, peakTps: parent.peakTps, state: parent.state },
        ...children.map((child) => ({
          label: opaqueChildLabel(child, children),
          currentTps: child.state === "streaming" ? child.currentTps : 0,
          meanTps: child.meanTps,
          peakTps: child.peakTps,
          state: child.state,
        })),
      ],
    };
  }
}

/** Add only as much opaque hash as is needed to separate duplicate numeric slots. */
function opaqueChildLabel(child: SubagentSnapshot, children: readonly SubagentSnapshot[]): string {
  const sameIndex = children.filter((candidate) => candidate.index === child.index);
  let length = 4;
  while (length < child.childId.length && new Set(sameIndex.map((candidate) => candidate.childId.slice(0, length))).size !== sameIndex.length) length++;
  return `Child ${child.index}-${child.childId.slice(0, length)}`;
}

/** graphHistoryMs now controls the bounded whole-request point budget, not a trailing wall-time window. */
function sampleBudget(historyMs: number, sampleIntervalMs: number): number {
  const history = Number.isFinite(historyMs) ? Math.max(1000, historyMs) : 30000;
  const interval = Number.isFinite(sampleIntervalMs) ? Math.max(100, sampleIntervalMs) : 250;
  return Math.max(16, Math.min(480, Math.ceil(history / interval) + 1));
}

/** Preserve the request endpoints and the strongest instantaneous point per bucket. */
function downsampleTimeline(samples: SpeedSample[], budget: number): SpeedSample[] {
  if (samples.length <= budget) return samples;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const interior = samples.slice(1, -1);
  const slots = Math.max(1, budget - 2);
  const selected: SpeedSample[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const start = Math.floor(slot * interior.length / slots);
    const end = Math.max(start + 1, Math.floor((slot + 1) * interior.length / slots));
    const bucket = interior.slice(start, end);
    const peak = bucket.reduce((best, point) => point.decodeTps >= best.decodeTps ? point : best);
    const latest = bucket.at(-1)!;
    selected.push({ timestamp: latest.timestamp, decodeTps: peak.decodeTps, meanTps: latest.meanTps });
  }
  return [first, ...selected, last];
}

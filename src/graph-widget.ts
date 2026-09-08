import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { TokenSpeedEngine } from "./engine";
import { renderGraphLines, type RenderGraphMetrics } from "./graph-render";
import { SnapshotPollGuard } from "./poll-guard";
import { FleetAggregator } from "./subagent-aggregate";
import { filterSnapshotsForRequest, hashSessionId, readSnapshots, type SidecarOptions, type SubagentSnapshot } from "./subagent-metrics";
import { settings } from "./settings";

export { renderGraphLines } from "./graph-render";
export const GRAPH_WIDGET_KEY = "tokenSpeedGraph";
type AggregateMetrics = RenderGraphMetrics & { activeChildren?: readonly SubagentSnapshot[] };
type SnapshotReader = (parentSessionHash: string, options: SidecarOptions) => Promise<SubagentSnapshot[]>;
class GraphWidget implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(private readonly metrics: () => AggregateMetrics, private readonly theme: Theme) {}
  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    this.cachedWidth = width;
    const metrics = this.metrics();
    const lines = renderGraphLines(metrics, width, settings.getConfig().graphHistoryMs, settings.getConfig().graphHeight, (color, text) => this.theme.fg(color, text));
    this.cachedLines = lines;
    return lines;
  }
  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
}

/** Owns the TUI-only widget, local sampler, and parent-session-only sidecar poller. */
export class GraphController {
  private timer?: ReturnType<typeof setInterval>;
  private widget?: GraphWidget;
  private tui?: TUI;
  private context?: ExtensionContext;
  private mounted = false;
  private readonly pollGuard = new SnapshotPollGuard();
  private children: SubagentSnapshot[] = [];
  private readonly fleet = new FleetAggregator();
  private parentDecodeStartedAt = 0;
  private requestStartedAt = 0;
  private metrics: AggregateMetrics;

  constructor(private readonly engine: TokenSpeedEngine, private readonly snapshotReader: SnapshotReader = readSnapshots) { this.metrics = engine.graphMetrics(); }
  attach(ctx: ExtensionContext): void {
    if (this.context && this.context !== ctx) this.dispose();
    this.context = ctx;
    this.reconfigure();
  }
  reconfigure(): void {
    this.pollGuard.invalidate();
    this.stopSampling();
    const ctx = this.context;
    if (!ctx || !this.canOperate(ctx) || !settings.getConfig().graphEnabled) { this.clearWidget(); return; }
    this.widget = undefined; this.tui = undefined;
    ctx.ui.setWidget(GRAPH_WIDGET_KEY, (tui, theme) => {
      this.tui = tui; this.widget = new GraphWidget(() => this.metrics, theme); return this.widget;
    }, { placement: "belowEditor" });
    this.mounted = true;
    this.refresh();
    if (this.engine.isStreaming || settings.getConfig().includeSubagents) this.startSampling();
  }
  /** Establish a new request before its first sample, including its TTFT wall time. */
  beginRequest(): void {
    this.ensureRequest(this.engine.graphMetrics());
    this.updateMetrics();
    this.refresh();
  }
  startSampling(): void {
    const ctx = this.context;
    if (this.timer || !ctx || !this.canOperate(ctx) || !settings.getConfig().graphEnabled) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), settings.getConfig().graphSampleInterval);
    this.timer.unref?.();
  }
  stopSampling(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** Capture a terminal sample before the engine freezes completed history. */
  captureFinalSample(): void {
    if (!this.engine.isStreaming) return;
    this.engine.sampleGraph();
  }
  /** Repaint a lifecycle state change immediately, without adding a local speed sample. */
  refreshMetrics(): void {
    this.updateMetrics();
    this.refresh();
  }
  /** Freeze parent sampling after agent end but keep parent-TUI child polling alive. */
  stopLocalSampling(): void {
    this.refreshMetrics();
    if (!settings.getConfig().includeSubagents) { this.stopSampling(); return; }
    this.startSampling();
  }
  refresh(): void {
    this.widget?.invalidate(); this.tui?.requestRender();
  }
  private updateMetrics(now = Date.now()): void {
    // Parent startedAt is the sole request boundary. Reset before accepting any
    // sidecars so retained children from an earlier request cannot contribute.
    const parent = this.engine.graphMetrics();
    this.ensureRequest(parent);
    const requestChildren = filterSnapshotsForRequest(this.children, this.requestStartedAt);
    // Always use the fleet path: parent-only transitions share the same
    // request history, weighted-mean, and completion semantics as a fleet.
    const config = settings.getConfig();
    this.metrics = this.fleet.aggregate(parent, requestChildren, now, config.graphHistoryMs, config.graphSampleInterval);
  }
  dispose(): void {
    this.pollGuard.invalidate();
    this.stopSampling();
    this.clearWidget();
    this.context = undefined;
    this.children = [];
    this.parentDecodeStartedAt = 0;
    this.requestStartedAt = 0;
    this.fleet.reset();
    this.metrics = this.engine.graphMetrics();
  }
  private ensureRequest(parent: ReturnType<TokenSpeedEngine["graphMetrics"]>): void {
    // The decode start changes only once per request. The earlier user-message
    // timestamp supplies wall-clock scope without resetting while TTFT is pending.
    if (parent.startedAt <= 0 || parent.startedAt === this.parentDecodeStartedAt) return;
    this.parentDecodeStartedAt = parent.startedAt;
    this.requestStartedAt = parent.requestStartedAt || parent.startedAt;
    this.children = [];
    this.fleet.reset(this.requestStartedAt, this.parentDecodeStartedAt);
  }
  private tick(): void {
    const ctx = this.context;
    if (!ctx || !this.canOperate(ctx)) return;
    if (this.engine.isStreaming) this.engine.sampleGraph();
    if (!settings.getConfig().includeSubagents) { this.updateMetrics(); this.refresh(); return; }
    const generation = this.pollGuard.begin();
    if (generation === undefined) return;
    const sessionId = ctx.sessionManager.getSessionId();
    void this.snapshotReader(hashSessionId(sessionId), { staleMs: settings.getConfig().subagentStaleMs, retentionMs: settings.getConfig().subagentRetentionMs })
      .then((snapshots) => {
        // A completion from an old context/reload must not repaint or retain a
        // stale child list, and it must not control the new poller's lock.
        if (!this.pollGuard.isCurrent(generation) || this.context !== ctx) return;
        // Keep only snapshots belonging to the current parent request. A
        // session can retain completed sidecars across multiple user turns.
        this.children = filterSnapshotsForRequest(snapshots, this.requestStartedAt);
        this.updateMetrics();
        this.refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        this.pollGuard.end(generation);
      });
  }
  private clearWidget(): void {
    if (this.mounted && this.context?.mode === "tui") this.context.ui.setWidget(GRAPH_WIDGET_KEY, undefined);
    this.mounted = false; this.widget = undefined; this.tui = undefined;
  }
  private canOperate(ctx: ExtensionContext): boolean { return ctx.mode === "tui"; }

}

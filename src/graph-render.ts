import { truncateToWidth } from "@earendil-works/pi-tui";
import { rasterizeBraille, type BrailleCell } from "./braille";
import type { SpeedSample } from "./sampler";

export interface DecoderRenderSummary {
  label: string;
  currentTps: number;
  meanTps: number;
  peakTps: number;
  state: "streaming" | "paused" | "complete" | "idle";
}

export interface RenderGraphMetrics {
  /** Interactive (max active single-decoder) request timeline and statistics. */
  samples: readonly SpeedSample[];
  /** Aggregate-capacity timeline; optional for parent-only render callers. */
  aggregateSamples?: readonly SpeedSample[];
  currentTps: number;
  peakTps: number;
  meanTps: number;
  /** Concurrent-sum fleet capacity statistics, deliberately separate from interactive TPS. */
  aggregateCurrentTps?: number;
  aggregatePeakTps?: number;
  aggregateMeanTps?: number;
  decodeTokens: number;
  totalTokens: number;
  totalEstimated: boolean;
  seriesEstimated: true;
  /** Summed active decoder time (worker-seconds). */
  elapsedMs: number;
  /** Parent-request wall time, frozen once the request fleet completes. */
  wallMs?: number;
  startedAt: number;
  ttft: number;
  state: "streaming" | "paused" | "complete" | "idle";
  activeChildCount?: number;
  decoderSummaries?: readonly DecoderRenderSummary[];
}

type PaintColor = "accent" | "muted" | "success" | "warning" | "dim";
type Paint = (color: PaintColor, text: string) => string;
const MAX_RENDER_VALUE = 1_000_000_000;
const safeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(MAX_RENDER_VALUE, value)) : 0;
const formatDuration = (milliseconds: number): string => {
  const safe = safeNumber(milliseconds);
  return safe < 1000 ? `${Math.round(safe)} ms` : `${(safe / 1000).toFixed(1)} s`;
};
const fixed = (value: number, digits = 1): string => safeNumber(value).toFixed(digits);

/** Renders a single ANSI-safe Braille chart row, preserving layer colors. */
export function renderBrailleRow(cells: readonly BrailleCell[], paint: Paint): string {
  return cells.map((cell) => {
    if (cell.layer === "speed") return paint("accent", cell.char);
    if (cell.layer === "mean") return paint("dim", cell.char);
    if (cell.layer === "overlap") return paint("warning", cell.char);
    return cell.char;
  }).join("");
}

/** Pure responsive graph renderer; every produced line is ANSI-aware clipped. */
export function renderGraphLines(
  metrics: RenderGraphMetrics,
  width: number,
  _historyMs: number,
  graphHeight: number,
  paint: Paint = (_color, text) => text,
): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const fit = (line: string) => truncateToWidth(line, safeWidth, "");
  if (safeWidth <= 0) return [""];
  const narrow = safeWidth < 68;
  const safeHeight = Number.isFinite(graphHeight) ? Math.max(2, Math.min(Math.floor(graphHeight), narrow ? 3 : 8)) : 2;
  const prefixWidth = narrow ? 0 : 8;
  const columns = Math.max(1, safeWidth - prefixWidth);
  // Plot the responsive EMA rather than transport-burst rates. The raw
  // decodeTps remains available for peaks and diagnostics.
  const speed = metrics.samples.map((sample) => safeNumber(sample.smoothedTps ?? sample.decodeTps));
  const mean = metrics.samples.map((sample) => safeNumber(sample.meanTps));
  const scale = Math.max(1, ...speed, ...mean);
  const chart = rasterizeBraille(speed, mean, columns, safeHeight);
  const activeChildCount = Number.isSafeInteger(metrics.activeChildCount) && metrics.activeChildCount! > 0 ? metrics.activeChildCount : 0;
  const childState = activeChildCount ? `  ·  ${activeChildCount} child${activeChildCount === 1 ? "" : "ren"} active` : "";
  const state = metrics.state === "streaming" || metrics.state === "paused" || metrics.state === "complete" || metrics.state === "idle" ? metrics.state : "idle";
  const title = `${paint("accent", "◔ Interactive decode speed")}  ${paint(state === "streaming" ? "success" : state === "paused" ? "warning" : "muted", `● ${state}`)}${paint("dim", childState)}  ${paint("dim", "est. speed")}`;
  const total = `${metrics.totalEstimated && safeNumber(metrics.totalTokens) > 0 ? "~" : ""}${Math.round(safeNumber(metrics.totalTokens))}`;
  const legend = `${paint("accent", "⠿ interactive smoothed decode (est.)")}  ${paint("dim", "⠒ interactive running mean")}`;
  const aggregateNow = metrics.aggregateCurrentTps ?? metrics.currentTps;
  const aggregateMean = metrics.aggregateMeanTps ?? metrics.meanTps;
  const aggregatePeak = metrics.aggregatePeakTps ?? metrics.peakTps;
  const lines = [fit(title), fit(legend)];

  for (let row = 0; row < chart.length; row++) {
    const label = narrow
      ? ""
      : row === 0
        ? `${Math.round(scale).toString().padStart(5)} │ `
        : row === chart.length - 1
          ? "    0 │ "
          : "      │ ";
    lines.push(fit(`${paint("muted", label)}${renderBrailleRow(chart[row]!, paint)}`));
  }

  const interactive = `Interactive — Now ${fixed(metrics.currentTps)}${narrow ? "" : " tok/s"} est.  ·  Mean ${fixed(metrics.meanTps)}${narrow ? "" : " tok/s"}  ·  Peak ${fixed(metrics.peakTps)}${narrow ? "" : " tok/s"}`;
  const aggregate = `Aggregate capacity — Now ${fixed(aggregateNow)}${narrow ? "" : " tok/s"} est.  ·  Mean ${fixed(aggregateMean)}${narrow ? "" : " tok/s"}  ·  Peak ${fixed(aggregatePeak)}${narrow ? "" : " tok/s"}`;
  lines.push(fit(interactive));
  lines.push(fit(aggregate));
  if (narrow) {
    lines.push(fit(`Total ${total}  ·  First ${formatDuration(metrics.ttft)}`));
    lines.push(fit(`Wall ${formatDuration(metrics.wallMs ?? metrics.elapsedMs)}  ·  DecodeΣ ${formatDuration(metrics.elapsedMs)}`));
  } else {
    lines.push(fit(`Total output ${total} tok  │  First response ${formatDuration(metrics.ttft)}  │  Wall ${formatDuration(metrics.wallMs ?? metrics.elapsedMs)}  │  Decode (summed) ${formatDuration(metrics.elapsedMs)}`));
  }

  if (safeWidth >= 96 && metrics.decoderSummaries?.length) {
    // This renderer is intentionally fail-closed: only the internal Parent
    // label or an opaque numeric-slot/hash child label can reach the TUI.
    const summaries = metrics.decoderSummaries
      .filter((decoder) => decoder.label === "Parent" || /^Child \d+-[a-f0-9]{4,64}$/.test(decoder.label))
      .map((decoder) =>
        `${decoder.label} M${fixed(decoder.meanTps)} P${fixed(decoder.peakTps)} ${decoder.state}${decoder.state === "streaming" ? ` N${fixed(decoder.currentTps)}` : ""}`,
      ).join("  ·  ");
    if (summaries) lines.push(fit(`Decoders: ${summaries}`));
  }
  return lines;
}

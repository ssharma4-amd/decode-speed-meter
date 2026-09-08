/** A uniformly-timed estimated decode-speed sample. */
export interface SpeedSample {
  timestamp: number;
  /** Raw interval rate, retained for accurate peaks and diagnostics. */
  decodeTps: number;
  /** Responsive EMA of the interval rate, used for graph rendering and UI peak. */
  smoothedTps?: number;
  meanTps: number;
}

// Providers commonly deliver several tokens in a burst and then go quiet. Use
// a time-normalized one-second EMA rather than a fixed per-sample alpha: the
// demo samples at 100ms while the TUI normally samples at 250ms.
const GRAPH_SMOOTHING_WINDOW_MS = 1000;

/**
 * Bounded, timer-driven history. It is deliberately independent of transport
 * event frequency; absent active decode produces zero samples.
 */
export class UniformSpeedSampler {
  private samples: SpeedSample[] = [];
  private previous?: { timestamp: number; tokens: number };
  private smoothedTps = 0;
  private sessionPeakTps = 0;
  private sessionSmoothedPeakTps = 0;

  constructor(
    private readonly historyMs: number,
    private readonly intervalMs: number,
  ) {}

  sample(timestamp: number, tokens: number, meanTps: number): SpeedSample {
    const elapsed = this.previous ? Math.max(timestamp - this.previous.timestamp, 1) : 0;
    const sample: SpeedSample = {
      timestamp,
      decodeTps: this.previous
        ? Math.max(0, tokens - this.previous.tokens) / (elapsed / 1000)
        : 0,
      meanTps: Math.max(0, meanTps),
    };
    const alpha = this.samples.length === 0
      ? 1
      : 1 - Math.exp(-elapsed / GRAPH_SMOOTHING_WINDOW_MS);
    this.previous = { timestamp, tokens };
    this.smoothedTps += alpha * (sample.decodeTps - this.smoothedTps);
    sample.smoothedTps = this.smoothedTps;
    this.sessionPeakTps = Math.max(this.sessionPeakTps, sample.decodeTps);
    this.sessionSmoothedPeakTps = Math.max(this.sessionSmoothedPeakTps, this.smoothedTps);
    this.samples.push(sample);
    this.prune(timestamp);
    return sample;
  }

  /** Resume after a tool pause without turning the pause into a low TPS sample. */
  rebase(timestamp: number, tokens: number): void {
    this.previous = { timestamp, tokens };
  }

  reset(): void {
    this.samples = [];
    this.previous = undefined;
    this.smoothedTps = 0;
    this.sessionPeakTps = 0;
    this.sessionSmoothedPeakTps = 0;
  }

  getSamples(): readonly SpeedSample[] { return this.samples; }
  /** Raw interval peak, retained for diagnostics. */
  get peakTps(): number { return this.sessionPeakTps; }
  /** Peak of the responsive series shown in the graph and dashboard. */
  get smoothedPeakTps(): number { return this.sessionSmoothedPeakTps; }
  /** Smoothed current rate for graph/dashboard presentation. */
  get currentTps(): number { return this.samples.at(-1)?.smoothedTps ?? this.samples.at(-1)?.decodeTps ?? 0; }
  /** Raw current interval rate, retained for diagnostics. */
  get instantaneousTps(): number { return this.samples.at(-1)?.decodeTps ?? 0; }

  private prune(timestamp: number): void {
    const earliest = timestamp - this.historyMs;
    while (this.samples.length > 0 && this.samples[0]!.timestamp < earliest) {
      this.samples.shift();
    }
    const maximum = Math.ceil(this.historyMs / this.intervalMs) + 2;
    if (this.samples.length > maximum) this.samples.splice(0, this.samples.length - maximum);
  }
}

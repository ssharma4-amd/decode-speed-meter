/** A uniformly-timed estimated decode-speed sample. */
export interface SpeedSample {
  timestamp: number;
  /** Raw interval rate, retained for diagnostics. */
  decodeTps: number;
  /** Responsive EMA of the interval rate, used for graph rendering and live current. */
  smoothedTps?: number;
  /** Throughput over at most the latest second of active decode time. */
  sustainedTps?: number;
  meanTps: number;
}

// Providers commonly deliver several tokens in a burst and then go quiet. Use
// a time-normalized one-second EMA rather than a fixed per-sample alpha: the
// demo samples at 100ms while the TUI normally samples at 250ms.
const GRAPH_SMOOTHING_WINDOW_MS = 1000;
const SUSTAINED_PEAK_WINDOW_MS = 1000;

interface ActiveDecodeInterval {
  durationMs: number;
  tokens: number;
}

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
  private sessionSustainedPeakTps = 0;
  private sustainedIntervals: ActiveDecodeInterval[] = [];
  private sustainedDurationMs = 0;
  private sustainedTokens = 0;

  constructor(
    private readonly historyMs: number,
    private readonly intervalMs: number,
  ) {}

  sample(timestamp: number, tokens: number, meanTps: number): SpeedSample {
    const hadPrevious = this.previous !== undefined;
    const elapsed = hadPrevious ? Math.max(timestamp - this.previous!.timestamp, 1) : 0;
    const intervalTokens = hadPrevious ? Math.max(0, tokens - this.previous!.tokens) : 0;
    const sample: SpeedSample = {
      timestamp,
      decodeTps: hadPrevious ? intervalTokens / (elapsed / 1000) : 0,
      meanTps: Math.max(0, meanTps),
    };
    const alpha = this.samples.length === 0
      ? 1
      : 1 - Math.exp(-elapsed / GRAPH_SMOOTHING_WINDOW_MS);
    this.previous = { timestamp, tokens };
    this.smoothedTps += alpha * (sample.decodeTps - this.smoothedTps);
    sample.smoothedTps = this.smoothedTps;
    if (hadPrevious) this.recordSustainedInterval(elapsed, intervalTokens);
    sample.sustainedTps = this.sustainedDurationMs > 0
      ? this.sustainedTokens / (this.sustainedDurationMs / 1000)
      : 0;
    this.sessionPeakTps = Math.max(this.sessionPeakTps, sample.decodeTps);
    this.sessionSmoothedPeakTps = Math.max(this.sessionSmoothedPeakTps, this.smoothedTps);
    // The request mean is a lower bound on any correctly sampled sustained
    // peak. Including it protects the UI invariant from timer-boundary error.
    this.sessionSustainedPeakTps = Math.max(
      this.sessionSustainedPeakTps,
      sample.sustainedTps,
      sample.meanTps,
    );
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
    this.sessionSustainedPeakTps = 0;
    this.sustainedIntervals = [];
    this.sustainedDurationMs = 0;
    this.sustainedTokens = 0;
  }

  getSamples(): readonly SpeedSample[] { return this.samples; }
  /** Raw interval peak, retained for diagnostics. */
  get peakTps(): number { return this.sessionPeakTps; }
  /** Peak of the responsive series retained for graph diagnostics. */
  get smoothedPeakTps(): number { return this.sessionSmoothedPeakTps; }
  /** Highest throughput over one second of active decode (or the elapsed partial window). */
  get sustainedPeakTps(): number { return this.sessionSustainedPeakTps; }
  /** Smoothed current rate for graph/dashboard presentation. */
  get currentTps(): number { return this.samples.at(-1)?.smoothedTps ?? this.samples.at(-1)?.decodeTps ?? 0; }
  /** Raw current interval rate, retained for diagnostics. */
  get instantaneousTps(): number { return this.samples.at(-1)?.decodeTps ?? 0; }

  private recordSustainedInterval(durationMs: number, tokens: number): void {
    this.sustainedIntervals.push({ durationMs, tokens });
    this.sustainedDurationMs += durationMs;
    this.sustainedTokens += tokens;

    while (this.sustainedDurationMs > SUSTAINED_PEAK_WINDOW_MS) {
      const oldest = this.sustainedIntervals[0];
      if (!oldest) break;
      const excessMs = this.sustainedDurationMs - SUSTAINED_PEAK_WINDOW_MS;
      if (oldest.durationMs <= excessMs) {
        this.sustainedIntervals.shift();
        this.sustainedDurationMs -= oldest.durationMs;
        this.sustainedTokens -= oldest.tokens;
        continue;
      }

      const retainedFraction = (oldest.durationMs - excessMs) / oldest.durationMs;
      const retainedTokens = oldest.tokens * retainedFraction;
      this.sustainedDurationMs -= excessMs;
      this.sustainedTokens -= oldest.tokens - retainedTokens;
      oldest.durationMs -= excessMs;
      oldest.tokens = retainedTokens;
    }
  }

  private prune(timestamp: number): void {
    const earliest = timestamp - this.historyMs;
    while (this.samples.length > 0 && this.samples[0]!.timestamp < earliest) {
      this.samples.shift();
    }
    const maximum = Math.ceil(this.historyMs / this.intervalMs) + 2;
    if (this.samples.length > maximum) this.samples.splice(0, this.samples.length - maximum);
  }
}

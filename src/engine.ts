import type { CountStrategy, EndTpsBehavior, TokenSpeedConfig } from "./config-types";
import {
  COUNT_STRATEGY,
  END_TPS_BEHAVIOR,
  GRAPH_HISTORY_MS,
  GRAPH_SAMPLE_INTERVAL,
  SLIDING_WINDOW,
  USE_PROVIDER_TOKENS,
} from "./defaults";
import { SlidingWindow } from "./sliding-window";
import { UniformSpeedSampler, type SpeedSample } from "./sampler";

const TOKEN_REGEX = /\w+|[^\s\w]/g;
type EngineConfig = Pick<
  TokenSpeedConfig,
  | "slidingWindow"
  | "graphHistoryMs"
  | "graphSampleInterval"
  | "countStrategy"
  | "useProviderTokens"
  | "endTpsBehavior"
>;

export interface GraphMetrics {
  samples: readonly SpeedSample[];
  currentTps: number;
  peakTps: number;
  meanTps: number;
  /** Estimated streamed decode count; never overwritten by final usage. */
  decodeTokens: number;
  /** Live/provider total or authoritative final assistant total. */
  totalTokens: number;
  totalEstimated: boolean;
  seriesEstimated: true;
  elapsedMs: number;
  /** Epoch when model decoding started. */
  startedAt: number;
  /** Epoch when the user request started; includes TTFT/prefill in wall time. */
  requestStartedAt: number;
  ttft: number;
  state: "streaming" | "paused" | "complete" | "idle";
}

/** Tracks model decode chunks separately from final provider accounting. */
export class TokenSpeedEngine {
  private _isStreaming = false;
  private _isPaused = false;
  private _estimatedDecodeTokens = 0;
  private _startTime = 0;
  private _endTime = 0;
  private _ttftStart = 0;
  private _ttftEnd = 0;
  private _startPause = 0;
  private _pausedMs = 0;
  private _tps = 0;
  private _completedLiveTokens = 0;
  private _completedUsesEstimate = false;
  private _responseEstimatedTokens = 0;
  private _responseStreamTokens = 0;
  private _responseProviderUsage?: number;
  private _responseActive = false;
  private _authoritativeTotal?: number;
  private _slidingWindow = new SlidingWindow(SLIDING_WINDOW);
  private _sampler = new UniformSpeedSampler(GRAPH_HISTORY_MS, GRAPH_SAMPLE_INTERVAL);
  private _useProviderTokens = USE_PROVIDER_TOKENS;
  private _countStrategy: CountStrategy = COUNT_STRATEGY;
  private _endTpsBehavior: EndTpsBehavior = END_TPS_BEHAVIOR;

  initialize(config: EngineConfig): void {
    this._slidingWindow = new SlidingWindow(config.slidingWindow);
    this._sampler = new UniformSpeedSampler(config.graphHistoryMs, config.graphSampleInterval);
    this.applyConfig(config);
  }

  /** Applies live footer/counting settings without resetting a response or graph history. */
  updateConfig(config: EngineConfig): void {
    this._slidingWindow.setWindow(config.slidingWindow);
    this.applyConfig(config);
  }

  /** Provider cumulative usage restarts for each assistant response. */
  beginAssistantResponse(): void {
    if (this._responseActive) this.commitResponse();
    this._responseActive = true;
    this._responseEstimatedTokens = 0;
    this._responseStreamTokens = 0;
    this._responseProviderUsage = undefined;
  }

  /** Records text, thinking, and model-generated tool-call JSON as one decode stream. */
  recordDelta(delta: string, usageOutput?: number): void {
    if (!this._isStreaming) return;
    if (this._isPaused) this.resume();
    if (!this._responseActive) this.beginAssistantResponse();

    const estimated = this._countStrategy === "estimate" ? this.estimateTokens(delta) : 1;
    const providerTokens = this._useProviderTokens && usageOutput !== undefined && usageOutput > 0
      ? usageOutput
      : undefined;
    const streamed = providerTokens === undefined
      ? estimated
      : Math.max(0, providerTokens - this._responseStreamTokens);
    this.recordEstimatedTokens(streamed);
    this._responseStreamTokens += streamed;
    this._responseEstimatedTokens += estimated;

    // Providers commonly initialize partial usage.output to 0 before reporting
    // progressive usage. Keep estimates until a meaningful positive value arrives.
    if (providerTokens !== undefined) {
      this._responseProviderUsage = Math.max(this._responseProviderUsage ?? 0, providerTokens);
    }
  }

  /** Final usage only updates the authoritative Total, never decode history. */
  reconcileTotal(tokens: number | undefined): void {
    if (tokens !== undefined && tokens >= 0) this._authoritativeTotal = tokens;
  }

  get isStreaming(): boolean { return this._isStreaming; }
  get tokenCount(): number { return this._authoritativeTotal ?? this.liveTotal; }
  get totalEstimated(): boolean { return this._authoritativeTotal === undefined && this.liveUsesEstimate; }
  get speedEstimated(): boolean {
    return this._isStreaming || this._endTpsBehavior === "last" || this._authoritativeTotal === undefined;
  }
  get elapsedMs(): number {
    if (this._startTime === 0) return 0;
    if (this._isStreaming) return Date.now() - this._startTime - this._pausedMs;
    return this._endTime - this._startTime - this._pausedMs;
  }
  get elapsedSeconds(): number { return this.elapsedMs / 1000; }
  get tps(): number {
    if (this._isStreaming) return this._tps;
    return this._endTpsBehavior === "last" ? this._tps : this.tpsAvg;
  }
  get tpsAvg(): number { return this.elapsedSeconds <= 0 ? 0 : this.tokenCount / this.elapsedSeconds; }
  get ttft(): number { return Math.max(this._ttftEnd - this._ttftStart, 0); }

  start(): void {
    if (this._isStreaming) return;
    this._estimatedDecodeTokens = 0;
    this._isStreaming = true;
    this._isPaused = false;
    this._startTime = Date.now();
    this._endTime = this._startTime;
    this._slidingWindow.reset();
    this._sampler.reset();
    this._tps = 0;
    this._pausedMs = 0;
    this._completedLiveTokens = 0;
    this._completedUsesEstimate = false;
    this._authoritativeTotal = undefined;
    this._responseActive = false;
    this.beginAssistantResponse();
  }

  startTTFT(): void { this._ttftStart = Date.now(); this._ttftEnd = 0; }
  stopTTFT(): void { if (this._ttftEnd === 0) this._ttftEnd = Date.now(); }

  stop(): void {
    if (!this._isStreaming) return;
    if (this._isPaused) this.resume();
    this._isStreaming = false;
    this._endTime = Date.now();
    this._slidingWindow.reset();
  }

  /** Called after any tool call ends; tool execution is excluded from decode time. */
  pause(): void {
    if (!this._isStreaming || this._isPaused) return;
    this._isPaused = true;
    this._startPause = Date.now();
  }

  /** Samples active model decode only. Tool pauses neither sample nor lower TPS. */
  sampleGraph(now = Date.now()): boolean {
    if (!this._isStreaming || this._isPaused) return false;
    this._sampler.sample(now, this._estimatedDecodeTokens, this.meanTps);
    return true;
  }

  graphMetrics(): GraphMetrics {
    const state: GraphMetrics["state"] = this._isStreaming
      ? this._isPaused ? "paused" : "streaming"
      : this._startTime ? "complete" : "idle";
    return {
      samples: this._sampler.getSamples(),
      currentTps: this._sampler.currentTps,
      // Current follows the responsive EMA, while Peak reports the strongest
      // sustained one-second window. Keep Peak >= the request-wide mean even
      // between timer samples so the completed summary stays intuitive.
      peakTps: Math.max(this._sampler.sustainedPeakTps, this.meanTps),
      meanTps: this.meanTps,
      decodeTokens: this._estimatedDecodeTokens,
      totalTokens: this.tokenCount,
      totalEstimated: this.totalEstimated,
      seriesEstimated: true,
      elapsedMs: this.elapsedMs,
      startedAt: this._startTime,
      requestStartedAt: this._ttftStart || this._startTime,
      ttft: this.ttft,
      state,
    };
  }

  private applyConfig(config: EngineConfig): void {
    this._countStrategy = config.countStrategy;
    this._useProviderTokens = config.useProviderTokens;
    this._endTpsBehavior = config.endTpsBehavior;
  }
  private get meanTps(): number {
    return this.elapsedSeconds <= 0 ? 0 : this._estimatedDecodeTokens / this.elapsedSeconds;
  }
  private get liveTotal(): number {
    return this._completedLiveTokens + (this._responseProviderUsage ?? this._responseEstimatedTokens);
  }
  private get liveUsesEstimate(): boolean {
    return this._completedUsesEstimate || this._responseProviderUsage === undefined;
  }
  private commitResponse(): void {
    this._completedLiveTokens += this._responseProviderUsage ?? this._responseEstimatedTokens;
    this._completedUsesEstimate ||= this._responseProviderUsage === undefined;
  }
  private resume(): void {
    this._isPaused = false;
    this._pausedMs += Date.now() - this._startPause;
    this._sampler.rebase(Date.now(), this._estimatedDecodeTokens);
  }
  private recordEstimatedTokens(tokens: number): void {
    if (!this._isStreaming || tokens <= 0) return;
    this._estimatedDecodeTokens += tokens;
    this._slidingWindow.record(tokens);
    this._tps = this._slidingWindow.getTps(Date.now());
  }
  private estimateTokens(text: string): number {
    if (!text) return 0;
    return text.match(TOKEN_REGEX)?.length ?? 0;
  }
}

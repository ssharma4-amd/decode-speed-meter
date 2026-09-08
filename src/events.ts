import type {
  AgentEndEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TokenSpeedEngine } from "./engine";
import { GraphController } from "./graph-widget";
import { Renderer } from "./renderer";
import { isSubagentChild, SubagentReporter } from "./subagent-reporter";
import { settings } from "./settings";

interface MessageUpdatePayload {
  assistantMessageEvent: {
    type: string;
    delta?: string;
    partial?: { usage?: { output?: number } };
  };
}

/** Manages decode lifecycle events and the session-scoped graph resource. */
export class EventManager {
  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly renderer: Renderer,
    private readonly graph: GraphController,
    private readonly reporter: SubagentReporter,
  ) {}

  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    await settings.initialize();
    const errors = settings.getErrors();
    if (errors.length > 0) ctx.ui.notify(["[pi-token-speed]", ...errors].join("\n"), "warning");
    this.engine.initialize(settings.getConfig());
    this.renderer.initialize(ctx);
    this.renderer.resetThrottle();
    // Headless child processes own only the reporter sampler/writer, never a TUI widget.
    if (isSubagentChild()) this.reporter.start();
    else this.graph.attach(ctx);
  }

  async handleSessionShutdown(): Promise<void> {
    this.engine.stop();
    if (isSubagentChild()) {
      await this.reporter.complete();
      this.reporter.dispose();
    } else {
      this.graph.refreshMetrics();
      this.graph.dispose();
    }
  }

  handleMessageStart(event: { message?: { role?: string } }): void {
    if (event.message?.role === "user") this.engine.startTTFT();
    if (event.message?.role === "assistant") this.engine.beginAssistantResponse();
  }

  handleMessageUpdate(event: MessageUpdatePayload, ctx: ExtensionContext): void {
    const ev = event.assistantMessageEvent;
    if (ev.type === "text_start" || ev.type === "thinking_start" || ev.type === "toolcall_start") {
      this.engine.start();
      if (isSubagentChild()) this.reporter.notify();
      else {
        this.graph.beginRequest();
        this.graph.startSampling();
      }
      return;
    }

    // All model stream payloads are part of one decode series, including JSON
    // streamed for every tool call. Tool execution is paused only after end.
    if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
      this.engine.stopTTFT();
      this.engine.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
      this.renderer.update(ctx);
      if (isSubagentChild()) this.reporter.notify();
      return;
    }

    if (ev.type === "toolcall_end") {
      this.engine.pause();
      if (isSubagentChild()) void this.reporter.publishState();
      else this.graph.refreshMetrics();
    }
  }

  async handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): Promise<void> {
    // The regular sampler may not get another interval for very short
    // responses. Capture the terminal decode point while the engine is still
    // active, so the TUI and web timelines contain a visible final sample.
    if (isSubagentChild()) this.reporter.captureFinalSample();
    else this.graph.captureFinalSample();
    this.engine.stop();
    let hasAssistantUsage = false;
    const outputTokens = event.messages.reduce((acc, curr) => {
      if (curr.role !== "assistant" || !curr.usage) return acc;
      hasAssistantUsage = true;
      return acc + curr.usage.output;
    }, 0);
    this.engine.reconcileTotal(hasAssistantUsage ? outputTokens : undefined);
    if (isSubagentChild()) {
      await this.reporter.complete();
    } else {
      this.graph.stopLocalSampling();
    }
    this.renderer.forceUpdate(ctx);
  }
}

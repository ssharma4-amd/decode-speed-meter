import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { CommandManager } from "./src/commands";
import { TokenSpeedEngine } from "./src/engine";
import { EventManager } from "./src/events";
import { GraphController } from "./src/graph-widget";
import { Renderer } from "./src/renderer";
import { isSubagentChild, SubagentReporter } from "./src/subagent-reporter";
import { settings } from "./src/settings";

export default async (pi: ExtensionAPI) => {
  const engine = new TokenSpeedEngine();
  const renderer = new Renderer(engine);
  const graph = new GraphController(engine);
  const reporter = new SubagentReporter(engine, () => settings.getConfig().graphSampleInterval);
  const commands = new CommandManager(renderer, engine, graph);
  const eventManager = new EventManager(engine, renderer, graph, reporter);

  // pi-subagents uses this acknowledgement to confirm this extension loaded in children.
  if (isSubagentChild()) {
    pi.events.emit("subagent:acknowledge-extension", { id: "pi-token-speed" });
  }

  // Command registration
  pi.registerCommand("tps", {
    description:
      "Open settings menu to configure display mode, token counting strategy, provider token usage, and icon visibility",
    handler: (_, ctx: ExtensionCommandContext) => commands.runTps(ctx),
  });

  // Session lifecycle
  pi.on("session_start", async (_, ctx: ExtensionContext) => {
    await eventManager.handleSessionStart(ctx);
  });

  pi.on("session_shutdown", async () => {
    await eventManager.handleSessionShutdown();
  });

  // Streaming lifecycle
  pi.on("message_start", (event) => {
    eventManager.handleMessageStart(event);
  });

  pi.on("message_update", (event, ctx: ExtensionContext) => {
    eventManager.handleMessageUpdate(event, ctx);
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    await eventManager.handleAgentEnd(event, ctx);
  });
};

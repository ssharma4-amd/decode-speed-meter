# pi-token-speed graph fork

A [Pi Coding Agent](https://pi.dev/) extension that keeps the original footer TPS status and adds a persistent terminal-native decode-speed chart below the editor.

## Decode graph

The graph measures one **estimated model decode** stream. Text, reasoning, and every streamed tool-call JSON payload are merged into that stream. It intentionally does not split reasoning, answer text, or tool arguments: they are all model output.

- A 2×4-dot-per-cell Unicode **Braille** chart plots a responsive one-second EMA of sampled decode TPS as the accent line and the request mean as a dim secondary line. Raw interval samples are retained for diagnostics.
- It defaults to a bounded whole-request overview with a point budget derived from `graphHistoryMs` (30 seconds / 250ms = roughly 121 points) and a six-cell-row chart. It is **not** a trailing 30-second window: endpoints and adaptive samples are retained without unbounded arrays.
- The primary chart and **Interactive** Now/Mean/Peak show one active parent/child decoder—the relevant user-facing interactivity. Now and Peak use the responsive smoothed series; Mean is the request-wide decode average. A separately labeled **Aggregate capacity** Now/Mean/Peak shows the sum of concurrent decoders. Both means are time-weighted over intervals with at least one active decoder.
- Metrics show total output tokens, first response, request wall-clock duration, summed active decoder duration (worker-seconds), and state. At wide widths compact Parent/opaque-Child summaries include per-decoder mean and peak.
- Local engine sampling is TUI-only and starts only during an active model stream. After parent `agent_end`, local samples freeze while the parent TUI continues polling enabled child sidecars, so late child completion is still reflected without changing the parent series.
- Tool execution is excluded from decode duration/TPS: after every `toolcall_end`, sampling and elapsed time pause until the next generated delta. Resuming rebases the sampler so tool time does not create a fake low-speed point.

### Provenance

Graph speed, peak, and mean are always marked **estimated**: Pi transport deltas are chunks, not tokens, and do not carry provider timestamps. The `direct` counting strategy means one estimated token per delta; `estimate` uses a word/punctuation approximation.

When enabled, progressive provider `usage.output` may improve the live footer **total** per assistant response. Providers often initialize partial `usage.output` to `0`; that placeholder deliberately does **not** suppress the live estimate. A positive progressive value replaces that response's estimate. At agent end, assistant usage (including a final zero) is authoritative. Final reconciliation removes `~` from Total only; it never changes decode history, peak, mean, or the estimated graph label.

## Local installation (without global changes)

From this repository:

```bash
npm install
pi -e ./index.ts
```

For project-local auto-discovery and `/reload`, copy or symlink this repository to `.pi/extensions/pi-token-speed-graph/` in the target project. Do not copy it to `~/.pi` unless a global extension is explicitly desired. Installing, testing, and checking this repository does not alter global Pi settings or the globally installed Pi package.

## AMD Megakernels demo

The standalone browser demo renders the AMD Megakernels-branded dashboard. When `LLM_GATEWAY_KEY` is available, it defaults to a direct OpenAI-compatible gateway connection:

```bash
npm run demo
```

Open the complete tokenized URL printed by the server. The demo defaults to port `8790`; use `PI_SPEED_DEMO_PORT=8800 npm run demo` to change it.
It binds to `127.0.0.1` by default. Set `PI_SPEED_DEMO_HOST=0.0.0.0` only when the demo runs inside an isolated container and the host reaches it through the container's private network address.

For the AMD gateway configured in `~/.codex/config.toml`:

```bash
PI_SPEED_DEMO_MODE=direct \
PI_OPENAI_BASE_URL=https://llm-api.amd.com/OpenAI \
PI_OPENAI_MODEL=your-model-id \
PI_OPENAI_API_KEY="$LLM_GATEWAY_KEY" \
PI_OPENAI_API_VERSION=preview \
PI_OPENAI_USER=anandaku \
npm run demo
```

The API key remains server-side. The direct mode sends streaming requests to `/chat/completions`, supports vLLM/OpenAI-compatible SSE, and uses provider completion usage when the gateway returns it. Set `PI_OPENAI_REASONING_EFFORT=high` when the gateway/model supports that request field; reasoning chunks are displayed when the endpoint exposes `reasoning_content`, `reasoning`, or `reasoning_text`. `PI_OPENAI_TIMEOUT_MS` defaults to `120000`. Set `PI_SPEED_DEMO_MODE=pi` to use the legacy local `pi --mode rpc` compatibility path instead. In Pi mode, `PI_BIN`, `PI_SPEED_DEMO_CWD`, and `PI_SPEED_DEMO_PERSIST=1` retain their previous meanings.

## Configuration

Add a `tokenSpeed` section to Pi settings when desired:

```json
{
  "tokenSpeed": {
    "slidingWindow": 1000,
    "display": "tps",
    "useProviderTokens": false,
    "countStrategy": "direct",
    "endTpsBehavior": "average",
    "icon": "⚡",
    "updateInterval": 0,
    "graphEnabled": true,
    "graphHistoryMs": 30000,
    "graphSampleInterval": 250,
    "graphHeight": 6,
    "includeSubagents": true,
    "subagentStaleMs": 3000,
    "subagentRetentionMs": 600000
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `slidingWindow` | `1000` | Footer TPS window in ms (`100`–`30000`) |
| `display` | `tps` | Footer display: `tps`, `ttft`, `stats`, or `full` |
| `useProviderTokens` | `false` | Use progressive per-response provider usage for the live footer total when present |
| `countStrategy` | `direct` | `direct` = one estimated token per delta; `estimate` = content approximation |
| `endTpsBehavior` | `average` | Footer post-stream TPS: `average` or `last` |
| `icon` | `⚡` | Footer icon; empty string hides it |
| `updateInterval` | `0` | Footer update throttle in ms; `0` means every delta |
| `graphEnabled` | `true` | Show the below-editor graph; `/tps` toggles it without resetting a run |
| `graphHistoryMs` | `30000` | Whole-request chart point-budget hint (`ceil(graphHistoryMs / graphSampleInterval) + 1`, bounded to 16–480); retained for config compatibility, no longer a trailing-time window |
| `graphSampleInterval` | `250` | Graph sample interval in ms (`100`–`1000`) |
| `graphHeight` | `6` | Braille chart cell rows (`3`–`12`); narrow terminals reduce it as needed |
| `includeSubagents` | `true` | In a parent TUI session, read only this session's child decode sidecars |
| `subagentStaleMs` | `3000` | Freshness limit for active child snapshots (`500`–`60000` ms and at least twice `graphSampleInterval`) |
| `subagentRetentionMs` | `600000` | Keep completed child totals in this parent session (`subagentStaleMs`–`86400000` ms) |

All invalid settings are corrected to defaults with a session-start warning. The `/tps` menu retains footer, provider-total, count strategy, icon, update interval, and graph on/off settings.

## Subagent decode metrics

`pi-subagents` child processes do not share `message_update` events with their parent. When this extension is included in the child process, it writes a content-free numeric/state snapshot under the OS temporary directory (`pi-token-speed-subagents/<hashed-parent-session>/`, root and session directories mode `0700` and files `0600` where supported). The parent TUI polls only the hash of its own session ID. Snapshots contain numeric counters/timestamps, state, numeric child index, parent hash, and an opaque fixed `childId` (SHA-256 of the required run ID plus index)—never the run ID itself, agent name, model ID, prompts, deltas, generated text, tool arguments, CWD, secrets, or session paths. Rows render as `Child <index>`. A child with no run ID or valid nonnegative index disables reporting rather than writing a fallback identity.

Writes use random exclusive temporary files followed by atomic rename. As with any same-user temp-directory sidecar, a hostile same-user process can race directory entries or symlinks; permissions and validation reduce accidental exposure but do not attempt to solve that OS-level trust boundary.

The fleet chart is request-scoped: a new parent decode start resets its timeline and fleet statistics, while the earlier user-message timestamp starts end-to-end wall time (including TTFT/prefill). Retained sidecars are accepted only when their request start is at or after that parent user request. The primary chart samples **interactive TPS** (maximum active parent/child decoder rate), while the separately labeled **Aggregate capacity** values sample the concurrent sum. Their means are independently time-weighted over active intervals, so idle/tool-paused gaps do not lower either one. Completed children remain in totals for `subagentRetentionMs`, but are not active or included in current TPS. The request is complete only once the parent and all currently known children are complete/inactive; polling continues after parent `agent_end`, and a late child reopens the overview. **First response** remains the root request's TTFT (a later child-local TTFT cannot make it look shorter). **Wall duration** starts at the root user message and freezes at fleet completion; **Decode duration** is summed active decoder time (worker-seconds). Wide per-decoder rows use only `Parent` and `Child <numeric-index>-<opaque-hash-prefix>` labels, never run IDs or content.

To have `pi-subagents` load this repository in headless children, add this to the existing `subagents.defaultExtensions` setting (adjust the absolute path for your checkout; this extension does not write settings itself):

```json
{
  "subagents": {
    "defaultExtensions": [
      "/Users/aditya_nandakumar/workspace/inference_engines/pi_speed_tracker/index.ts"
    ]
  }
}
```

Agents configured with an explicit `extensions` list may override defaults; include this `index.ts` in those agents explicitly. Child mode acknowledges `subagent:acknowledge-extension` with id `pi-token-speed`, creates no widget, and uses one unref'd reporter timer. The parent creates its filesystem poller only in TUI mode.

## Lifecycle and tool behavior

1. A user message starts first-response timing.
2. The first text, thinking, or tool-call delta records first response. A content-block start activates stream state but does not stop first-response timing.
3. Text, thinking, and all tool-call deltas increment the same estimated decode stream.
4. Every completed tool call pauses active decode timing and graph sampling. The next delta resumes with a rebased sample baseline.
5. On agent end, local sampling stops, final usage reconciles Total only, the graph is repainted without adding a parent sample, and the footer is force-updated despite its throttle. A parent TUI with `includeSubagents` remains on its sidecar poll cadence.
6. On shutdown/reload/graph disable the widget and unref'd timer are disposed. Generic JSON, RPC, and print modes remain inert.

## Development

```bash
npm test
npm run check
npm run check:demo
git diff --check
npm audit --omit=dev
npm pack --dry-run
```

No commit, publish, or global package installation is required.

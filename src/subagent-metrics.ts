import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUBAGENT_METRICS_SCHEMA = 1;
export type SidecarState = "streaming" | "paused" | "complete" | "idle";

/** Deliberately small, content-free cross-process contract. */
export interface SubagentSnapshot {
  schemaVersion: typeof SUBAGENT_METRICS_SCHEMA;
  parentSessionHash: string;
  /** Stable SHA-256 of the private run ID and public numeric child slot. */
  childId: string;
  index: number;
  pid: number;
  timestamp: number;
  startedAt: number;
  state: SidecarState;
  currentTps: number;
  meanTps: number;
  peakTps: number;
  decodeTokens: number;
  totalTokens: number;
  totalEstimated: boolean;
  firstResponseMs: number;
  activeDecodeMs: number;
}

export interface SidecarOptions {
  root?: string;
  staleMs: number;
  retentionMs: number;
  now?: () => number;
}

const states = new Set<SidecarState>(["streaming", "paused", "complete", "idle"]);
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_CHILD_INDEX = 1_000_000;
const MAX_PID = 16_777_216;
const MAX_TPS = 1_000_000_000;
const isIntegerIn = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const isMetric = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;

/** Hashing prevents a child from learning or exposing a parent session identifier in filenames. */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** Never persist the run ID; it is only used to derive this fixed opaque child identity. */
export function childIdForRun(runId: string, index: number): string {
  return createHash("sha256").update(`${runId}:${index}`).digest("hex");
}

export function sidecarRoot(root = tmpdir()): string { return join(root, "pi-token-speed-subagents"); }
export function sidecarDirectory(parentSessionHash: string, root = tmpdir()): string {
  return join(sidecarRoot(root), parentSessionHash);
}
export function sidecarFile(snapshot: Pick<SubagentSnapshot, "parentSessionHash" | "childId">, root = tmpdir()): string {
  return join(sidecarDirectory(snapshot.parentSessionHash, root), `${snapshot.childId}.json`);
}

/** Reject unknown additions as well as malformed values, so content cannot slip into this channel. */
export function validateSnapshot(value: unknown): SubagentSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "parentSessionHash", "childId", "index", "pid", "timestamp", "startedAt", "state", "currentTps", "meanTps", "peakTps", "decodeTokens", "totalTokens", "totalEstimated", "firstResponseMs", "activeDecodeMs"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (
    record.schemaVersion !== SUBAGENT_METRICS_SCHEMA ||
    typeof record.parentSessionHash !== "string" || !/^[a-f0-9]{32}$/.test(record.parentSessionHash) ||
    typeof record.childId !== "string" || !/^[a-f0-9]{64}$/.test(record.childId) ||
    !isIntegerIn(record.index, MAX_CHILD_INDEX) || !isIntegerIn(record.pid, MAX_PID) ||
    !isIntegerIn(record.timestamp, MAX_DATE_MS) || !isIntegerIn(record.startedAt, MAX_DATE_MS) ||
    !states.has(record.state as SidecarState) ||
    !isMetric(record.currentTps, MAX_TPS) || !isMetric(record.meanTps, MAX_TPS) || !isMetric(record.peakTps, MAX_TPS) ||
    !isMetric(record.decodeTokens) || !isMetric(record.totalTokens) ||
    typeof record.totalEstimated !== "boolean" ||
    !isIntegerIn(record.firstResponseMs, MAX_DATE_MS) || !isIntegerIn(record.activeDecodeMs, MAX_DATE_MS)
  ) return undefined;
  return record as unknown as SubagentSnapshot;
}

/** Atomic rename means readers see either an old complete JSON document or a new one. */
export async function writeSnapshot(snapshot: SubagentSnapshot, root = tmpdir()): Promise<string> {
  const checked = validateSnapshot(snapshot);
  if (!checked) throw new Error("Refusing invalid subagent metrics snapshot");
  const rootDir = sidecarRoot(root);
  const dir = sidecarDirectory(snapshot.parentSessionHash, root);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700).catch(() => undefined);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const destination = sidecarFile(snapshot, root);
  // Random exclusive temp names avoid predictable same-directory collisions. The
  // destination remains replaceable by the current user's filesystem permissions.
  const temporary = join(dir, `.${snapshot.childId}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(checked), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, destination);
  await chmod(destination, 0o600).catch(() => undefined);
  return destination;
}

export async function readSnapshots(parentSessionHash: string, options: SidecarOptions): Promise<SubagentSnapshot[]> {
  const now = options.now?.() ?? Date.now();
  const dir = sidecarDirectory(parentSessionHash, options.root);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const snapshots: SubagentSnapshot[] = [];
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const path = join(dir, name);
    try {
      const snapshot = validateSnapshot(JSON.parse(await readFile(path, "utf8")));
      if (!snapshot || snapshot.parentSessionHash !== parentSessionHash || snapshot.timestamp > now + options.staleMs) return;
      const age = now - snapshot.timestamp;
      const retained = snapshot.state === "complete" ? age <= options.retentionMs : age <= options.staleMs;
      if (retained) snapshots.push(snapshot);
      else await rm(path, { force: true }).catch(() => undefined);
    } catch { /* malformed/half-removed entries are intentionally ignored */ }
  }));
  // One fixed path is used per opaque child identity; retain this dedupe for
  // interrupted/replaced files and malicious duplicate names.
  const newest = new Map<string, SubagentSnapshot>();
  for (const snapshot of snapshots) {
    if ((newest.get(snapshot.childId)?.timestamp ?? -1) < snapshot.timestamp) newest.set(snapshot.childId, snapshot);
  }
  return [...newest.values()];
}

/** Retention is session-wide; callers must additionally isolate one parent user request. */
export function filterSnapshotsForRequest(snapshots: readonly SubagentSnapshot[], parentStartedAt: number): SubagentSnapshot[] {
  return parentStartedAt > 0 ? snapshots.filter((snapshot) => snapshot.startedAt >= parentStartedAt) : [];
}

export async function cleanupSnapshots(parentSessionHash: string, options: SidecarOptions): Promise<void> {
  await readSnapshots(parentSessionHash, options);
}

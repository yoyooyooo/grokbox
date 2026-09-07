import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireExclusiveLock } from "./op-lock.ts";
import { eventsPath } from "./paths.ts";
import { observeText, type ObservationState } from "./observation.ts";
import { CONTRACT_SLICE_NAMES } from "./contracts.ts";

export const EVENT_NAMES = [
  "disk_sha_observed",
  "contracts_snapshot",
  "attestation_invalidated",
  "census",
  "stale_patched_detected",
  "stale_patched_term",
  "circuit_open",
  "inject_phase",
  "turn_seam_terminal",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const CONTROL_PLANE_EVENT_RETENTION = 256;
export const TURN_SEAM_TERMINAL_RETENTION = 256;
export const TURN_SEAM_BOUNDED_STRING = 128;

const ALLOWED_FIELDS = new Set([
  "name",
  "at",
  "sha",
  "oldSha",
  "newDiskSha",
  "outcome",
  "reason",
  "counts",
  "driftedSlices",
  "phase",
  "pid",
  "start",
]);

const FORBIDDEN = /env|token|prompt|authorization|secret|apiKey/i;

const TURN_SEAM_MODES = new Set(["identity", "route"]);
const TURN_SEAM_ASSIGNMENTS = new Set(["official", "main", "agent"]);
const TURN_SEAM_TERMINAL_CLASSES = new Set(["stop", "error", "abort", "unknown"]);
const TURN_SEAM_OUTCOMES = new Set(["official", "managed", "last_resort_official", "rejected"]);

export type RuntimeEvent = {
  name: EventName;
  at: string;
  [key: string]: unknown;
};

export type TurnSeamMode = "identity" | "route";
export type TurnSeamAssignment = "official" | "main" | "agent";
export type TurnSeamTerminalClass = "stop" | "error" | "abort" | "unknown";
export type TurnSeamOutcome = "official" | "managed" | "last_resort_official" | "rejected";

export type TurnSeamTerminalEvent = {
  name: "turn_seam_terminal";
  at: string;
  mode: TurnSeamMode;
  agentId: string;
  assignment: TurnSeamAssignment;
  modelId?: string;
  invocationId: string;
  toolCallCount: number;
  terminalClass: TurnSeamTerminalClass;
  outcome: TurnSeamOutcome;
};

export type TurnSeamWriteResult = "written" | "unprojected" | "write_failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = TURN_SEAM_BOUNDED_STRING): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (/[\n\r]/.test(value)) return null;
  return value;
}

function boundedEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLogDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function withEventsLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = eventsPath(root).replace(/events\.ndjson$/, "events.lock");
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const got = await acquireExclusiveLock(lockPath);
    if (got.ok) {
      try {
        return await fn();
      } finally {
        await got.lock.release();
      }
    }
    await delay(2);
  }
  throw new Error("box-runtime events journal lock timeout");
}

async function appendLine(root: string, line: string): Promise<void> {
  const path = eventsPath(root);
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  await withEventsLock(root, async () => {
    await ensureLogDir(path);
    const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
    try {
      await chmod(path, 0o600);
      await handle.write(Buffer.from(payload));
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

export function sanitizeEvent(input: RuntimeEvent): RuntimeEvent {
  const out: RuntimeEvent = { name: input.name, at: input.at };
  for (const [key, value] of Object.entries(input)) {
    if (key === "name" || key === "at") continue;
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (FORBIDDEN.test(key)) continue;
    if (typeof value === "string" && FORBIDDEN.test(value)) continue;
    out[key] = value;
  }
  return out;
}

export function projectTurnSeamTerminal(input: unknown): TurnSeamTerminalEvent | null {
  if (!isRecord(input)) return null;
  if (input.name !== "turn_seam_terminal") return null;
  const at = boundedString(input.at, TURN_SEAM_BOUNDED_STRING);
  const mode = boundedEnum(input.mode, TURN_SEAM_MODES) as TurnSeamMode | null;
  const agentId = boundedString(input.agentId);
  const assignment = boundedEnum(input.assignment, TURN_SEAM_ASSIGNMENTS) as TurnSeamAssignment | null;
  const invocationId = boundedString(input.invocationId);
  const toolCallCount = boundedCount(input.toolCallCount);
  const terminalClass = boundedEnum(input.terminalClass, TURN_SEAM_TERMINAL_CLASSES) as TurnSeamTerminalClass | null;
  const outcome = boundedEnum(input.outcome, TURN_SEAM_OUTCOMES) as TurnSeamOutcome | null;
  if (
    at == null ||
    mode == null ||
    agentId == null ||
    assignment == null ||
    invocationId == null ||
    toolCallCount == null ||
    terminalClass == null ||
    outcome == null
  ) {
    return null;
  }
  if (mode === "route" && assignment === "official") return null;
  if (assignment === "official" && outcome === "managed") return null;
  const officialExecution = outcome === "official" || outcome === "last_resort_official";
  const modelId = officialExecution ? null : boundedString(input.modelId);
  if (!officialExecution && modelId == null) return null;
  return {
    name: "turn_seam_terminal",
    at,
    mode,
    agentId,
    assignment,
    ...(modelId != null ? { modelId } : {}),
    invocationId,
    toolCallCount,
    terminalClass,
    outcome,
  };
}

export function selectRetainedEventLines(lines: string[]): string[] {
  const parsed = lines
    .filter((line) => line.length > 0)
    .map((line) => {
      let turn = false;
      try {
        const value = JSON.parse(line) as { name?: unknown };
        turn = value.name === "turn_seam_terminal";
      } catch {
        turn = false;
      }
      return { line, turn };
    });
  const control = parsed.filter((row) => !row.turn);
  const turns = parsed.filter((row) => row.turn);
  const keep = new Set([
    ...control.slice(-CONTROL_PLANE_EVENT_RETENTION),
    ...turns.slice(-TURN_SEAM_TERMINAL_RETENTION),
  ]);
  return parsed.filter((row) => keep.has(row)).map((row) => row.line);
}

export async function appendEvent(root: string, event: RuntimeEvent): Promise<void> {
  if (event.name === "turn_seam_terminal") return;
  await appendLine(root, JSON.stringify(sanitizeEvent(event)));
}

export async function appendTurnSeamTerminal(root: string, input: unknown): Promise<TurnSeamWriteResult> {
  const projected = projectTurnSeamTerminal(input);
  if (!projected) return "unprojected";
  try {
    await appendLine(root, JSON.stringify(projected));
    return "written";
  } catch {
    return "write_failed";
  }
}

function projectControlEvent(input: unknown): RuntimeEvent | TurnSeamTerminalEvent | null {
  if (!isRecord(input) || !(EVENT_NAMES as readonly unknown[]).includes(input.name)) return null;
  if (input.name === "turn_seam_terminal") return projectTurnSeamTerminal(input);
  const at = boundedString(input.at);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const out: RuntimeEvent = { name: input.name as EventName, at };
  for (const key of ["sha", "oldSha", "newDiskSha"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return null;
    out[key] = value;
  }
  for (const key of ["reason", "outcome", "phase"]) {
    const value = input[key];
    if (value === undefined) continue;
    const text = boundedString(value);
    if (!text || !/^[a-zA-Z0-9_-]+$/.test(text) || FORBIDDEN.test(text)) return null;
    out[key] = text;
  }
  for (const key of ["pid", "start"]) {
    if (input[key] === undefined) continue;
    if (boundedCount(input[key]) === null) return null;
    out[key] = input[key];
  }
  if (input.driftedSlices !== undefined) {
    if (!Array.isArray(input.driftedSlices) || input.driftedSlices.length > CONTRACT_SLICE_NAMES.length ||
      !input.driftedSlices.every((key) => (CONTRACT_SLICE_NAMES as readonly unknown[]).includes(key))) return null;
    out.driftedSlices = [...input.driftedSlices];
  }
  if (input.counts !== undefined) {
    if (!isRecord(input.counts)) return null;
    const counts: Record<string, number> = {};
    for (const key of ["wrapper", "supervisor", "host", "tempSupervisor", "guardian", "extras"]) {
      if (input.counts[key] === undefined) continue;
      const value = boundedCount(input.counts[key]);
      if (value === null) return null;
      counts[key] = value;
    }
    out.counts = counts;
  }
  return out;
}

export type EventsObservation = {
  state: ObservationState | "partial";
  events: Array<RuntimeEvent | TurnSeamTerminalEvent | { invalid: true }>;
  truncated: boolean;
};

/** Snapshot only: bounded reads and schema projection, without event locks/compaction/repair. */
export async function observeEvents(root: string, limit = CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION): Promise<EventsObservation> {
  const cap = CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION;
  if (!Number.isSafeInteger(limit) || limit < 0) return { state: "invalid", events: [], truncated: false };
  const text = await observeText(eventsPath(root), 1024 * 1024);
  if (text.state !== "present") return { state: text.state, events: [], truncated: false };
  const lines = text.value.split("\n").filter((line) => line.length > 0);
  const bounded = Math.min(limit, cap);
  const tail = bounded === 0 ? [] : lines.slice(-bounded);
  const events = tail.map((line) => {
    try { return projectControlEvent(JSON.parse(line)) ?? { invalid: true as const }; }
    catch { return { invalid: true as const }; }
  });
  return { state: events.some((event) => "invalid" in event) ? "partial" : "present", events, truncated: lines.length > bounded };
}

export async function compactEvents(root: string): Promise<void> {
  const path = eventsPath(root);
  await withEventsLock(root, async () => {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const kept = selectRetainedEventLines(text.split("\n"));
    const body = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await ensureLogDir(path);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    await chmod(path, 0o600);
  });
}

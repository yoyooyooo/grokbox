import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireExclusiveLock } from "./op-lock.ts";
import { eventsPath } from "./paths.ts";

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
  const modelId = assignment === "official" ? null : boundedString(input.modelId);
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

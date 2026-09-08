import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { journalRoleAllows } from "@grokbox/runtime-kernel/status";

export type HostJournalWriteResult = "written" | "unprojected" | "write_failed";

const TURN_SEAM_BOUNDED_STRING = 128;
const TURN_SEAM_MODES = new Set(["identity", "route"]);
const TURN_SEAM_ASSIGNMENTS = new Set(["official", "main", "agent"]);
const TURN_SEAM_TERMINAL_CLASSES = new Set(["stop", "error", "abort", "unknown"]);
const TURN_SEAM_OUTCOMES = new Set(["official", "managed", "last_resort_official", "rejected"]);
const TURN_SEAM_ERROR_CODES = new Set([
  "invalid_envelope",
  "unsupported_content",
  "invalid_tools",
  "unsupported_options",
  "envelope_too_large",
  "unsupported_image",
  "parallel_tools",
  "invocation_conflict",
  "model_error",
  "stream_limit",
  "invalid_stream",
]);
const HOST_STREAM_REJECT_REASONS = new Set(["missing-step-id", "invalid-step-id"]);
const FORBIDDEN = /env|token|prompt|authorization|secret|apiKey/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = TURN_SEAM_BOUNDED_STRING): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (/[\n\r]/.test(value)) return null;
  if (FORBIDDEN.test(value)) return null;
  return value;
}

function boundedEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function hostEventsPath(root: string): string {
  return join(root, "log", "events.ndjson");
}

function lockPath(root: string): string {
  return hostEventsPath(root).replace(/events\.ndjson$/, "events.lock");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLogDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function withEventsLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(root);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      try {
        return await fn();
      } finally {
        const { unlink } = await import("node:fs/promises");
        await unlink(path).catch(() => undefined);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await delay(2);
  }
  throw new Error("box-runtime events journal lock timeout");
}

export async function appendNdjsonLine(root: string, line: string): Promise<void> {
  const path = hostEventsPath(root);
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

export function projectTurnSeamTerminal(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.name !== "turn_seam_terminal") return null;
  if (!journalRoleAllows("host", "turn_seam_terminal")) return null;
  const at = boundedString(input.at);
  const mode = boundedEnum(input.mode, TURN_SEAM_MODES);
  const agentId = boundedString(input.agentId);
  const assignment = boundedEnum(input.assignment, TURN_SEAM_ASSIGNMENTS);
  const invocationId = boundedString(input.invocationId);
  const toolCallCount = boundedCount(input.toolCallCount);
  const terminalClass = boundedEnum(input.terminalClass, TURN_SEAM_TERMINAL_CLASSES);
  const outcome = boundedEnum(input.outcome, TURN_SEAM_OUTCOMES);
  if (!at || !mode || !agentId || !assignment || !invocationId || toolCallCount == null || !terminalClass || !outcome) {
    return null;
  }
  if (mode === "route" && assignment === "official") return null;
  if (assignment === "official" && outcome === "managed") return null;
  const officialExecution = outcome === "official" || outcome === "last_resort_official";
  const modelId = officialExecution ? null : boundedString(input.modelId);
  if (!officialExecution && modelId == null) return null;
  const errorCode = boundedEnum(input.errorCode, TURN_SEAM_ERROR_CODES);
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
    ...(errorCode != null ? { errorCode } : {}),
  };
}

export function projectHostStreamRejected(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.name !== "host_stream_rejected" || input.schemaVersion !== 2) return null;
  const at = boundedString(input.at);
  const mode = boundedEnum(input.mode, TURN_SEAM_MODES);
  const hostGenerationId = boundedString(input.hostGenerationId);
  const agentId = boundedString(input.agentId);
  const turnId = boundedString(input.turnId);
  const stage = input.stage === "stream-id" ? "stream-id" : null;
  const errorCode = input.errorCode === "invalid_envelope" ? "invalid_envelope" : null;
  const reason = boundedEnum(input.reason, HOST_STREAM_REJECT_REASONS);
  if (!at || mode !== "route" || !hostGenerationId || !agentId || !turnId || !stage || !errorCode || !reason) return null;
  return {
    name: "host_stream_rejected",
    schemaVersion: 2,
    at,
    mode: "route",
    hostGenerationId,
    agentId,
    turnId,
    stage: "stream-id",
    errorCode: "invalid_envelope",
    reason,
  };
}

export function projectHostNormalizedTerminal(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.name !== "host_normalized_terminal") return null;
  const at = boundedString(input.at);
  const agentId = boundedString(input.agentId);
  const turnId = boundedString(input.turnId);
  if (!at || !agentId || !turnId) return null;
  return { name: "host_normalized_terminal", at, agentId, turnId };
}

function projectHostEvent(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || typeof input.name !== "string" || !journalRoleAllows("host", input.name)) return null;
  if (input.name === "turn_seam_terminal") return projectTurnSeamTerminal(input);
  if (input.name === "host_stream_rejected") return projectHostStreamRejected(input);
  if (input.name === "host_normalized_terminal") return projectHostNormalizedTerminal(input);
  return null;
}

/** Host-only append. Journal write failure never throws to the caller. */
export async function appendHostJournal(root: string, input: unknown): Promise<HostJournalWriteResult> {
  const projected = projectHostEvent(input);
  if (!projected) return "unprojected";
  try {
    await appendNdjsonLine(root, JSON.stringify(projected));
    return "written";
  } catch {
    return "write_failed";
  }
}

export async function appendTurnSeamTerminal(root: string, input: unknown): Promise<HostJournalWriteResult> {
  return appendHostJournal(root, input);
}

export async function appendHostStreamRejected(root: string, input: unknown): Promise<HostJournalWriteResult> {
  return appendHostJournal(root, input);
}

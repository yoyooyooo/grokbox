import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyInferenceTupleOrReject, journalRoleAllows } from "@grokbox/runtime-kernel/status";
import { HOST_STATE_SHAPES } from "./context-codec.ts";

export type HostJournalWriteResult = "written" | "unprojected" | "write_failed";

const TURN_SEAM_BOUNDED_STRING = 128;
const TURN_SEAM_MODES = new Set(["identity", "route"]);
const TURN_SEAM_ASSIGNMENTS = new Set(["official", "main", "agent"]);
const TURN_SEAM_TERMINAL_CLASSES = new Set(["stop", "error", "abort", "unknown"]);
const TURN_SEAM_OUTCOMES = new Set(["official", "managed", "last_resort_official", "rejected"]);
const TURN_SEAM_ERROR_CODES = new Set([
  "runtime_config_invalid",
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
const HOST_STREAM_REJECT_STAGES = new Set(["stream-id", "admit", "normalize", "connect", "provider"]);
const HOST_STREAM_REJECT_REASONS = new Set([
  "missing-step-id",
  "invalid-step-id",
  "missing-turn",
  "missing-binding",
  "missing-bridge",
  "invalid-state",
  "selection-unavailable",
  "connect-failed",
  "terminal-rejected",
]);
const HOST_SEAM_STAGES = new Set(["hook_enter", "hook_decline", "stream_enter", "connect_attempt", "first_chunk"]);
const HOST_SEAM_RESULTS = new Set(["entered", "ok", "fail", "compact_passthrough"]);
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
  const stage = boundedEnum(input.stage, HOST_STREAM_REJECT_STAGES);
  const errorCode = boundedEnum(input.errorCode, TURN_SEAM_ERROR_CODES);
  const reason = boundedEnum(input.reason, HOST_STREAM_REJECT_REASONS);
  if (!at || mode !== "route" || !agentId || !stage || !errorCode || !reason) return null;
  if (reason !== "missing-turn" && !turnId) return null;
  if (reason === "missing-step-id" || reason === "invalid-step-id") {
    if (stage !== "stream-id" || !turnId || !hostGenerationId) return null;
  }
  return {
    name: "host_stream_rejected",
    schemaVersion: 2,
    at,
    mode: "route",
    ...(hostGenerationId ? { hostGenerationId } : {}),
    agentId,
    ...(turnId ? { turnId } : {}),
    ...(boundedString(input.stepId) ? { stepId: boundedString(input.stepId) } : {}),
    stage,
    errorCode,
    reason,
    ...(reason === "invalid-state" && (HOST_STATE_SHAPES as readonly unknown[]).includes(input.stateShape)
      ? { stateShape: input.stateShape } : {}),
  };
}

export function projectHostSeamStage(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.name !== "host_seam_stage" || input.schemaVersion !== 1) return null;
  const at = boundedString(input.at);
  const stage = boundedEnum(input.stage, HOST_SEAM_STAGES);
  const result = boundedEnum(input.result, HOST_SEAM_RESULTS);
  if (!at || !stage || !result) return null;
  const auxPurpose = input.auxPurpose === "memory-extraction" || input.auxPurpose === "episode" ? input.auxPurpose : undefined;
  const parentStepId = boundedString(input.parentStepId);
  const hasAux = input.auxPurpose !== undefined || input.parentStepId !== undefined;
  if (hasAux && (stage !== "stream_enter" || !auxPurpose || !parentStepId
    || !boundedString(input.stepId) || input.stepId === parentStepId
    || !boundedString(input.agentId) || !boundedString(input.turnId))) return null;
  const hostGenerationId = boundedString(input.hostGenerationId);
  const agentId = boundedString(input.agentId);
  const turnId = boundedString(input.turnId);
  const stepId = boundedString(input.stepId);
  return {
    name: "host_seam_stage",
    schemaVersion: 1,
    at,
    stage,
    result,
    ...(hostGenerationId ? { hostGenerationId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(hasAux ? { auxPurpose, parentStepId } : {}),
  };
}

export function projectHostNormalizedTerminal(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.name !== "host_normalized_terminal") return null;
  const at = boundedString(input.at);
  if (!at) return null;
  const tuple = copyInferenceTupleOrReject(input);
  if (tuple == null) return null;
  const terminalClass = boundedEnum(input.terminalClass, TURN_SEAM_TERMINAL_CLASSES);
  const errorCode = boundedEnum(input.errorCode, TURN_SEAM_ERROR_CODES);
  const toolCallCount = boundedCount(input.toolCallCount);
  const modelId = boundedString(input.modelId);
  if (input.terminalClass !== undefined && !terminalClass) return null;
  if (input.errorCode !== undefined && (!errorCode || terminalClass !== "error")) return null;
  return { name: "host_normalized_terminal", at, ...tuple,
    ...(terminalClass ? { terminalClass } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(toolCallCount !== null ? { toolCallCount } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function projectHostEvent(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || typeof input.name !== "string" || !journalRoleAllows("host", input.name)) return null;
  if (input.name === "turn_seam_terminal") return projectTurnSeamTerminal(input);
  if (input.name === "host_stream_rejected") return projectHostStreamRejected(input);
  if (input.name === "host_normalized_terminal") return projectHostNormalizedTerminal(input);
  if (input.name === "host_seam_stage") return projectHostSeamStage(input);
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

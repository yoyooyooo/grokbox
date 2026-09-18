import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyInferenceTupleOrReject, journalRoleAllows } from "@grokbox/runtime-kernel/status";
import { projectAlertEvent } from "@grokbox/runtime-kernel/alerts";
import { projectServerActivityEvent } from "@grokbox/runtime-kernel/contract";
import { projectStreamDiagnostic, projectStreamSummary, projectFailureSummary, type FailureSummary } from "@grokbox/runtime-kernel/contract";
import { noteUnprojectedJournalEvent, startJournalWrite, type JournalWriterRole } from "./journal-health.node.ts";
import { projectRunObservation } from "./run-observation.ts";
import { projectRuntimeBuildInfo, type RuntimeBuildInfo } from "@grokbox/runtime-kernel/contract";
import { projectObservationIdentity, type ObservationIdentity } from "./observation-identity.node.ts";
import { projectNativeTurnObservation } from "./turn-observation.ts";
import { HOST_STATE_SHAPES } from "./context-codec.ts";
import { prepareJournalAppend, type JournalRotationOptions } from "./journal-segments.node.ts";
import { withJournalLock } from "./journal-lock.node.ts";
import {
  boundedClientNonce,
  HOST_FAILURE_CATALOG,
  HOST_JOURNAL_FORBIDDEN,
  type HostStreamRejectReason,
} from "./failure-catalog.ts";

export type HostJournalWriteResult = "written" | "unprojected" | "write_failed";
export type { HostStreamRejectReason };

const TURN_SEAM_BOUNDED_STRING = 128;
const TURN_SEAM_MODES = new Set(["identity", "route"]);
const TURN_SEAM_ASSIGNMENTS = new Set(["official", "main", "agent"]);
const TURN_SEAM_TERMINAL_CLASSES = new Set(["stop", "error", "abort", "unknown"]);
const TURN_SEAM_OUTCOMES = new Set(["official", "managed", "last_resort_official", "rejected"]);
export const TURN_SEAM_ERROR_CODES = new Set([
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
  "transport_error",
  "not_admitted",
  "capacity",
  "ledger_unavailable",
  "stream_limit",
  "invalid_stream",
  "unsupported_version",
]);
const HOST_STREAM_REJECT_STAGES = new Set(["stream-id", "admit", "normalize", "connect", "provider", "authority", "transport"]);
export const HOST_STREAM_REJECT_REASONS = new Set<string>(HOST_FAILURE_CATALOG.map((row) => row.reason));
const HOST_SEAM_STAGES = new Set(["hook_enter", "hook_decline", "stream_enter", "connect_attempt", "first_chunk"]);
const HOST_SEAM_RESULTS = new Set(["entered", "ok", "fail", "compact_passthrough"]);
const FORBIDDEN = HOST_JOURNAL_FORBIDDEN;

export type HostStreamRejectedEvent = {
  name: "host_stream_rejected";
  schemaVersion: 2;
  at: string;
  mode: "route";
  hostGenerationId?: string;
  agentId: string;
  turnId?: string;
  stepId?: string;
  clientNonce?: string;
  stage: string;
  errorCode: string;
  reason: string;
  stateShape?: string;
  failureSummary?: FailureSummary;
  serviceEpoch?: string;
  diagnostic?: ReturnType<typeof projectStreamDiagnostic>;
  stream?: ReturnType<typeof projectStreamSummary>;
  requestKind?: "main" | "memory-extraction" | "episode";
  parentStepId?: string;
  observation?: ObservationIdentity;
  build?: RuntimeBuildInfo;
};

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

async function ensureLogDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("journal_unsafe_directory");
  if ((info.mode & 0o300) !== 0o300) throw Object.assign(new Error("journal_directory_not_writable"), { code: "EACCES" });
  await chmod(dir, 0o700);
}

export async function withEventsLock<T>(root: string, fn: () => Promise<T>, maxAttempts = 1000): Promise<T> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) throw new Error("journal_invalid_lock_budget");
  const path = lockPath(root);
  await ensureLogDir(path);
  return withJournalLock(path, fn, maxAttempts);
}

export async function appendNdjsonLine(root: string, line: string, role: JournalWriterRole = "control", rotation?: JournalRotationOptions): Promise<void> {
  const path = hostEventsPath(root);
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  const complete = startJournalWrite(root, role);
  if (!complete.accepted) {
    await complete();
    throw Object.assign(new Error("journal observation backlog"), { code: "JOURNAL_BACKPRESSURE" });
  }
  try {
    await withEventsLock(root, async () => {
      await ensureLogDir(path);
      const writtenPolicy = await prepareJournalAppend(root, Buffer.byteLength(payload), rotation);
      const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw Object.assign(new Error("journal is not regular"), { code: "EIO" });
        await handle.chmod(0o600);
        // writeFile handles short writes; the lock protects the entire record.
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await writtenPolicy?.();
    });
  } catch (error) { await complete(error); throw error; }
  await complete();
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

function projectStreamMetadata(input: Record<string, unknown>): {
  diagnostic?: ReturnType<typeof projectStreamDiagnostic>; stream?: ReturnType<typeof projectStreamSummary>;
  requestKind?: "main" | "memory-extraction" | "episode"; parentStepId?: string;
} {
  const diagnostic = projectStreamDiagnostic(input.diagnostic), stream = projectStreamSummary(input.stream);
  const parent = boundedString(input.parentStepId);
  const kind = input.requestKind === "main" || input.requestKind === "memory-extraction" || input.requestKind === "episode" ? input.requestKind : undefined;
  const qualified = kind === "main" ? parent === null : kind !== undefined && parent !== null && parent !== input.stepId;
  return { ...(diagnostic ? { diagnostic } : {}), ...(stream ? { stream } : {}),
    ...(qualified && kind ? { requestKind: kind, ...(parent ? { parentStepId: parent } : {}) } : {}) };
}

export function projectHostStreamRejected(input: unknown): HostStreamRejectedEvent | null {
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
  const clientNonce = boundedClientNonce(input.clientNonce);
  const stepId = boundedString(input.stepId);
  return {
    name: "host_stream_rejected",
    schemaVersion: 2,
    at,
    mode: "route",
    ...(hostGenerationId ? { hostGenerationId } : {}),
    agentId,
    ...(turnId ? { turnId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(clientNonce ? { clientNonce } : {}),
    stage,
    errorCode,
    reason,
    ...projectStreamMetadata(input),
    ...(projectObservationIdentity(input.observation) ? { observation: projectObservationIdentity(input.observation) } : {}),
    ...(projectRuntimeBuildInfo(input.build) ? { build: projectRuntimeBuildInfo(input.build) } : {}),
    ...(boundedString(input.serviceEpoch) ? { serviceEpoch: boundedString(input.serviceEpoch)! } : {}),
    ...(projectFailureSummary(input.failureSummary) ? { failureSummary: projectFailureSummary(input.failureSummary) } : {}),
    ...(reason === "invalid-state" && (HOST_STATE_SHAPES as readonly unknown[]).includes(input.stateShape)
      ? { stateShape: input.stateShape as string } : {}),
    ...runLinks(input),
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
  const clientNonce = boundedClientNonce(input.clientNonce);
  const source = isRecord(input.sourceIdentity) ? input.sourceIdentity : undefined;
  const sourceIdentity = source && [source.sourceSha256, source.profileSha256, source.transformedSha256]
    .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    ? { sourceSha256: source.sourceSha256, profileSha256: source.profileSha256, transformedSha256: source.transformedSha256 } : undefined;
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
    ...(clientNonce ? { clientNonce } : {}),
    ...(hasAux ? { auxPurpose, parentStepId } : {}),
    ...(projectObservationIdentity(input.observation) ? { observation: projectObservationIdentity(input.observation) } : {}),
    ...(stage === "hook_enter" && projectRuntimeBuildInfo(input.build) ? { build: projectRuntimeBuildInfo(input.build) } : {}),
    ...(stage === "hook_enter" && sourceIdentity ? { sourceIdentity } : {}),
    ...(stage === "hook_enter" && projectNativeTurnObservation(input.nativeTurn) ? { nativeTurn: projectNativeTurnObservation(input.nativeTurn) } : {}),
    ...(stage === "hook_enter" && (input.triggerEvidence === "not_instrumented" || (input.triggerEvidence === "client_nonce" && clientNonce)) ? { triggerEvidence: input.triggerEvidence } : {}),
    ...runLinks(input),
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
    ...(projectFailureSummary(input.failureSummary) ? { failureSummary: projectFailureSummary(input.failureSummary) } : {}),
    ...(boundedString(input.hostGenerationId) ? { hostGenerationId: boundedString(input.hostGenerationId)! } : {}),
    ...(boundedClientNonce(input.clientNonce) ? { clientNonce: boundedClientNonce(input.clientNonce) } : {}),
    ...projectStreamMetadata(input),
    ...(projectObservationIdentity(input.observation) ? { observation: projectObservationIdentity(input.observation) } : {}),
    ...(projectRuntimeBuildInfo(input.build) ? { build: projectRuntimeBuildInfo(input.build) } : {}),
    ...runLinks(input),
  };
}

function runLinks(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["dispatchId", "groupId", "groupDispatchId", "failureId"]) {
    const value = boundedString(input[k]); if (value) out[k] = value;
  }
  return out;
}

function projectHostEvent(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || typeof input.name !== "string" || !journalRoleAllows("host", input.name)) return null;
  if (input.name === "host_server_activity_observation") return projectServerActivityEvent(input);
  if (input.name === "host_alert_observation") return projectAlertEvent(input) as unknown as Record<string, unknown> | null;
  if (input.name === "host_run_observation") return projectRunObservation(input) as unknown as Record<string, unknown> | null;
  if (input.name === "turn_seam_terminal") return projectTurnSeamTerminal(input);
  if (input.name === "host_stream_rejected") return projectHostStreamRejected(input);
  if (input.name === "host_normalized_terminal") return projectHostNormalizedTerminal(input);
  if (input.name === "host_seam_stage") return projectHostSeamStage(input);
  return null;
}

/** Host-only append. Journal write failure never throws to the caller. */
export async function appendHostJournal(root: string, input: unknown, rotation?: JournalRotationOptions): Promise<HostJournalWriteResult> {
  const projected = projectHostEvent(input);
  if (!projected) { noteUnprojectedJournalEvent(root, "host"); return "unprojected"; }
  try {
    await appendNdjsonLine(root, JSON.stringify(projected), "host", rotation);
    return "written";
  } catch {
    return "write_failed";
  }
}

export async function appendTurnSeamTerminal(root: string, input: unknown, rotation?: JournalRotationOptions): Promise<HostJournalWriteResult> {
  return appendHostJournal(root, input, rotation);
}

export async function appendHostStreamRejected(root: string, input: unknown, rotation?: JournalRotationOptions): Promise<HostJournalWriteResult> {
  return appendHostJournal(root, input, rotation);
}

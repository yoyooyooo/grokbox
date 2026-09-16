import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { journalRoleAllows, projectSafeReason } from "@grokbox/runtime-kernel/status";
import { projectModelRecoveryProgress } from "@grokbox/runtime-kernel/contract";
import {
  appendHostStreamRejected,
  appendNdjsonLine,
  appendTurnSeamTerminal,
  projectHostSeamStage,
  projectHostNormalizedTerminal,
  projectHostStreamRejected,
  projectTurnSeamTerminal,
  withEventsLock,
  TURN_SEAM_ERROR_CODES,
  type HostStreamRejectedEvent,
} from "../host/terminal-journal.node.ts";
import { eventsPath } from "./paths.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { type ObservationState } from "./observation.node.ts";
import { readJournalWindow, type JournalWindow } from "./journal-reader.node.ts";
import { CONTRACT_SLICE_NAMES } from "./contracts.ts";
import { projectRunObservation } from "../host/run-observation.ts";
import { projectAlertEvent, traceAlerts, observationId } from "@grokbox/runtime-kernel/alerts";
import { projectModeldStepOutcome, type ModeldStepOutcomeEvent } from "./modeld-outcome.node.ts";

export {
  appendHostStreamRejected,
  appendTurnSeamTerminal,
  projectHostNormalizedTerminal,
  projectHostSeamStage,
  projectHostStreamRejected,
  projectTurnSeamTerminal,
  HOST_STREAM_REJECT_REASONS,
  TURN_SEAM_ERROR_CODES,
  type HostStreamRejectedEvent,
} from "../host/terminal-journal.node.ts";

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
  "host_normalized_terminal",
  // TODO(owner): names follow the MINI-1918 v2 review proposal; not a dated owner adjudication.
  "model_step_terminal",
  "model_recovery_progress",
  "host_stream_rejected",
  "host_seam_stage",
  "host_run_observation",
  "host_alert_observation",
  "provider_error_observed",
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
const SEAM_EVENT_NAMES = new Set([
  "turn_seam_terminal",
  "host_normalized_terminal",
  "model_step_terminal",
  "model_recovery_progress",
  "host_stream_rejected",
  "host_seam_stage",
  "host_run_observation",
  "host_alert_observation",
  "provider_error_observed",
]);
export const MODEL_STEP_STAGES = new Set([
  "stream-id",
  "append-snapshot",
  "bind-state",
  "message-shape",
  "tool-history",
  "tools",
  "options",
  "ipc",
  "admission",
  "admit",
  "provider",
  "normalize",
  "host-normalize",
  "abort",
  "disconnect",
  "internal",
]);
export const MODEL_STEP_ADMISSIONS = new Set(["none", "new", "duplicate", "unknown"]);

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
  errorCode?: string;
};

export type ModelStepStage = "stream-id" | "append-snapshot" | "bind-state" | "message-shape" | "tool-history" | "tools"
  | "options" | "ipc" | "admission" | "admit" | "provider" | "normalize" | "host-normalize" | "abort" | "disconnect" | "internal";
export type ModelStepAdmission = "none" | "new" | "duplicate" | "unknown";
export type { HostStreamRejectReason } from "../host/terminal-journal.node.ts";

export type ModelStepTerminalEvent = {
  name: "model_step_terminal";
  schemaVersion: 2;
  at: string;
  mode: "route";
  hostGenerationId: string;
  agentId: string;
  turnId: string;
  invocationId: string;
  modelId: string;
  assignment: TurnSeamAssignment;
  terminalClass: TurnSeamTerminalClass;
  outcome: TurnSeamOutcome;
  toolCallCount: number;
  stage: ModelStepStage;
  admission: ModelStepAdmission;
  errorCode?: string;
  serverGeneration?: string;
};

export type ProviderErrorObservedEvent = {
  name: "provider_error_observed";
  schemaVersion: 1;
  at: string;
  overflowCandidate: boolean;
  overflowReasons: string[];
  api?: "chat" | "responses";
  status?: number;
  providerCode?: "context_length_exceeded" | "context_window_exceeded" | "prompt_too_long" | "request_too_large" | "unknown";
  providerType?: "unknown";
  promptMessages?: number;
  promptChars?: number;
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

function boundedTimestamp(value: unknown, max = TURN_SEAM_BOUNDED_STRING): string | null {
  const at = boundedString(value, max);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  return at;
}

function boundedEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function sanitizeEvent(input: RuntimeEvent): RuntimeEvent | null {
  const at = boundedTimestamp(input.at);
  if (!at) return null;
  const out: RuntimeEvent = { name: input.name, at };
  for (const [key, value] of Object.entries(input)) {
    if (key === "name" || key === "at") continue;
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (FORBIDDEN.test(key)) continue;
    if (key === "reason") {
      const reason = projectSafeReason(value);
      if (reason) out.reason = reason;
      continue;
    }
    if (key === "counts") {
      if (!isRecord(value)) continue;
      const counts: Record<string, number> = {};
      for (const role of ["wrapper", "supervisor", "host", "tempSupervisor", "guardian", "extras"]) {
        const count = boundedCount(value[role]);
        if (count !== null) counts[role] = count;
      }
      out.counts = counts;
      continue;
    }
    if (key === "outcome" || key === "phase") {
      const text = boundedString(value);
      if (text && /^[a-zA-Z0-9_-]+$/.test(text) && !FORBIDDEN.test(text)) out[key] = text;
      continue;
    }
    if (key === "sha" || key === "oldSha" || key === "newDiskSha") {
      const text = boundedString(value);
      if (text && !FORBIDDEN.test(text)) out[key] = text;
      continue;
    }
    if (key === "pid" || key === "start") {
      const n = boundedCount(value);
      if (n !== null) out[key] = n;
      continue;
    }
    if (key === "driftedSlices") {
      if (!Array.isArray(value)) continue;
      // YELLOW: journal keeps the 4-name lock. compact-register / envelope ids are dropped, not migrated.
      out.driftedSlices = value.filter((item) => typeof item === "string" && (CONTRACT_SLICE_NAMES as readonly string[]).includes(item));
      continue;
    }
    if (typeof value === "string" && !FORBIDDEN.test(value) && value.length <= TURN_SEAM_BOUNDED_STRING && !/[\n\r]/.test(value)) {
      out[key] = value;
    }
  }
  return out;
}

export function projectModelStepTerminal(input: unknown): ModelStepTerminalEvent | ModeldStepOutcomeEvent | null {
  if (isRecord(input) && input.schemaVersion === 3) return projectModeldStepOutcome(input);
  if (!isRecord(input) || input.name !== "model_step_terminal" || input.schemaVersion !== 2) return null;
  const at = boundedString(input.at, TURN_SEAM_BOUNDED_STRING);
  const mode = boundedEnum(input.mode, TURN_SEAM_MODES);
  const hostGenerationId = boundedString(input.hostGenerationId);
  const agentId = boundedString(input.agentId);
  const turnId = boundedString(input.turnId);
  const invocationId = boundedString(input.invocationId);
  const modelId = boundedString(input.modelId);
  const assignment = boundedEnum(input.assignment, TURN_SEAM_ASSIGNMENTS) as TurnSeamAssignment | null;
  const terminalClass = boundedEnum(input.terminalClass, TURN_SEAM_TERMINAL_CLASSES) as TurnSeamTerminalClass | null;
  const outcome = boundedEnum(input.outcome, TURN_SEAM_OUTCOMES) as TurnSeamOutcome | null;
  const toolCallCount = boundedCount(input.toolCallCount);
  const stage = boundedEnum(input.stage, MODEL_STEP_STAGES) as ModelStepStage | null;
  const admission = boundedEnum(input.admission, MODEL_STEP_ADMISSIONS) as ModelStepAdmission | null;
  if (
    at == null || mode !== "route" || hostGenerationId == null || agentId == null || turnId == null ||
    invocationId == null || modelId == null || assignment == null || assignment === "official" ||
    terminalClass == null || outcome == null || toolCallCount == null || stage == null || admission == null
  ) {
    return null;
  }
  const errorCode = boundedEnum(input.errorCode, TURN_SEAM_ERROR_CODES);
  const serverGeneration = boundedString(input.serverGeneration);
  return {
    name: "model_step_terminal",
    schemaVersion: 2,
    at,
    mode: "route",
    hostGenerationId,
    agentId,
    turnId,
    invocationId,
    modelId,
    assignment,
    terminalClass,
    outcome,
    toolCallCount,
    stage,
    admission,
    ...(errorCode != null ? { errorCode } : {}),
    ...(serverGeneration != null ? { serverGeneration } : {}),
  };
}

const PROVIDER_ERROR_APIS = new Set(["chat", "responses"]);
const PROVIDER_ERROR_REASONS = new Set(["provider_code", "status_message"]);
const PROVIDER_ERROR_CODES = new Set(["context_length_exceeded", "context_window_exceeded", "prompt_too_long", "request_too_large", "unknown"]);
const PROVIDER_ERROR_TYPES = new Set(["unknown"]);

export function projectProviderErrorObserved(input: unknown): ProviderErrorObservedEvent | null {
  if (!isRecord(input) || input.name !== "provider_error_observed" || input.schemaVersion !== 1) return null;
  const at = boundedString(input.at, TURN_SEAM_BOUNDED_STRING);
  if (at == null || typeof input.overflowCandidate !== "boolean") return null;
  if (!Array.isArray(input.overflowReasons) || input.overflowReasons.length > 4) return null;
  const overflowReasons: string[] = [];
  for (const reason of input.overflowReasons) {
    const tag = boundedEnum(reason, PROVIDER_ERROR_REASONS);
    if (tag == null) return null;
    overflowReasons.push(tag);
  }
  if (input.overflowCandidate && overflowReasons.length === 0) return null;
  if (!input.overflowCandidate && overflowReasons.length > 0) return null;
  const api = boundedEnum(input.api, PROVIDER_ERROR_APIS) as "chat" | "responses" | null;
  const status = typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
    ? input.status : undefined;
  const providerCode = input.providerCode === undefined ? undefined : boundedEnum(input.providerCode, PROVIDER_ERROR_CODES) as ProviderErrorObservedEvent["providerCode"] | null;
  const providerType = input.providerType === undefined ? undefined : boundedEnum(input.providerType, PROVIDER_ERROR_TYPES) as "unknown" | null;
  if (input.providerCode !== undefined && providerCode == null) return null;
  if (input.providerType !== undefined && providerType == null) return null;
  const promptMessages = input.promptMessages === undefined ? undefined : boundedCount(input.promptMessages);
  const promptChars = input.promptChars === undefined ? undefined : boundedCount(input.promptChars);
  if (input.promptMessages !== undefined && promptMessages == null) return null;
  if (input.promptChars !== undefined && promptChars == null) return null;
  return {
    name: "provider_error_observed",
    schemaVersion: 1,
    at,
    overflowCandidate: input.overflowCandidate,
    overflowReasons,
    ...(api != null ? { api } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(providerCode != null ? { providerCode } : {}),
    ...(providerType != null ? { providerType } : {}),
    ...(typeof promptMessages === "number" ? { promptMessages } : {}),
    ...(typeof promptChars === "number" ? { promptChars } : {}),
  };
}

function isSeamEventName(name: unknown): boolean {
  return typeof name === "string" && SEAM_EVENT_NAMES.has(name);
}

export const INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const INCIDENT_RETENTION_BYTES = 4 * 1024 * 1024;
export const INCIDENT_RETENTION_GROUPS = 128;
/** Retain recent activity plus complete bounded failed-TURN evidence groups.
 * Never LRU-evict execution ledger entries: this is observation only. */
export function selectRetainedEventLines(lines: string[], now = Date.now()): string[] {
  const parsed = lines.filter(line => line.length > 0).map(line => {
    let value: Record<string, unknown> | undefined;
    try { const v = JSON.parse(line); if (isRecord(v)) value = v; } catch { /* keep recent malformed evidence */ }
    const turn = isSeamEventName(value?.name);
    const key = value && typeof value.agentId === "string" && typeof value.turnId === "string"
      ? JSON.stringify([value.agentId, value.turnId]) : undefined;
    const at = typeof value?.at === "string" ? Date.parse(value.at) : NaN;
    const failure = value?.name === "host_stream_rejected" ||
      (value?.name === "model_step_terminal" && ["error", "cancelled", "unknown"].includes(String(value.outcome))) ||
      (value?.name === "host_normalized_terminal" && ["error", "abort"].includes(String(value.terminalClass)));
    return { line, value, turn, key, at, failure };
  });
  const keep = new Set([...parsed.filter(row => !row.turn).slice(-CONTROL_PLANE_EVENT_RETENTION),
    ...parsed.filter(row => row.turn).slice(-TURN_SEAM_TERMINAL_RETENTION)]);
  const groups = new Map<string, typeof parsed>();
  for (const row of parsed) if (row.key) { const group = groups.get(row.key) ?? []; group.push(row); groups.set(row.key, group); }
  const incidents = [...groups.values()].filter(rows => rows.some(row => row.failure && Number.isFinite(row.at) && row.at <= now && now - row.at <= INCIDENT_RETENTION_MS));
  incidents.sort((a, b) => Math.max(...b.filter(r => r.failure).map(r => r.at)) - Math.max(...a.filter(r => r.failure).map(r => r.at)));
  let used = 0, count = 0;
  for (const rows of incidents) {
    if (count >= INCIDENT_RETENTION_GROUPS) break;
    const size = rows.reduce((sum, row) => sum + Buffer.byteLength(row.line) + 1, 0);
    // Keep a group whole or disclose its absence via bounded-window evidence;
    // never leave just its success while deleting its known failure.
    if (used + size > INCIDENT_RETENTION_BYTES) continue;
    for (const row of rows) keep.add(row);
    used += size; count++;
  }
  return parsed.filter(row => keep.has(row)).map(row => row.line);
}

export async function appendEvent(root: string, event: RuntimeEvent): Promise<void> {
  if (!journalRoleAllows("control", event.name)) return;
  const sanitized = sanitizeEvent(event);
  if (!sanitized) return;
  await appendNdjsonLine(root, JSON.stringify(sanitized));
}

export async function appendModelStepTerminal(root: string, input: unknown): Promise<TurnSeamWriteResult> {
  if (!isRecord(input) || !journalRoleAllows("modeld", String(input.name))) return "unprojected";
  const projected = projectModelStepTerminal(input);
  if (!projected) return "unprojected";
  try {
    await appendNdjsonLine(root, JSON.stringify(projected));
    return "written";
  } catch {
    return "write_failed";
  }
}

export async function appendProviderErrorObserved(root: string, input: unknown): Promise<TurnSeamWriteResult> {
  if (!isRecord(input) || !journalRoleAllows("modeld", String(input.name))) return "unprojected";
  const projected = projectProviderErrorObserved(input);
  if (!projected) return "unprojected";
  try {
    await appendNdjsonLine(root, JSON.stringify(projected));
    return "written";
  } catch {
    return "write_failed";
  }
}

export async function appendSeamRouteEvent(root: string, input: unknown): Promise<TurnSeamWriteResult> {
  if (!isRecord(input)) return "unprojected";
  if (input.name === "model_step_terminal") return appendModelStepTerminal(root, input);
  if (input.name === "host_stream_rejected") return appendHostStreamRejected(root, input);
  if (input.name === "provider_error_observed") return appendProviderErrorObserved(root, input);
  if (input.name === "turn_seam_terminal") return appendTurnSeamTerminal(root, input);
  return "unprojected";
}

export function projectControlEvent(input: unknown): RuntimeEvent | TurnSeamTerminalEvent | ModelStepTerminalEvent | HostStreamRejectedEvent | ProviderErrorObservedEvent | null {
  if (!isRecord(input) || !(EVENT_NAMES as readonly unknown[]).includes(input.name)) return null;
  if (input.name === "turn_seam_terminal") return projectTurnSeamTerminal(input) as TurnSeamTerminalEvent | null;
  if (input.name === "host_alert_observation") return projectAlertEvent(input) as unknown as RuntimeEvent | null;
  if (input.name === "model_recovery_progress") return projectModelRecoveryProgress(input) as RuntimeEvent | null;
  if (input.name === "host_run_observation") return projectRunObservation(input) as RuntimeEvent | null;
  if (input.name === "host_normalized_terminal") return projectHostNormalizedTerminal(input) as RuntimeEvent | null;
  if (input.name === "host_seam_stage") return projectHostSeamStage(input) as RuntimeEvent | null;
  if (input.name === "model_step_terminal") return projectModelStepTerminal(input);
  if (input.name === "host_stream_rejected") return projectHostStreamRejected(input);
  if (input.name === "provider_error_observed") return projectProviderErrorObserved(input);
  const at = boundedTimestamp(input.at);
  if (!at) return null;
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

export type RuntimeEventSelector = { agentId?: string; nonce?: string; stepId?: string; groupId?: string; trayId?: string; sourceInstanceId?: string };
export type RetentionObservation = { applied: boolean; discardedRecordsLowerBound: number; discardedPrefix: boolean; latestDiscardedAt: string | null };
function retentionMarker(value: unknown): RetentionObservation | undefined {
  if (!isRecord(value) || value.name !== "journal_retention" || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.discardedRecordsLowerBound) || Number(value.discardedRecordsLowerBound) < 0
    || typeof value.discardedPrefix !== "boolean") return undefined;
  const at = typeof value.latestDiscardedAt === "string" && Number.isFinite(Date.parse(value.latestDiscardedAt)) ? value.latestDiscardedAt : null;
  return { applied: true, discardedRecordsLowerBound: Number(value.discardedRecordsLowerBound), discardedPrefix: value.discardedPrefix, latestDiscardedAt: at };
}
export type EventsObservation = {
  state: ObservationState | "partial";
  events: Array<RuntimeEvent | TurnSeamTerminalEvent | ModelStepTerminalEvent | ModeldStepOutcomeEvent | HostStreamRejectedEvent | { invalid: true }>;
  truncated: boolean;
  window?: JournalWindow & { matchedEvents: number; returnedEvents: number; earliestAt: string | null; latestAt: string | null; selectorMatched?: boolean; retention?: RetentionObservation };
};
function selectRelatedEvents(events: EventsObservation["events"], selector: RuntimeEventSelector): EventsObservation["events"] {
  if (selector.trayId) {
    const traced=traceAlerts(events,selector);
    const selected=traced.traces.flatMap(t=>t.events), ids=new Set(selected.map(e=>e.eventId));
    const failures=new Set(selected.map(e=>e.failureId).filter(observationId));
    return events.filter(e=>!("invalid" in e) && (("eventId" in e && ids.has(String(e.eventId)))
      || ("failureId" in e && failures.has(String(e.failureId)) && selected.some(a=>a.agentId===e.agentId&&a.hostGenerationId===e.hostGenerationId))));
  }
  // Group events belong to distinct member identities. Filter their explicit
  // group association before the global event-count cap, never by proximity.
  if (typeof selector.groupId === "string") return events.filter(v => !("invalid" in v) && "groupId" in v && v.groupId === selector.groupId);
  const rows = events.filter((v): v is Exclude<typeof v, { invalid: true }> => !("invalid" in v) && v.agentId === selector.agentId);
  const seeds = rows.filter(v => selector.nonce !== undefined ? "clientNonce" in v && v.clientNonce === selector.nonce : selector.stepId !== undefined && "stepId" in v && v.stepId === selector.stepId);
  const turns = new Set(seeds.map(v => "turnId" in v ? v.turnId : undefined).filter(v => typeof v === "string" && v.length > 0));
  // Keep conflicting generations too: the outcome projector, not this reader,
  // must diagnose an ambiguous join rather than silently select one generation.
  const execution = rows.filter(v => seeds.includes(v) || ("turnId" in v && typeof v.turnId === "string" && turns.has(v.turnId)));
  const presentation = traceAlerts(events, { agentId: selector.agentId, ...(selector.stepId ? { stepId: selector.stepId } : {}),
    ...(selector.nonce ? { clientNonce: selector.nonce } : {}) }).traces.flatMap(trace => trace.events);
  const alertIds = new Set(presentation.map(event => `${event.sourceInstanceId}:${event.eventId}`));
  const observerGenerations = new Set(execution.flatMap(event => "hostGenerationId" in event && typeof event.hostGenerationId === "string" ? [event.hostGenerationId] : []));
  const links = new Set(presentation.filter(event => event.stepEvidence === "direct" && event.stepId && event.agentId)
    .map(event => JSON.stringify([event.hostGenerationId, event.agentId, event.stepId])));
  return events.filter(event => !("invalid" in event) && (execution.includes(event)
    || (event.name === "host_alert_observation" && "kind" in event && (event.kind === "observer_started" || event.kind === "manager_attached") && observerGenerations.has(String(event.hostGenerationId)))
    || ("eventId" in event && "sourceInstanceId" in event && alertIds.has(`${event.sourceInstanceId}:${event.eventId}`))
    || ("stepId" in event && links.has(JSON.stringify([event.hostGenerationId, event.agentId, event.stepId])))));
}

/** Real bounded suffix reads. Targeted queries filter before applying the event
 * count budget, so another busy Bot cannot evict this STEP from the read view. */
export async function observeEvents(root: string, limit = CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION, selector?: RuntimeEventSelector): Promise<EventsObservation> {
  if (!Number.isSafeInteger(limit) || limit < 0) return { state: "invalid", events: [], truncated: false };
  const read = await readJournalWindow(eventsPath(root));
  if (read.state !== "present" && read.state !== "partial") return { state: read.state, events: [], truncated: false, window: { ...read.window, matchedEvents: 0, returnedEvents: 0, earliestAt: null, latestAt: null } };
  let malformed = 0;
  let retention: RetentionObservation | undefined;
  const all: EventsObservation["events"] = [];
  for (const line of read.lines) {
    try {
      const value = JSON.parse(line), marker = retentionMarker(value);
      if (marker) { retention = marker; continue; }
      const projected = projectControlEvent(value);
      if (projected) { all.push(projected); continue; }
    } catch { /* bounded bad line */ }
    malformed++; all.push({ invalid: true });
  }
  const matched = selector ? selectRelatedEvents(all, selector) : all;
  const bounded = Math.min(limit, selector ? 4096 : CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION);
  const events = bounded === 0 ? [] : matched.slice(-bounded);
  const times = events.flatMap(v => "at" in v && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) ? [v.at] : []).sort();
  const retentionMayIntersect = retention !== undefined && (!selector || times.length === 0 || retention.latestDiscardedAt === null
    || Date.parse(times[0]!) <= Date.parse(retention.latestDiscardedAt));
  const truncated = read.window.prefixOmitted || read.window.linesOmitted || matched.length > bounded || retentionMayIntersect;
  return { state: read.state === "partial" || malformed > 0 ? "partial" : "present", events, truncated,
    window: { ...read.window, malformedLines: read.window.malformedLines + malformed, matchedEvents: matched.length, returnedEvents: events.length,
      earliestAt: times[0] ?? null, latestAt: times.at(-1) ?? null, ...(retention ? { retention } : {}), ...(selector ? { selectorMatched: matched.length > 0 } : {}) } };
}

/** Explicit source selection: current Host events are not durable controller history. */
export async function observeRuntimeEvents(input: {
  durableRoot: string; runRoot?: string; source: "control" | "host"; limit?: number; selector?: RuntimeEventSelector;
}): Promise<EventsObservation & { source: "control" | "host"; root: string }> {
  const root = input.source === "host" ? ephemeralRuntimeRoot(input.runRoot) : input.durableRoot;
  return { ...await observeEvents(root, input.limit ?? (input.selector ? 4096 : undefined), input.selector), source: input.source, root };
}

/** Watchdog-only maintenance entry. Readers/Host/modeld do not call it. */
export async function maintainObservationJournals(input: { durableRoot: string; runRoot?: string }): Promise<{ roots: Array<{ source: "control" | "host"; root: string; outcome: "maintained" | "unavailable" | "not_configured" }>; installedScheduler: false }> {
  const hostRoot = ephemeralRuntimeRoot(input.runRoot);
  const roots: Array<{ source: "control" | "host"; root: string; outcome: "maintained" | "unavailable" | "not_configured" }> = [];
  for (const [source, root] of [["control", input.durableRoot], ["host", hostRoot]] as const) {
    if (roots.some(r => r.root === root)) continue;
    // Never compact an implicit HOME fallback on behalf of an isolated/custom
    // durable root. Mutating host-journal maintenance requires the explicit root.
    if (source === "host" && !input.runRoot) { roots.push({ source, root, outcome: "not_configured" }); continue; }
    try { await compactEvents(root); roots.push({ source, root, outcome: "maintained" }); }
    catch { roots.push({ source, root, outcome: "unavailable" }); }
  }
  return { roots, installedScheduler: false };
}

export async function compactEvents(root: string): Promise<void> {
  const path = eventsPath(root);
  await withEventsLock(root, async () => {
    const read = await readJournalWindow(path);
    if (read.state === "missing") return;
    if (read.state !== "present" && read.state !== "partial") throw new Error("journal_unavailable");
    if (read.window.changedDuringRead) throw new Error("journal_changed");
    // Preserve the previous watermark in the same atomic file replacement.
    let previous: RetentionObservation | undefined;
    const lines = read.lines.filter(line => { try { const marker = retentionMarker(JSON.parse(line)); if (marker) { previous = marker; return false; } } catch { /* keep bounded malformed evidence */ } return true; });
    const kept = selectRetainedEventLines(lines);
    const keep = new Set(kept);
    const dropped = lines.filter(line => !keep.has(line));
    const timestamps = dropped.flatMap(line => { try { const v = JSON.parse(line); return typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) ? [v.at as string] : []; } catch { return []; } });
    if (previous?.latestDiscardedAt) timestamps.push(previous.latestDiscardedAt);
    const lostPrefix = read.window.prefixOmitted || read.window.linesOmitted || read.window.trailingPartial || read.window.oversizedLines > 0 || read.window.malformedLines > 0;
    if (dropped.length || previous || lostPrefix) {
      const latestDiscardedAt = lostPrefix ? new Date().toISOString() : timestamps.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
      kept.unshift(JSON.stringify({ name: "journal_retention", schemaVersion: 1,
        discardedRecordsLowerBound: Math.min(Number.MAX_SAFE_INTEGER, (previous?.discardedRecordsLowerBound ?? 0) + dropped.length),
        discardedPrefix: previous?.discardedPrefix === true || lostPrefix, latestDiscardedAt,
      }));
    }
    const body = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
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

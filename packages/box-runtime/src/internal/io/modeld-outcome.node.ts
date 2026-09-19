import { Effect } from "effect";
import { projectExecutionCapacity, projectStreamSummary, projectFailureSummary, projectProviderRecoveryState, projectModelRecoveryProgress, projectAuthorityProgress, projectModelAuthorityProgress, type AuthorityProgress, type ProviderRecoveryState, type ContextSnapshot, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { projectBackendObservation } from "../backends/failure-observation.ts";
import { STEP_FAILURE_CODES, STEP_OUTCOMES, STEP_PHASES, type ModeldStepOutcome } from "../modeld/step-outcome.ts";
import { appendNdjsonLine } from "../host/terminal-journal.node.ts";
import { noteUnprojectedJournalEvent } from "../host/journal-health.node.ts";
import { nextObservationIdentity, projectObservationIdentity } from "../host/observation-identity.node.ts";
import { projectRuntimeBuildInfo, runtimeBuildInfo, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function member(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export type ModeldStepOutcomeEvent = { name: "model_step_terminal"; schemaVersion: 3; at: string; [key: string]: unknown };

const SNAPSHOT_BYTES_MAX = 8 * 1024 * 1024;
const MESSAGE_COUNT_MAX = 4_096;

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      chars += (part as { text: string }).text.length;
    }
  }
  return chars;
}

function messagesChars(messages: unknown): { count: number; chars: number } {
  if (!Array.isArray(messages)) return { count: 0, chars: 0 };
  let chars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    chars += contentChars((message as { content?: unknown }).content);
  }
  return { count: messages.length, chars };
}

/** Wire snapshot size only — never the prompt body. */
export function snapshotWireMeasures(snapshot: ContextSnapshot): {
  snapshotBytes: number;
  messageChars: number;
  messageCount: number;
  requestToolCount: number;
  requestMaxOutputTokens?: number;
  historyToolCallCount: number;
  historyToolResultCount: number;
  toolChoicePolicy: "unspecified" | "auto" | "none" | "required" | "named";
} {
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  const system = messagesChars(snapshot.systemMessages);
  const rest = messagesChars(snapshot.messages);
  let historyToolCallCount = 0;
  let historyToolResultCount = 0;
  for (const message of snapshot.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") historyToolCallCount++;
      if (part.type === "tool-result") historyToolResultCount++;
    }
  }
  return {
    snapshotBytes,
    messageChars: system.chars + rest.chars,
    messageCount: system.count + rest.count,
    requestToolCount: snapshot.tools.length,
    ...(snapshot.options.maxTokens !== undefined ? { requestMaxOutputTokens: snapshot.options.maxTokens } : {}),
    historyToolCallCount,
    historyToolResultCount,
    toolChoicePolicy: typeof snapshot.options.toolChoice === "object" ? "named" : snapshot.options.toolChoice ?? "unspecified",
  };
}

function boundedInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

/** modeld observation only: never claims Host delivery; no free-form error/body/Cause fields. */
export function projectModeldStepOutcome(value: unknown): ModeldStepOutcomeEvent | null {
  const v = record(value);
  if (!v || v.name !== "model_step_terminal" || v.schemaVersion !== 3 || typeof v.at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at) || !Number.isFinite(Date.parse(v.at)) ||
      ![v.hostGenerationId, v.agentId, v.turnId, v.stepId, v.serviceEpoch].every(id) ||
      !member(v.outcome, STEP_OUTCOMES) || !member(v.phase, STEP_PHASES) ||
      typeof v.eventCount !== "number" || !Number.isSafeInteger(v.eventCount) || v.eventCount < 0 || v.eventCount > 1_073_741_824) return null;
  const out: ModeldStepOutcomeEvent = {
    name: "model_step_terminal", schemaVersion: 3, at: v.at,
    hostGenerationId: v.hostGenerationId, agentId: v.agentId, turnId: v.turnId, stepId: v.stepId,
    serviceEpoch: v.serviceEpoch, outcome: v.outcome, phase: v.phase, eventCount: v.eventCount,
  };
  if (id(v.bindingId)) out.bindingId = v.bindingId;
  if (id(v.modelId)) out.modelId = v.modelId;
  for (const key of ["snapshotDigest", "selectionRevision"] as const) if (typeof v[key] === "string" && /^[a-f0-9]{64}$/.test(v[key])) out[key] = v[key];
  if (typeof v.recordedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.recordedAt) && Number.isFinite(Date.parse(v.recordedAt))) out.recordedAt = v.recordedAt;
  const durationMs = boundedInt(v.durationMs, 24 * 60 * 60_000);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const attempts = boundedInt(v.backendAttempts, 65_536);
  if (attempts !== undefined) out.backendAttempts = attempts;
  const failureSummary = projectFailureSummary(v.failureSummary);
  if (failureSummary) out.failureSummary = failureSummary;
  const authority = projectAuthorityProgress(v.authority);
  if (authority) out.authority = authority;
  const authorityGaps = boundedInt(v.authorityObservationGaps, 256);
  if (authorityGaps !== undefined) out.authorityObservationGaps = authorityGaps;
  const recovery = projectProviderRecoveryState(v.recovery);
  // Failed summaries already carry the same attempt history. Do not duplicate
  // it and exceed the journal's per-line window for a large configured budget.
  if (recovery && !failureSummary?.recovery) out.recovery = recovery;
  const stream = projectStreamSummary(v.stream);
  if (stream) out.stream = stream;
  const usage = record(v.usage);
  const promptTokens = boundedInt(usage?.promptTokens, Number.MAX_SAFE_INTEGER);
  const completionTokens = boundedInt(usage?.completionTokens, Number.MAX_SAFE_INTEGER);
  if (promptTokens !== undefined && completionTokens !== undefined) {
    const projected: Record<string, number> = { promptTokens, completionTokens };
    for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      const n = boundedInt(usage?.[key], key === "reasoningTokens" ? completionTokens : Number.MAX_SAFE_INTEGER);
      if (n !== undefined) projected[key] = n;
    }
    out.usage = projected;
  }
  const execution = projectExecutionCapacity(v.execution);
  if (execution) out.execution = execution;
  const cleanup = record(v.cleanup);
  if (cleanup) {
    const safe: Record<string, unknown> = {};
    for (const key of ["clientDisconnected", "cancellationRequested"] as const) if (typeof cleanup[key] === "boolean") safe[key] = cleanup[key];
    if (member(cleanup.exitFailure, ["defect", "interrupted", "unknown"])) safe.exitFailure = cleanup.exitFailure;
    if (Object.keys(safe).length) out.cleanup = safe;
  }
  const snapshotBytes = boundedInt(v.snapshotBytes, SNAPSHOT_BYTES_MAX);
  const messageChars = boundedInt(v.messageChars, SNAPSHOT_BYTES_MAX);
  const messageCount = boundedInt(v.messageCount, MESSAGE_COUNT_MAX);
  if (snapshotBytes !== undefined) out.snapshotBytes = snapshotBytes;
  if (messageChars !== undefined) out.messageChars = messageChars;
  if (messageCount !== undefined) out.messageCount = messageCount;
  for (const field of ["requestToolCount", "historyToolCallCount", "historyToolResultCount"] as const) {
    const n = boundedInt(v[field], 65_536);
    if (n !== undefined) out[field] = n;
  }
  if (member(v.toolChoicePolicy, ["unspecified", "auto", "none", "required", "named"])) out.toolChoicePolicy = v.toolChoicePolicy;
  const maxOutput = boundedInt(v.requestMaxOutputTokens, 8 * 1024 * 1024);
  if (maxOutput !== undefined && maxOutput > 0) out.requestMaxOutputTokens = maxOutput;
  if (member(v.failureCode, STEP_FAILURE_CODES)) out.failureCode = v.failureCode;
  const diagnostic = projectBackendObservation(v.diagnostic);
  if (diagnostic) out.diagnostic = diagnostic;
  for (const field of ["startedAt", "detectedAt"] as const) {
    const at = v[field];
    if (typeof at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) && Number.isFinite(Date.parse(at))) out[field] = at;
  }
  const build = projectRuntimeBuildInfo(v.build), observation = projectObservationIdentity(v.observation);
  if (build) out.build = build;
  if (boundedInt(v.wireVersion, 65535) && Number(v.wireVersion) > 0) out.wireVersion = v.wireVersion;
  if (observation) out.observation = observation;
  const runtime = record(v.runtime);
  if (runtime && (runtime.name === "node" || runtime.name === "bun") && typeof runtime.version === "string" && /^[0-9][A-Za-z0-9.+-]{0,63}$/.test(runtime.version)) {
    out.runtime = { name: runtime.name, version: runtime.version };
  }
  const transport = record(v.transport);
  if (transport?.side === "host_modeld_ipc" && member(transport.close, ["peer_end", "peer_close", "socket_error"])
    && typeof transport.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(transport.at) && Number.isFinite(Date.parse(transport.at))) {
    out.transport = { side: transport.side, close: transport.close, at: transport.at };
  }
  const followup = record(v.followup);
  if (followup && member(followup.phase, ["transport", "internal"]) && member(followup.code, ["disconnected", "defect", "interrupted", "unknown"])) {
    out.followup = { phase: followup.phase, code: followup.code };
  }
  if (Array.isArray(v.attempts)) {
    const retained = v.attempts.slice(0, 4).flatMap((raw) => {
      const attempt = record(raw), index = boundedInt(attempt?.index, 3);
      if (!attempt || index === undefined) return [];
      const summary = projectStreamSummary(attempt.stream), detail = projectBackendObservation(attempt.diagnostic);
      return [{ index, ...(member(attempt.failureCode, STEP_FAILURE_CODES) ? { failureCode: attempt.failureCode } : {}),
        ...(summary ? { stream: summary } : {}), ...(detail ? { diagnostic: detail } : {}) }];
    });
    out.attempts = retained;
    out.attemptsTruncated = v.attempts.length > retained.length || (attempts !== undefined && attempts > retained.length);
  }
  return out;
}

export function writeModeldAuthorityProgress(root: string,
  request: Pick<RunStepRequest, "agentId" | "turnId" | "stepId" | "hostEpoch" | "serviceEpoch">,
  authority: AuthorityProgress, observedAt = new Date().toISOString(), configurationRoot?: string) {
  return Effect.tryPromise(async () => {
    const projected = projectModelAuthorityProgress({ name: "model_authority_progress", schemaVersion: 1, at: observedAt,
      agentId: request.agentId, turnId: request.turnId, stepId: request.stepId,
      hostGenerationId: request.hostEpoch.compile, serviceEpoch: request.serviceEpoch.incarnationId, authority });
    if (!projected) { noteUnprojectedJournalEvent(root, "modeld"); return; }
    await appendNdjsonLine(root, JSON.stringify(projected), "modeld", configurationRoot === undefined ? undefined : { configurationRoot });
  }).pipe(Effect.asVoid);
}

export function writeModeldRecoveryProgress(root: string, request: RunStepRequest, recovery: ProviderRecoveryState, configurationRoot?: string) {
  return Effect.tryPromise(async () => {
    const projected = projectModelRecoveryProgress({ name: "model_recovery_progress", schemaVersion: 1, at: new Date().toISOString(),
      agentId: request.agentId, turnId: request.turnId, stepId: request.stepId,
      hostGenerationId: request.hostEpoch.compile, serviceEpoch: request.serviceEpoch.incarnationId, recovery });
    if (!projected) { noteUnprojectedJournalEvent(root, "modeld"); return; }
    await appendNdjsonLine(root, JSON.stringify(projected), "modeld", configurationRoot === undefined ? undefined : { configurationRoot });
  }).pipe(Effect.asVoid);
}

export function writeModeldStepOutcome(root: string, request: RunStepRequest, outcome: ModeldStepOutcome, configurationRoot?: string) {
  return Effect.tryPromise(async () => {
    let measures: ReturnType<typeof snapshotWireMeasures> | undefined;
    try {
      measures = snapshotWireMeasures(request.snapshot);
    } catch {
      measures = undefined;
    }
    const recordedAt = new Date().toISOString();
    const at = outcome.at ?? recordedAt;
    const projected = projectModeldStepOutcome({
      ...outcome, ...(measures ?? {}),
      name: "model_step_terminal", schemaVersion: 3, at, recordedAt,
      modelId: request.selection.modelId, snapshotDigest: request.snapshot.snapshotDigest,
      selectionRevision: request.selection.selectionRevision,
      hostGenerationId: request.hostEpoch.compile, agentId: request.agentId,
      turnId: request.turnId, stepId: request.stepId, serviceEpoch: request.serviceEpoch.incarnationId,
      build: runtimeBuildInfo(), wireVersion: WIRE_VERSION, observation: nextObservationIdentity("modeld"),
      runtime: { name: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.versions.node },
    });
    if (!projected) { noteUnprojectedJournalEvent(root, "modeld"); return; }
    await appendNdjsonLine(root, JSON.stringify(projected), "modeld", configurationRoot === undefined ? undefined : { configurationRoot });
  }).pipe(Effect.asVoid);
}

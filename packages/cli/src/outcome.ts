import { catalogAgentMessage, projectJournalEvent, type EventsObservation, type JournalHealthObservation } from "@grokbox/box-runtime/runtime";
import { classifyAlert, diagnoseExecution, selectExecutionFailure, specializeExecutionFailure as specializeRuntimeFailure, traceAlerts } from "@grokbox/runtime-kernel/alerts";
import { isRecord } from "./util.ts";
import { projectStreamDiagnostic, projectProviderRecoveryState, failureSummaryFromObservation } from "@grokbox/runtime-kernel/contract";
import type { TranscriptRouteObservation } from "./transcript-route.ts";

/** CLI `history outcome` states. `accepted` is not a member: echo/bind is `recorded`. */
export const SEND_OUTCOME_STATES = [
  "unknown",
  "recorded",
  "failed",
  "progress",
  "delivered",
  "expected_result_observed",
] as const;
export type SendOutcomeState = (typeof SEND_OUTCOME_STATES)[number];
export const SETTLED_SEND_OUTCOME_STATES: ReadonlySet<SendOutcomeState> = new Set([
  "failed",
  "delivered",
  "expected_result_observed",
]);

/** App trays are current Host memory, not a durable run ledger. Never return raw
 * provider details/actions (which can contain credentials or executable URLs). */
export type AlertObservation = {
  id: string; agentId: string | null; requestId: string | null; stepId: string | null;
  kind: "error"; titleKind: string | null; errorKind: string | null;
  createdAt: number | null; count: number; managedCode: string | null; hasDetail: boolean;
  classificationEvidence?: "direct" | "legacy_text_derived" | "unclassified";
  stepEvidence?: "direct" | "legacy_text_derived";
};
const id = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x20]/.test(v) ? v : null;
const enumLabel = (v: unknown): string | null => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(v) ? v : null;
const number = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function projectAlert(value: unknown): AlertObservation | null {
  if (!isRecord(value) || value.kind !== "error" || !id(value.id)) return null;
  const details = [value.detail, value.rawDetail].filter((v): v is string => typeof v === "string").map(v => v.slice(0, 16384)).join("\n");
  // This is a display classification only, not recovery authority or provider evidence.
  const classified = classifyAlert(value);
  const managedCode = classified.code ?? null;
  const stepId = classified.stepId ?? null;
  return {
    id: id(value.id)!, agentId: id(value.agentId), requestId: id(value.requestId), stepId,
    kind: "error", titleKind: enumLabel(value.titleKind), errorKind: enumLabel(value.errorKind),
    createdAt: number(value.createdAt), count: number(value.count) ?? 1,
    managedCode, hasDetail: value.hasDetail === true || details.length > 0,
    classificationEvidence: classified.evidence, ...(classified.stepEvidence ? { stepEvidence: classified.stepEvidence } : {}),
  };
}

export type OutcomeInput = {
  agentId: string; nonce?: string; requestId?: string; stepId?: string;
  entries: unknown[]; alerts: AlertObservation[]; truncated: boolean;
  gatewayChanged?: boolean; expectedText?: string; alertsIncomplete?: boolean;
  runtimeEvents?: unknown[]; runtimeGap?: string;
  runtimeEvidence?: { root?: string; coverage?: EventsObservation["coverage"]; lookup?: EventsObservation["lookup"]; retention?: EventsObservation["retention"]; readFailure?: string; health?: JournalHealthObservation };
  transcriptRoute?: TranscriptRouteObservation;
};

/** Current box transcript ID contract (native transcript-entry-ids, 2026-09-12).
 * Only qualify a complete, zero-based, collision-free user sequence. This is a
 * display-turn association, not inference identity or permission to replay work.
 * Imported, truncated, unknown, temporal or sparse histories remain unqualified.
 */
function boxHandoffDelivery(input: OutcomeInput, records: Record<string, unknown>[], requests: Record<string, unknown>[]) {
  const route = input.transcriptRoute;
  if (input.truncated || requests.length !== 1 || !route || route.initial !== "box" || route.before !== "box" || route.after !== "box") return [];
  const users = records.filter(r => r.kind === "message" && r.role === "user");
  if (!users.length || users.length > 1000) return [];
  const userIds = new Set(users.map(r => r.id));
  if (userIds.size !== users.length || users.some((_, i) => !userIds.has(`t${i}u`))) return [];
  const allIds = records.map(r => id(r.id));
  if (allIds.some(value => value === null) || new Set(allIds).size !== allIds.length) return [];
  const root = /^t(0|[1-9][0-9]*)u$/.exec(String(requests[0]!.id));
  if (!root) return [];
  const group = Number(root[1]);
  if (!Number.isSafeInteger(group) || group >= users.length) return [];
  return records.filter(r => {
    const send = /^t(0|[1-9][0-9]*)s(0|[1-9][0-9]*)$/.exec(String(r.id));
    return send?.[1] === root[1] && r.kind === "send-message" && r.wake === "handoff-resume"
      && r.author === undefined && id(r.requestId) !== null && r.isStreaming !== true && isRecord(r.message);
  });
}

function visibleFailureCode(value: unknown): string | null {
  if (value === "stream_invalid") return "invalid_stream";
  return typeof value === "string" ? value : null;
}

function sameStep(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ["agentId", "turnId", "stepId"].every(k => id(a[k]) !== null && a[k] === b[k])
    && ["hostGenerationId", "serviceEpoch"].every(k => a[k] === undefined || (id(a[k]) !== null && a[k] === b[k]));
}
function projectRuntimeFailure(failure: Record<string, unknown>, runtime: Record<string, unknown>[] = []) {
  const reason = typeof failure.reason === "string" ? failure.reason : undefined;
  const message = reason ? catalogAgentMessage(reason) : undefined;
  const stage = typeof failure.stage === "string" ? failure.stage : typeof failure.phase === "string" ? failure.phase : undefined;
  const modeld = failure.name === "model_step_terminal" ? failure : runtime.find(e => e.name === "model_step_terminal" && sameStep(failure, e));
  const hostDetail = projectStreamDiagnostic(failure.diagnostic), backendDetail = projectStreamDiagnostic(modeld?.diagnostic);
  const diagnostic = hostDetail?.normalizeCause ? hostDetail : backendDetail ?? hostDetail;
  const purposeRow = runtime.find(e => sameStep(failure, e) && (e.purpose === "main" || e.purpose === "memory-extraction" || e.purpose === "episode" || e.auxPurpose === "memory-extraction" || e.auxPurpose === "episode"));
  const purpose = purposeRow?.purpose ?? purposeRow?.auxPurpose ?? "not_observed";
  const cleanup = isRecord(modeld?.cleanup) ? modeld.cleanup : undefined;
  const diagnosis = diagnoseExecution(runtime, { agentId: String(failure.agentId ?? ""), stepId: String(failure.stepId ?? ""),
    ...(typeof failure.hostGenerationId === "string" ? { hostGenerationId: failure.hostGenerationId } : {}) });
  return {
    source: failure.name, at: failure.at, stepId: failure.stepId ?? null, turnId: failure.turnId ?? null,
    code: visibleFailureCode(failure.errorCode ?? failure.failureCode),
    outcome: failure.terminalClass ?? failure.outcome ?? "error",
    stage: stage ?? null, message: message ?? null,
    ...(failure.reportedCode !== undefined || failure.reportedStage !== undefined ? { reported: { code: enumLabel(failure.reportedCode), stage: enumLabel(failure.reportedStage), meaning: "original_host_classification" } } : {}),
    ...(reason && message ? { reason } : {}),
    purpose,
    ...(diagnostic ? { diagnostic } : {}),
    ...("failureSummary" in diagnosis && diagnosis.failureSummary ? { failureSummary: diagnosis.failureSummary,
      category: diagnosis.category, presentation: diagnosis.presentation } : {}),
    ...(modeld ? { backend: { outcome: enumLabel(modeld.outcome), phase: enumLabel(modeld.phase), failureCode: enumLabel(modeld.failureCode),
      eventCount: number(modeld.eventCount), relation: "same_step_not_cross_process_causal_order" } } : {}),
    ...(cleanup ? { cleanup: { ...(typeof cleanup.clientDisconnected === "boolean" ? { clientDisconnected: cleanup.clientDisconnected } : {}),
      ...(typeof cleanup.cancellationRequested === "boolean" ? { cancellationRequested: cleanup.cancellationRequested } : {}) } } : {}),
    observations: runtime.filter(event => sameStep(failure, event) && (event.name === "host_stream_rejected" || event.name === "host_normalized_terminal" || event.name === "model_step_terminal"))
      .map(event => ({ source: event.name, code: visibleFailureCode(event.errorCode ?? event.failureCode) })),
  };
}

/** Pure, read-only reconciliation of one user send. Journal is failure authority;
 * trays are a live snapshot and may be empty. A send-message is delivery evidence,
 * not proof that the full tool loop/checkpoint/run has completed. `recorded` is
 * echo or journal bind only — not a successful reply. */
export function projectSendOutcome(input: OutcomeInput) {
  const records = input.entries.filter(isRecord);
  const agentEvents = (input.runtimeEvents ?? []).filter(isRecord).filter(e => e.agentId === input.agentId);
  const selectedSteps = input.stepId ? agentEvents.filter(e => e.stepId === input.stepId) : [];
  const selectedTurns = new Set(selectedSteps.map(e => id(e.turnId)).filter((v): v is string => v !== null));
  const selectedNonces = [...new Set(agentEvents.filter(e => typeof e.turnId === "string" && selectedTurns.has(e.turnId)).map(e => id(e.clientNonce)).filter((v): v is string => v !== null))];
  const lookupNonce = input.nonce ?? (selectedNonces.length === 1 ? selectedNonces[0] : undefined);
  const requests = records.filter(r => r.kind === "message" && r.role === "user" && (lookupNonce !== undefined
    ? r.clientNonce === lookupNonce : input.requestId !== undefined && r.requestId === input.requestId));
  const requestIds = [...new Set(requests.map(r => id(r.requestId)).filter((v): v is string => v !== null))];
  const echoNonces = [...new Set(requests.map(r => id(r.clientNonce)).filter((v): v is string => v !== null))];
  const ambiguous = requestIds.length > 1 || selectedNonces.length > 1;
  const requestId = input.requestId ?? (requestIds.length === 1 ? requestIds[0]! : null);
  const clientNonce = lookupNonce ?? (echoNonces.length === 1 ? echoNonces[0]! : null);
  const echoObserved = requests.length > 0;
  const handoffDeliveries = boxHandoffDelivery(input, records, requests);
  const seedIds = new Set<string>(requestId === null ? [] : [requestId]);
  if (input.stepId) seedIds.add(input.stepId);
  for (const delivery of handoffDeliveries) seedIds.add(delivery.requestId as string);
  const nonceHits = clientNonce === null ? [] : agentEvents.filter(e => e.clientNonce === clientNonce);
  const nonceTurnIds = new Set<string>();
  for (const event of nonceHits) {
    const step = id(event.stepId);
    if (step) seedIds.add(step);
    const turn = id(event.turnId);
    if (turn) nonceTurnIds.add(turn);
  }
  const journalBound = nonceHits.length > 0 || selectedSteps.length > 0;
  const exact = agentEvents.filter(e => (clientNonce !== null && e.clientNonce === clientNonce)
    || [e.stepId, e.turnId, e.invocationId].some(value => typeof value === "string" && seedIds.has(value))
    || (typeof e.turnId === "string" && nonceTurnIds.has(e.turnId)));
  // A transcript request may name only the first STEP. Expand through actual
  // runtime identity, never timestamps, proximity, or the latest Bot activity.
  const turnEpochs = new Map<string, Set<string>>();
  for (const event of exact) {
    const turn = id(event.turnId), epoch = id(event.serviceEpoch);
    if (turn && epoch) {
      const epochs = turnEpochs.get(turn) ?? new Set<string>();
      epochs.add(epoch); turnEpochs.set(turn, epochs);
    }
  }
  const hostGenerations = new Map<string, Set<string>>();
  for (const event of exact) {
    const turn = id(event.turnId), generation = id(event.hostGenerationId);
    if (turn && generation) { const set = hostGenerations.get(turn) ?? new Set<string>(); set.add(generation); hostGenerations.set(turn, set); }
  }
  const runtimeGenerationChanged = [...hostGenerations.values()].some(values => values.size > 1)
    || [...turnEpochs.values()].some(epochs => epochs.size !== 1)
    || agentEvents.some(e => typeof e.turnId === "string" && turnEpochs.has(e.turnId)
      && id(e.serviceEpoch) !== null && !turnEpochs.get(e.turnId)!.has(e.serviceEpoch as string));
  const runtime = agentEvents.filter(e => exact.includes(e) || (typeof e.turnId === "string" && typeof e.serviceEpoch === "string"
    && turnEpochs.get(e.turnId)?.has(e.serviceEpoch)));
  // Trays and SendToUser join on STEP/request ids only. Never put turnId here.
  const correlatedIds = new Set<string>(seedIds);
  for (const event of runtime) { const step = id(event.stepId); if (step) correlatedIds.add(step); }
  const alerts = input.alerts.filter(a => a.agentId === input.agentId
    && ((a.requestId !== null && correlatedIds.has(a.requestId)) || (a.requestId === null && a.stepId !== null && correlatedIds.has(a.stepId))));
  const delivered = records.filter(r => typeof r.requestId === "string" && correlatedIds.has(r.requestId)
    && r.kind === "send-message" && r.isStreaming !== true && isRecord(r.message));
  const delivery = delivered.map(r => ({
    entryId: id(r.id), timestampMs: number(r.timestampMs),
    // Content is the same requested transcript evidence available via history tail.
    type: typeof (r.message as Record<string, unknown>).type === "string" ? (r.message as Record<string, unknown>).type : "unknown",
    content: typeof (r.message as Record<string, unknown>).content === "string" ? (r.message as Record<string, unknown>).content : null,
  }));
  // Host rejection is the cause; a later modeld disconnect is often its consequence.
  const recentRuntime = [...runtime].reverse();
  const candidates = input.stepId ? recentRuntime.filter(e => e.stepId === input.stepId) : recentRuntime;
  const rawFailure = selectExecutionFailure([...candidates].reverse());
  const failure = rawFailure ? specializeRuntimeFailure(rawFailure, recentRuntime) : undefined;
  const recoveryState = (e: Record<string, unknown>) => projectProviderRecoveryState(e.recovery)
    ?? projectProviderRecoveryState(failureSummaryFromObservation(e)?.recovery);
  const recoveryRecord = candidates.find(e => e.name === "model_step_terminal" && recoveryState(e))
    ?? candidates.find(e => e.name === "model_recovery_progress" && recoveryState(e));
  const route = input.transcriptRoute;
  const harnessChanged = route !== undefined && (route.initial !== route.before || route.before !== route.after);
  const harnessUnavailable = route !== undefined && [route.initial, route.before, route.after].includes("unknown");
  const harnessMismatch = route?.expected !== undefined && (route.before !== route.expected || route.after !== route.expected);
  const routeInvalid = harnessChanged || harnessUnavailable || harnessMismatch;
  const invalid = input.gatewayChanged || ambiguous || runtimeGenerationChanged || routeInvalid;
  const evidenceGap = input.runtimeGap !== undefined || input.alertsIncomplete === true;
  const expectedMatched = input.expectedText !== undefined && delivery.some(d => d.content === input.expectedText);
  const pending = echoObserved || journalBound;
  const state: SendOutcomeState = invalid ? "unknown" : alerts.length > 0 || failure ? "failed"
    : evidenceGap ? "unknown" : input.expectedText !== undefined ? (expectedMatched ? "expected_result_observed" : delivery.length ? "progress" : pending ? "recorded" : "unknown")
    : delivery.length > 0 ? "delivered" : pending ? "recorded" : "unknown";
  const scopeOf = (step: unknown) => {
    const terminal = runtime.find(event => event.stepId === step && ["main", "memory-extraction", "episode"].includes(String(event.requestKind)));
    if (terminal) return String(terminal.requestKind);
    const start = runtime.find(event => event.name === "host_seam_stage" && event.stage === "stream_enter" && event.stepId === step);
    if (!start) return "unobserved";
    return start.auxPurpose === "memory-extraction" || start.auxPurpose === "episode" ? start.auxPurpose : "main";
  };
  const releasedByStep = new Map<string, number>();
  for (const event of runtime) {
    const step = id(event.stepId), count = number(event.toolCallCount);
    if (step && count !== null && event.name === "host_normalized_terminal") releasedByStep.set(step, count);
  }
  const trace = invalid ? [] : runtime.map(projectJournalEvent).filter((event): event is NonNullable<typeof event> => event !== null);
  const mainFailure = failure && scopeOf(failure.stepId) === "main";
  const runtimeIncomplete = evidenceGap;
  return {
    agentId: input.agentId, clientNonce, requestId,
    ...(input.stepId ? { selectedStepId: input.stepId } : {}),
    requestedStepId: input.stepId ?? null,
    state, echoObserved, delivery: invalid ? [] : delivery,
    alerts: invalid ? [] : alerts,
    executionCompleted: "not_proven" as const,
    relatedStepIds: invalid ? [] : [...correlatedIds],
    relatedTurnIds: invalid ? [] : [...new Set(runtime.map(event => id(event.turnId)).filter((turn): turn is string => turn !== null))],
    expectedMatched: !invalid && expectedMatched,
    runtimeFailure: !invalid && failure ? { ...projectRuntimeFailure(failure, recentRuntime), requestKind: scopeOf(failure.stepId) } : null,
    runtimeRecovery: !invalid && recoveryRecord ? { stepId: recoveryRecord.stepId, observedAt: recoveryRecord.at,
      state: recoveryState(recoveryRecord), currentLiveness: "not_proven", replayAuthorized: false } : null,
    presentation: invalid ? null : traceAlerts(input.runtimeEvents ?? [], { agentId: input.agentId,
      ...(input.stepId ? { stepId: input.stepId } : clientNonce ? { clientNonce } : {}) },
      { complete: !input.runtimeGap && input.runtimeEvents !== undefined, source: "runtime_journal" }),
    observations: {
      delivery: invalid ? "unknown" : delivery.length ? "observed" : "not_observed",
      execution: invalid ? "unknown" : failure ? "failure_observed" : alerts.length ? "host_reported_failure" : evidenceGap ? "unknown" : "not_proven",
      executionEvidenceOrigin: invalid ? "ambiguous" : failure ? "runtime_journal" : alerts.length ? "native_tray_report" : "not_observed",
      runtimeEvidence: input.runtimeEvents === undefined ? "not_checked" : input.runtimeGap ? "partial" : "available",
      toolCallsReleased: invalid || !runtime.some(e => e.name === "host_normalized_terminal" && number(e.toolCallCount) !== null) ? null
        : [...new Map(runtime.filter(e => e.name === "host_normalized_terminal" && id(e.stepId) && number(e.toolCallCount) !== null)
          .map(e => [JSON.stringify([e.hostId, e.agentId, e.turnId, e.stepId, e.serviceEpoch]), number(e.toolCallCount)!])).values()].reduce((n, count) => n + count, 0),
      toolReleaseCoverage: "observed_records_only",
      toolExecution: "not_observed", checkpoint: "not_observed", subsequentTurnLineage: "not_observed",
    },
    assessment: {
      delivery: invalid ? "unknown" : delivery.length > 0 ? "observed" : "not_observed",
      mainRun: invalid || runtimeIncomplete ? (mainFailure && !invalid ? "failure_observed" : "unknown") : mainFailure ? "failure_observed" : "completion_not_proven",
      auxiliary: failure && ["memory-extraction", "episode"].includes(scopeOf(failure.stepId)) && !invalid ? "failure_observed" : "not_proven",
      evidence: invalid ? "conflicting" : runtimeIncomplete ? "incomplete" : input.runtimeEvents ? "bounded_observation" : "runtime_not_checked",
      retry: "not_authorized_by_observation",
      hostToolMaterialsReleased: invalid || releasedByStep.size === 0 ? null : [...releasedByStep.values()].reduce((sum, count) => sum + count, 0),
      toolExecution: "not_instrumented", checkpointCommit: "not_instrumented", applicationReplica: "not_observed",
    },
    runtimeTrace: { events: trace.slice(-128), truncated: trace.length > 128, order: "append-order-not-causal-order" },
    turnTriggers: trace.filter(event => event.name === "host_seam_stage" && "stage" in event && event.stage === "hook_enter")
      .map(event => ({ turnId: "turnId" in event ? event.turnId : null,
        native: "nativeTurn" in event ? event.nativeTurn : null,
        meaning: "native-lineage-not-kernel-identity-or-retry-authority" })),
    evidence: { transcript: "Gateway.getAgentTranscriptTail", alerts: "Gateway.getTrays", alertsPersistence: "host-memory", transcriptWindowTruncated: input.truncated,
      runtime: input.runtimeEvents ? "box-local run/log/events.ndjson" : "not_checked", runtimeGap: input.runtimeGap ?? null,
      runtimeRoot: input.runtimeEvidence?.root ?? null,
      runtimeCoverage: input.runtimeEvidence?.coverage ?? null,
      runtimeLookup: input.runtimeEvidence?.lookup ?? null,
      runtimeRetention: input.runtimeEvidence?.retention ?? null,
      runtimeReadFailure: input.runtimeEvidence?.readFailure ?? null,
      journalHealth: input.runtimeEvidence?.health ?? null,
      handoffDelivery: handoffDeliveries.length ? { profile: "box-complete-display-turn-v1", rootEntryId: requests[0]!.id,
        entryIds: handoffDeliveries.map(r => r.id), meaning: "display-association-not-run-lineage" } : null,
      transcriptRoute: route ? {
        source: "Gateway.listAgents", initialHarness: route.initial, beforeHarness: route.before, afterHarness: route.after,
        expectedHarness: route.expected ?? null, consistent: !harnessChanged && !harnessUnavailable, usable: !routeInvalid,
        declaredTranscriptSource: harnessChanged || harnessUnavailable ? "unknown" : route.before === "box" ? "box" : "server",
        sampling: "bracketed-not-atomic", desktopReplica: "not_observed",
      } : null },
    gaps: [
      ...(input.gatewayChanged ? ["gateway_generation_changed"] : []),
      ...(handoffDeliveries.length ? ["native_handoff_can_span_runtime_turns"] : []),
      ...(harnessChanged ? ["harness_changed_during_observation"] : []),
      ...(harnessUnavailable ? ["harness_unavailable"] : []),
      ...(harnessMismatch ? ["unexpected_harness"] : []),
      ...(route ? ["desktop_replica_not_observed"] : []),
      ...(runtimeGenerationChanged ? ["runtime_generation_changed"] : []),
      ...(ambiguous ? ["nonce_has_multiple_requests"] : []),
      ...(input.alertsIncomplete ? ["unsupported_alert_schema"] : []),
      ...(input.runtimeGap ? ["runtime_evidence_incomplete"] : []),
      ...(input.runtimeEvents && trace.every(event => !("diagnostic" in event)) ? ["detailed_stream_diagnostics_not_observed"] : []),
      ...(!echoObserved && !input.requestId && !journalBound ? ["nonce_not_in_transcript_window"] : []),
      "dismissed_or_restarted_trays_not_recoverable_from_getTrays",
      "delivery_does_not_prove_run_completion",
    ],
  };
}

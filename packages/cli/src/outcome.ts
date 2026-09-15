import { catalogAgentMessage } from "@grokbox/box-runtime/runtime";
import { isRecord } from "./util.ts";
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
};
const id = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\x00-\x20]/.test(v) ? v : null;
const enumLabel = (v: unknown): string | null => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(v) ? v : null;
const number = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function projectAlert(value: unknown): AlertObservation | null {
  if (!isRecord(value) || value.kind !== "error" || !id(value.id)) return null;
  const details = [value.detail, value.rawDetail].filter((v): v is string => typeof v === "string").map(v => v.slice(0, 16384)).join("\n");
  // This is a display classification only, not recovery authority or provider evidence.
  const managedCode = value.managedCode === "parallel_tools" || details.includes("Parallel tool calls are not supported. Rejected calls were not executed.") ? "parallel_tools" : null;
  const stepId = id(value.stepId) ?? details.match(/\binvocationId=([A-Za-z0-9_-]{1,128})(?:[)\s]|$)/)?.[1] ?? null;
  return {
    id: id(value.id)!, agentId: id(value.agentId), requestId: id(value.requestId), stepId,
    kind: "error", titleKind: enumLabel(value.titleKind), errorKind: enumLabel(value.errorKind),
    createdAt: number(value.createdAt), count: number(value.count) ?? 1,
    managedCode, hasDetail: value.hasDetail === true || details.length > 0,
  };
}

export type OutcomeInput = {
  agentId: string; nonce?: string; requestId?: string;
  entries: unknown[]; alerts: AlertObservation[]; truncated: boolean;
  gatewayChanged?: boolean; expectedText?: string; alertsIncomplete?: boolean;
  runtimeEvents?: unknown[]; runtimeGap?: string;
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

function projectRuntimeFailure(failure: Record<string, unknown>) {
  const reason = typeof failure.reason === "string" ? failure.reason : undefined;
  const message = reason ? catalogAgentMessage(reason) : undefined;
  const stage = typeof failure.stage === "string" ? failure.stage : undefined;
  return {
    source: failure.name, at: failure.at, stepId: failure.stepId ?? null, turnId: failure.turnId ?? null,
    code: failure.errorCode ?? failure.failureCode ?? null,
    outcome: failure.terminalClass ?? failure.outcome ?? "error",
    ...(reason && message ? { reason, stage: stage ?? null, message } : {}),
  };
}

/** Pure, read-only reconciliation of one user send. Journal is failure authority;
 * trays are a live snapshot and may be empty. A send-message is delivery evidence,
 * not proof that the full tool loop/checkpoint/run has completed. `recorded` is
 * echo or journal bind only — not a successful reply. */
export function projectSendOutcome(input: OutcomeInput) {
  const records = input.entries.filter(isRecord);
  const requests = input.nonce
    ? records.filter(r => r.kind === "message" && r.role === "user" && r.clientNonce === input.nonce)
    : records.filter(r => r.kind === "message" && r.role === "user" && r.requestId === input.requestId);
  const requestIds = [...new Set(requests.map(r => id(r.requestId)).filter((v): v is string => v !== null))];
  const echoNonces = [...new Set(requests.map(r => id(r.clientNonce)).filter((v): v is string => v !== null))];
  const ambiguous = requestIds.length > 1;
  const requestId = input.requestId ?? (requestIds.length === 1 ? requestIds[0]! : null);
  const clientNonce = input.nonce ?? (echoNonces.length === 1 ? echoNonces[0]! : null);
  const echoObserved = requests.length > 0;
  const handoffDeliveries = boxHandoffDelivery(input, records, requests);
  const seedIds = new Set<string>(requestId === null ? [] : [requestId]);
  for (const delivery of handoffDeliveries) seedIds.add(delivery.requestId as string);
  const agentEvents = (input.runtimeEvents ?? []).filter(isRecord).filter(e => e.agentId === input.agentId);
  const nonceHits = clientNonce === null ? [] : agentEvents.filter(e => e.clientNonce === clientNonce);
  const nonceTurnIds = new Set<string>();
  for (const event of nonceHits) {
    const step = id(event.stepId);
    if (step) seedIds.add(step);
    const turn = id(event.turnId);
    if (turn) nonceTurnIds.add(turn);
  }
  const journalBound = nonceHits.length > 0;
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
  const runtimeGenerationChanged = [...turnEpochs.values()].some(epochs => epochs.size !== 1)
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
  const failure = recentRuntime.find(e => e.name === "host_stream_rejected")
    ?? recentRuntime.find(e => e.name === "host_normalized_terminal" && (e.terminalClass === "error" || e.terminalClass === "abort"))
    ?? recentRuntime.find(e => e.name === "model_step_terminal" && (e.outcome === "error" || e.outcome === "cancelled"));
  const route = input.transcriptRoute;
  const harnessChanged = route !== undefined && (route.initial !== route.before || route.before !== route.after);
  const harnessUnavailable = route !== undefined && [route.initial, route.before, route.after].includes("unknown");
  const harnessMismatch = route?.expected !== undefined && (route.before !== route.expected || route.after !== route.expected);
  const routeInvalid = harnessChanged || harnessUnavailable || harnessMismatch;
  const invalid = input.gatewayChanged || ambiguous || input.alertsIncomplete || runtimeGenerationChanged || routeInvalid;
  const expectedMatched = input.expectedText !== undefined && delivery.some(d => d.content === input.expectedText);
  const pending = echoObserved || journalBound;
  const state: SendOutcomeState = invalid ? "unknown" : alerts.length > 0 || failure ? "failed"
    : input.expectedText !== undefined ? (expectedMatched ? "expected_result_observed" : delivery.length ? "progress" : pending ? "recorded" : "unknown")
    : delivery.length > 0 ? "delivered" : pending ? "recorded" : "unknown";
  return {
    agentId: input.agentId, clientNonce, requestId,
    state, echoObserved, delivery: invalid ? [] : delivery,
    alerts: invalid ? [] : alerts,
    executionCompleted: "not_proven" as const,
    relatedStepIds: invalid ? [] : [...correlatedIds],
    expectedMatched: !invalid && expectedMatched,
    runtimeFailure: !invalid && failure ? projectRuntimeFailure(failure) : null,
    evidence: { transcript: "Gateway.getAgentTranscriptTail", alerts: "Gateway.getTrays", alertsPersistence: "host-memory", transcriptWindowTruncated: input.truncated,
      runtime: input.runtimeEvents ? "box-local run/log/events.ndjson" : "not_checked", runtimeGap: input.runtimeGap ?? null,
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
      ...(!echoObserved && !input.requestId && !journalBound ? ["nonce_not_in_transcript_window"] : []),
      "dismissed_or_restarted_trays_not_recoverable_from_getTrays",
      "delivery_does_not_prove_run_completion",
    ],
  };
}

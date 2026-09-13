import {
  INFERENCE_CORRELATION_KEYS,
  STATUS_SCHEMA_VERSION,
  type HostDeliveryKind,
  type InferenceCorrelation,
  type Observed,
  type RuntimeStatusFacets,
  type StatusEvidence,
} from "../contract/status.ts";

export type CompleteInferenceCorrelation = { [K in (typeof INFERENCE_CORRELATION_KEYS)[number]]: string };

export type CorrelationResult =
  | { state: "correlated"; tuple: CompleteInferenceCorrelation }
  | { state: "unknown"; missing: Array<(typeof INFERENCE_CORRELATION_KEYS)[number]> };

const UNSAFE_REASON = /secret|prompt|token|auth|api_key|sk-|error_body|password|apiKey/i;

/** Controlled public reason codes. Arbitrary bounded strings become unknown. */
export function projectSafeReason(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value) || UNSAFE_REASON.test(value)) return null;
  return value;
}

/** Local identity/tuple scalars. Rejects secret-shaped values, not only extra keys. */
export function projectSafeIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  if (/[\n\r\x00-\x1f]/.test(value) || UNSAFE_REASON.test(value)) return null;
  return value;
}

/** Copy only allowlisted correlation fields with safe values. Extra keys never survive. */
export function copyInferenceTuple(input: unknown): InferenceCorrelation {
  const out: InferenceCorrelation = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  const record = input as Record<string, unknown>;
  for (const key of INFERENCE_CORRELATION_KEYS) {
    const value = projectSafeIdentity(record[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** Fail closed when a provided tuple field is present but unsafe. */
export function copyInferenceTupleOrReject(input: unknown): InferenceCorrelation | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const out: InferenceCorrelation = {};
  for (const key of INFERENCE_CORRELATION_KEYS) {
    if (record[key] === undefined) continue;
    const value = projectSafeIdentity(record[key]);
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}

export function correlateInferenceTuple(input: InferenceCorrelation | null | undefined): CorrelationResult {
  const tuple = copyInferenceTuple(input);
  const missing = INFERENCE_CORRELATION_KEYS.filter((key) => {
    const value = tuple[key];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) return { state: "unknown", missing };
  return { state: "correlated", tuple: tuple as CompleteInferenceCorrelation };
}

function facet<T>(source: Observed<unknown>, value: T, gap: Observed<unknown>["gap"] = source.gap): Observed<T> {
  return { source: source.source, observedAt: source.observedAt, gap, value };
}

/** Unique status projector. Never aggregates to watchdog.state=degraded or closes a stored circuit. */
export function projectRuntimeStatus(evidence: StatusEvidence): RuntimeStatusFacets {
  const circuitValue = evidence.coordinator.gap === null && evidence.coordinator.value
    ? { state: evidence.coordinator.value.circuit, reason: projectSafeReason(evidence.coordinator.value.circuitReason) }
    : null;
  const circuitOpen = circuitValue?.state === "open";

  const pending = evidence.operationJournal.value?.pending === true;
  const journalGap = evidence.operationJournal.gap;
  let recoveryState: "clear" | "recovery-required" | "unknown";
  if (pending) recoveryState = "recovery-required";
  else if (journalGap === "invalid" || journalGap === "unavailable") recoveryState = "unknown";
  else recoveryState = "clear";

  const serviceScope = evidence.modeld.value?.scope;
  const scopeValid = serviceScope === undefined || ["matched", "mismatch", "unavailable", "not_observed"].includes(serviceScope);
  const modeldReady = evidence.modeld.gap === null && evidence.modeld.value?.ready === true
    && (serviceScope === undefined || serviceScope === "matched");
  const modeldRequired = evidence.modeld.value?.required === true;
  const modeldKnown = evidence.modeld.gap === null && evidence.modeld.value !== null && scopeValid && serviceScope !== "unavailable";
  const epoch = evidence.modeld.value?.serviceEpoch;
  const serviceEpoch = (serviceScope === "matched" || serviceScope === "mismatch") && typeof epoch === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(epoch) ? epoch : null;

  let liveness: "unknown" | "alive" | "stopped" = "unknown";
  if (evidence.controllerLiveness.gap === null && evidence.controllerLiveness.value) {
    liveness = evidence.controllerLiveness.value.alive ? "alive" : "stopped";
  }

  const bridge = evidence.bridgeHost.value;
  const coverage = bridge?.coverage ?? "unknown";

  let deliveryGap = evidence.hostDelivery.gap;
  let deliveryKind: HostDeliveryKind = "not_observed";
  let deliveryTuple: InferenceCorrelation | null = null;
  let correlated = false;
  if (evidence.eventsUnsupported) {
    deliveryGap = "unsupported_schema";
  }
  if (evidence.hostDelivery.value) {
    deliveryKind = evidence.hostDelivery.value.kind;
    const linked = correlateInferenceTuple(evidence.hostDelivery.value.tuple);
    deliveryTuple = linked.state === "correlated" ? linked.tuple : copyInferenceTuple(evidence.hostDelivery.value.tuple);
    correlated = linked.state === "correlated";
    if (evidence.eventsTruncated && deliveryGap === null) deliveryGap = "truncated";
  } else if (evidence.eventsTruncated && deliveryGap === null) {
    deliveryGap = "truncated";
  }

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    observedAt: evidence.now,
    installation: { durableRoot: evidence.durableRoot },
    circuit: facet(evidence.coordinator, circuitValue),
    facets: {
      bridge: facet(evidence.bridgeHost.gap !== null ? evidence.bridgeHost : evidence.desired, {
        desired: evidence.desired.value,
        actual: bridge?.actual ?? "unknown",
        origin: bridge?.origin ?? null,
        coverage,
        reason: bridge?.reason ?? null,
      }, evidence.bridgeHost.gap ?? evidence.desired.gap),
      modeld: facet(evidence.modeld, {
        required: modeldRequired,
        ready: modeldKnown ? modeldReady : null,
        ...(serviceScope !== undefined ? { scope: scopeValid ? serviceScope : "unavailable" as const, serviceEpoch } : {}),
      }, scopeValid ? evidence.modeld.gap : "invalid"),
      controller: facet(evidence.controllerLiveness, { liveness }),
      mutation: facet(evidence.coordinator, {
        inhibited: circuitOpen,
        allowed: circuitValue?.state === "closed",
        reason: circuitOpen ? (projectSafeReason(circuitValue.reason) ?? "circuit_open") : null,
      }),
      recovery: facet(evidence.operationJournal, {
        state: recoveryState,
        pending: evidence.operationJournal.gap === null ? pending : evidence.operationJournal.gap === "missing" ? false : null,
      }),
      hostDelivery: facet(evidence.hostDelivery, {
        kind: deliveryKind,
        correlated,
        tuple: deliveryTuple,
      }, deliveryGap),
    },
  };
}

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

export function correlateInferenceTuple(input: InferenceCorrelation | null | undefined): CorrelationResult {
  const tuple = input ?? {};
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
    ? { state: evidence.coordinator.value.circuit, reason: evidence.coordinator.value.circuitReason }
    : null;
  const circuitOpen = circuitValue?.state === "open";

  const pending = evidence.operationJournal.value?.pending === true;
  const journalGap = evidence.operationJournal.gap;
  let recoveryState: "clear" | "recovery-required" | "unknown";
  if (pending) recoveryState = "recovery-required";
  else if (journalGap === "invalid" || journalGap === "unavailable") recoveryState = "unknown";
  else recoveryState = "clear";

  const modeldReady = evidence.modeld.gap === null && evidence.modeld.value?.ready === true;
  const modeldRequired = evidence.modeld.value?.required === true;
  const modeldKnown = evidence.modeld.gap === null && evidence.modeld.value !== null;

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
  } else if (evidence.eventsTruncated && evidence.hostDelivery.gap === null && evidence.hostDelivery.value == null) {
    deliveryGap = deliveryGap ?? "truncated";
  } else if (evidence.hostDelivery.value) {
    deliveryKind = evidence.hostDelivery.value.kind;
    const linked = correlateInferenceTuple(evidence.hostDelivery.value.tuple);
    if (linked.state === "correlated") {
      correlated = true;
      deliveryTuple = linked.tuple;
    } else {
      deliveryTuple = evidence.hostDelivery.value.tuple;
    }
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
      }),
      controller: facet(evidence.controllerLiveness, { liveness }),
      mutation: facet(evidence.coordinator, {
        inhibited: circuitOpen,
        allowed: circuitValue?.state === "closed",
        reason: circuitOpen ? (circuitValue.reason ?? "circuit_open") : null,
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

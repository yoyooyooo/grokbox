export type StatusFacetName =
  | "bridge"
  | "modeld"
  | "controller"
  | "mutation"
  | "recovery"
  | "hostDelivery";

export const STATUS_SCHEMA_VERSION = 1 as const;

export type ObservationGap =
  | null
  | "missing"
  | "invalid"
  | "unavailable"
  | "partial"
  | "truncated"
  | "unsupported_schema";

export type Observed<T> = {
  source: string;
  observedAt: string | null;
  gap: ObservationGap;
  value: T | null;
};

export type DesiredModeName = "disabled" | "observe" | "identity" | "route";

export type BridgeActual = "official" | "identity" | "route" | "patched-unknown" | "unknown";
export type BridgeOrigin = "official" | "grokbox-attested" | "grokbox-unattested" | "ambiguous";
export type BridgeCoverage = "none" | "window-open" | "attested" | "unknown";

export type InferenceCorrelation = {
  hostId?: string;
  agentId?: string;
  turnId?: string;
  stepId?: string;
  serviceEpoch?: string;
  binding?: string;
  attempt?: string;
};

export const INFERENCE_CORRELATION_KEYS = [
  "hostId",
  "agentId",
  "turnId",
  "stepId",
  "serviceEpoch",
  "binding",
  "attempt",
] as const;

export type HostDeliveryKind = "not_observed" | "host_terminal" | "host_rejected" | "model_terminal";

import type { ExecutionCapacity } from "./execution-status.ts";
export type ModeldExecutionEvidence = { execution?: ExecutionCapacity; executionGap?: "not_instrumented" | "generation_changed" };
export type ModeldProtocolEvidence = { wireVersion?: number; expectedWireVersion?: number; protocolCompatible?: boolean };
export type ModeldAvailabilityEvidence = ModeldProtocolEvidence & {
  liveness?: "reachable" | "unavailable" | "unknown";
  admission?: "ready" | "blocked" | "protocol_mismatch" | "scope_mismatch" | "generation_changed" | "not_observed";
  protocolComparison?: "observer_to_modeld";
  hostProtocolCompatibility?: "not_observed";
};
export type ModeldServiceScope = "matched" | "mismatch" | "unavailable" | "not_observed";

export type StatusEvidence = {
  now: string;
  durableRoot: string;
  desired: Observed<DesiredModeName | null>;
  attestation: Observed<{ coverage: "attested"; mode: "identity" | "route" } | null>;
  coordinator: Observed<{ circuit: "open" | "closed"; circuitReason: string | null } | null>;
  operationJournal: Observed<{ pending: boolean; phase: string | null } | null>;
  modeld: Observed<({ required: boolean; ready: boolean; scope?: ModeldServiceScope; serviceEpoch?: string | null } & ModeldExecutionEvidence & ModeldAvailabilityEvidence) | null>;
  controllerLiveness: Observed<{ alive: boolean } | null>;
  bridgeHost: Observed<{
    actual: BridgeActual;
    origin: BridgeOrigin;
    coverage: BridgeCoverage;
    reason: string | null;
  } | null>;
  hostDelivery: Observed<{
    kind: Exclude<HostDeliveryKind, "not_observed">;
    tuple: InferenceCorrelation;
  } | null>;
  eventsTruncated?: boolean;
  eventsUnsupported?: boolean;
};

export type StatusFacet<T> = Observed<T>;

export type RuntimeStatusFacets = {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  observedAt: string;
  installation: { durableRoot: string };
  circuit: StatusFacet<{ state: "open" | "closed"; reason: string | null }>;
  facets: {
    bridge: StatusFacet<{
      desired: DesiredModeName | null;
      actual: BridgeActual;
      origin: BridgeOrigin | null;
      coverage: BridgeCoverage;
      reason: string | null;
    }>;
    modeld: StatusFacet<{ required: boolean; ready: boolean | null; scope?: ModeldServiceScope; serviceEpoch?: string | null } & ModeldExecutionEvidence & ModeldAvailabilityEvidence>;
    controller: StatusFacet<{ liveness: "unknown" | "alive" | "stopped" }>;
    mutation: StatusFacet<{ inhibited: boolean; allowed: boolean; reason: string | null }>;
    recovery: StatusFacet<{ state: "clear" | "recovery-required" | "unknown"; pending: boolean | null }>;
    hostDelivery: StatusFacet<{
      kind: HostDeliveryKind;
      correlated: boolean;
      tuple: InferenceCorrelation | null;
    }>;
  };
};

export type JournalWriterRole = "host" | "modeld" | "control" | "watchdog";

export const JOURNAL_EVENT_ALLOWLIST = {
  host: ["host_stream_rejected", "host_normalized_terminal", "turn_seam_terminal", "host_seam_stage", "host_run_observation", "host_alert_observation"],
  modeld: ["model_step_terminal", "provider_error_observed", "model_recovery_progress"],
  control: [
    "disk_sha_observed",
    "contracts_snapshot",
    "attestation_invalidated",
    "census",
    "stale_patched_detected",
    "stale_patched_term",
    "circuit_open",
    "inject_phase",
  ],
} as const;

export function journalRoleAllows(role: JournalWriterRole, eventName: string): boolean {
  if (role === "watchdog") return false;
  return (JOURNAL_EVENT_ALLOWLIST[role] as readonly string[]).includes(eventName);
}

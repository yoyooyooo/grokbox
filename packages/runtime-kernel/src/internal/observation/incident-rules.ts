import { observationOwn as own } from "../contract/provider-observation.ts";
import { failureSummaryFromObservation, type FailureCategory } from "../contract/failure-summary.ts";
import { evidenceIdentity, type EvidenceFact } from "./evidence-contract.ts";
import { projectContinuityEvent } from "./continuity-contract.ts";

export const INCIDENT_CLASSIFIER_VERSION = "incident-rules-v1";
export const OBSERVATION_INCIDENT_RULES = ["host_patch_health", "native_alert", "native_run_failure", "execution_stalled", "source_gap", "continuity_attention"] as const;
export type ObservationIncidentRule = typeof OBSERVATION_INCIDENT_RULES[number];
export type IncidentAssessment = {
  classifierVersion: typeof INCIDENT_CLASSIFIER_VERSION;
  category: FailureCategory | "host_compatibility" | "native_failure" | "suspected_stall" | "observation_gap" | "continuity_impact";
  disposition: "notify" | "local_only";
  reason: "host_contract" | "runtime_failure" | "unclassified_failure" | "upstream_only" | "expected_cancellation" | "suspected_stall" | "observation_gap" | "protected_subject_changed";
  basis: "derived";
  basisRefs: string[];
  rootCause: "not_proven";
};
export type IncidentCandidate = { rule: ObservationIncidentRule; identity: string[]; agentId: string | null; category: "occurrence" | "condition" };
const id = (value: unknown) => evidenceIdentity(value) ? value : undefined;

/** Native failed tasks and unknown error trays are first-class incident inputs.
 * A snapshot does not manufacture a historical creation; it is its own observed
 * condition. Alert decisions alone do not mean a tray was actually published. */
export function observationIncidentCandidate(value: Record<string, unknown>): IncidentCandidate | undefined {
  if (own(value, "name") === "continuity_observation") {
    const event = projectContinuityEvent(value); if (!event) return;
    if (event.coverage.state !== "observed") return { rule: "source_gap", identity: ["source-gap", event.sourceInstanceId], agentId: event.agentId, category: "condition" };
    if (["ownership_lost", "recovery_degraded", "operation_unknown"].includes(event.kind)) return { rule: "continuity_attention",
      identity: [event.scopeId, event.agentId, event.kind, event.occurrenceId], agentId: event.agentId, category: "occurrence" };
    // Still-Temporal, progress and an inbound window do not resolve a domain
    // expectation or authorize retirement. CONT owns those decisions.
    return;
  }
  const name = own(value, "name"), generation = id(own(value, "hostGenerationId"));
  const agentId = id(own(value, "agentId")) ?? null;
  if (name === "host_run_observation" && own(value, "state") === "failed" && generation && id(own(value, "dispatchId"))) {
    return { rule: "native_run_failure", identity: [generation, agentId ?? "unscoped", String(own(value, "dispatchId"))], agentId, category: "occurrence" };
  }
  if (name === "host_alert_observation" && ["tray_created", "tray_updated", "tray_snapshot"].includes(own(value, "kind") as string)
    && generation && id(own(value, "sourceInstanceId")) && id(own(value, "trayId"))) {
    return { rule: "native_alert", identity: [generation, String(own(value, "sourceInstanceId")), String(own(value, "trayId"))], agentId, category: "occurrence" };
  }
}

/** Reuses the existing failure classifier. Upstream status cannot suppress a
 * separate positively observed local integrity/storage/settlement failure. */
export function assessIncident(rule: string, facts: readonly EvidenceFact[]): IncidentAssessment {
  if(rule==="host_patch_health")return {classifierVersion:INCIDENT_CLASSIFIER_VERSION,category:"host_compatibility",disposition:"notify",reason:"host_contract",basis:"derived",rootCause:"not_proven",basisRefs:facts.filter(f=>own(f.value,"name")==="host_patch_health").slice(0,16).map(f=>f.ref)};
  if (rule === "continuity_attention") return { classifierVersion: INCIDENT_CLASSIFIER_VERSION, category: "continuity_impact",
    disposition: "notify", reason: "protected_subject_changed", basis: "derived", rootCause: "not_proven",
    basisRefs: facts.filter(f => own(f.value, "name") === "continuity_observation").slice(0, 16).map(f => f.ref) };
  const failures = facts.filter(f => ["host_stream_rejected", "host_normalized_terminal", "model_step_terminal"].includes(own(f.value, "name") as string)
    && (own(f.value, "name") === "host_stream_rejected" || ["error", "abort", "cancelled"].includes((own(f.value, "terminalClass") ?? own(f.value, "outcome")) as string)));
  const summaries = failures.map(f => ({ ref: f.ref, summary: failureSummaryFromObservation(f.value) })).filter(row => row.summary !== undefined);
  const common = { classifierVersion: INCIDENT_CLASSIFIER_VERSION, basis: "derived", rootCause: "not_proven" } as const;
  const local = summaries.find(row => ["stream_invalid", "stream_budget", "local_capacity", "execution_history", "authority", "wire", "configuration"].includes(row.summary!.category));
  if (local) return { ...common, category: local.summary!.category, disposition: "notify", reason: "runtime_failure", basisRefs: [local.ref] };
  if (rule === "source_gap" || rule === "observation_unavailable") return { ...common, category: "observation_gap", disposition: "notify", reason: "observation_gap", basisRefs: facts.slice(0, 8).map(f => f.ref) };
  if (rule === "execution_stalled") return { ...common, category: "suspected_stall", disposition: "notify", reason: "suspected_stall", basisRefs: facts.slice(0, 8).map(f => f.ref) };
  if (summaries.length && summaries.length === failures.length && summaries.every(row => row.summary!.origin === "upstream")) {
    return { ...common, category: summaries[0]!.summary!.category, disposition: "local_only", reason: "upstream_only", basisRefs: summaries.map(row => row.ref) };
  }
  // Cancellation without a trustworthy user-source receipt is not classified as
  // an expected user action. An IPC disconnect is not such a receipt either.
  const expectedCancel = facts.find(f => own(f.value, "name") === "host_run_observation" && own(f.value, "state") === "cancelled");
  if (!failures.length && expectedCancel && rule !== "native_alert") return { ...common, category: "cancelled", disposition: "local_only", reason: "expected_cancellation", basisRefs: [expectedCancel.ref] };
  return { ...common, category: rule === "native_run_failure" ? "native_failure" : "unknown", disposition: "notify", reason: "unclassified_failure", basisRefs: facts.slice(0, 16).map(f => f.ref) };
}

export const STALL_POLICY = { version: "stall-v1", minIdleMs: 300_000, sourceFreshMs: 90_000, maxOpen: 4096 } as const;
export function assessUnsettledExecution(input: { state: string; lastProgressMs: number; nowMs: number; sourceLastObservedMs: number | null; waitingReason?: string; deadlineMs?: number }) {
  if (!["queued", "started"].includes(input.state)) return "settled" as const;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < input.lastProgressMs || input.sourceLastObservedMs === null
    || input.nowMs < input.sourceLastObservedMs || input.nowMs - input.sourceLastObservedMs > STALL_POLICY.sourceFreshMs) return "source_unavailable" as const;
  if (["approval", "user", "external_task"].includes(input.waitingReason ?? "")) return "waiting" as const;
  if (input.deadlineMs !== undefined && input.nowMs >= input.deadlineMs) return "deadline_observed" as const;
  return input.nowMs - input.lastProgressMs >= STALL_POLICY.minIdleMs ? "suspected" as const : "progressing" as const;
}

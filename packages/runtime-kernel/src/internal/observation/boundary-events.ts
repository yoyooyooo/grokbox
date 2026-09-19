import { observationOwn as own } from "../contract/provider-observation.ts";
import { projectRuntimeBuildInfo, type RuntimeBuildInfo } from "../contract/build-info.ts";
import { evidenceIdentity } from "./evidence-contract.ts";

export type ContextBoundaryState = "checkpoint_started" | "checkpoint_observed" | "commit_unknown";
export type ExecutionBoundary = {
  schemaVersion: 1; at: string; hostGenerationId: string; agentId: string; turnId: string;
  stepId?: string; serviceEpoch?: string; build?: RuntimeBuildInfo;
} & ({
  name: "host_context_observation"; state: ContextBoundaryState; operationId: string;
  rootId: string; sourceRootRevision: string; rootRevision: string;
  basis: "native_context_owner"; persisted: boolean;
} | ({
  name: "host_tool_observation"; toolCallId: string; dispatchId?: string; externalCommitObserved: false;
} & ({ state: "result_accepted"; basis: "prompt_executor_append"; nativeHandlerObserved: false }
  | { state: "native_started" | "returned" | "failed"; basis: "native_tool_handler"; nativeHandlerObserved: true })));
// A native handler can include approval waiting; entered is not approved.
export type ObservationSourceHealth = {
  name: "observation_source_health"; schemaVersion: 1; at: string; collectorEpoch: string;
  sourceKey: string; source: "host" | "control";
  state: "observed" | "partial" | "unavailable" | "not_observed";
  basis: "collector_read"; producerLiveness: "not_checked";
  readBytes: number; records: number; hasMore: boolean;
};
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const at = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_073_741_824;

/** Metadata-only producer contracts. A context ACK and a tool-result append are
 * different native boundaries; neither is proof of an external business effect,
 * displayed UI, or a healthy task/observer merely because it has a live PID. */
export function projectExecutionBoundary(value: unknown): ExecutionBoundary | null {
  const name = own(value, "name"), time = own(value, "at");
  const hostGenerationId = own(value, "hostGenerationId"), agentId = own(value, "agentId"), turnId = own(value, "turnId");
  if (own(value, "schemaVersion") !== 1 || !at(time) || !evidenceIdentity(hostGenerationId) || !evidenceIdentity(agentId) || !evidenceIdentity(turnId)) return null;
  const stepId = own(value, "stepId"), serviceEpoch = own(value, "serviceEpoch"), build = projectRuntimeBuildInfo(own(value, "build"));
  if (stepId !== undefined && !evidenceIdentity(stepId) || serviceEpoch !== undefined && !evidenceIdentity(serviceEpoch)) return null;
  const identity = { schemaVersion: 1 as const, at: time, hostGenerationId, agentId, turnId,
    ...(evidenceIdentity(stepId) ? { stepId } : {}), ...(evidenceIdentity(serviceEpoch) ? { serviceEpoch } : {}), ...(build ? { build } : {}) };
  if (name === "host_context_observation") {
    const operationId = own(value, "operationId"), state = own(value, "state"), rootId = own(value, "rootId"),
      sourceRootRevision = own(value, "sourceRootRevision"), rootRevision = own(value, "rootRevision"), persisted = own(value, "persisted");
    if (!evidenceIdentity(operationId) || !["checkpoint_started", "checkpoint_observed", "commit_unknown"].includes(state as string)
      || !digest(rootId) || !digest(sourceRootRevision) || !digest(rootRevision) || own(value, "basis") !== "native_context_owner"
      || typeof persisted !== "boolean" || persisted !== (state === "checkpoint_observed")) return null;
    return { ...identity, name, operationId, state: state as ContextBoundaryState, rootId, sourceRootRevision, rootRevision,
      basis: "native_context_owner", persisted };
  }
  if (name === "host_tool_observation") {
    const toolCallId = own(value, "toolCallId"), state = own(value, "state"), basis = own(value, "basis"), dispatchId = own(value, "dispatchId");
    if (!evidenceIdentity(toolCallId) || own(value, "externalCommitObserved") !== false) return null;
    if (state === "result_accepted" && basis === "prompt_executor_append" && own(value, "nativeHandlerObserved") === false) {
      return { ...identity, name, state, toolCallId, basis, nativeHandlerObserved: false, externalCommitObserved: false };
    }
    if (basis === "native_tool_handler" && own(value, "nativeHandlerObserved") === true
      && ["native_started", "returned", "failed"].includes(state as string) && evidenceIdentity(dispatchId)) {
      return { ...identity, name, state: state as "native_started" | "returned" | "failed", toolCallId, dispatchId,
        basis, nativeHandlerObserved: true, externalCommitObserved: false };
    }
    return null;
  }
  return null;
}
export function projectObservationSourceHealth(value: unknown): ObservationSourceHealth | null {
  const time = own(value, "at"), collectorEpoch = own(value, "collectorEpoch"), sourceKey = own(value, "sourceKey"),
    source = own(value, "source"), state = own(value, "state"), readBytes = own(value, "readBytes"), records = own(value, "records"), hasMore = own(value, "hasMore");
  if (own(value, "name") !== "observation_source_health" || own(value, "schemaVersion") !== 1 || !at(time)
    || !evidenceIdentity(collectorEpoch) || !digest(sourceKey) || !["host", "control"].includes(source as string)
    || !["observed", "partial", "unavailable", "not_observed"].includes(state as string) || !count(readBytes) || !count(records) || typeof hasMore !== "boolean"
    || own(value, "basis") !== "collector_read" || own(value, "producerLiveness") !== "not_checked") return null;
  return { name: "observation_source_health", schemaVersion: 1, at: time, collectorEpoch, sourceKey,
    source: source as "host" | "control", state: state as ObservationSourceHealth["state"], basis: "collector_read",
    producerLiveness: "not_checked", readBytes, records, hasMore };
}

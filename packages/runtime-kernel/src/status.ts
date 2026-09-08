export {
  STATUS_SCHEMA_VERSION,
  journalRoleAllows,
  JOURNAL_EVENT_ALLOWLIST,
  INFERENCE_CORRELATION_KEYS,
  type StatusFacetName,
  type ObservationGap,
  type Observed,
  type StatusEvidence,
  type RuntimeStatusFacets,
  type InferenceCorrelation,
  type JournalWriterRole,
  type HostDeliveryKind,
} from "./internal/contract/status.ts";

export {
  projectRuntimeStatus,
  correlateInferenceTuple,
  copyInferenceTuple,
  copyInferenceTupleOrReject,
  projectSafeIdentity,
  projectSafeReason,
  type CorrelationResult,
} from "./internal/status/projection.ts";

export { BoxRuntimeError, runtimeNotReady, type BoxRuntimeErrorCode } from "@grokbox/runtime-kernel/contract";
export {
  applyReset,
  applyUse,
  assertResetAllowed,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  disclosure,
  parseModelId,
  type DesiredMode,
  type ModelsFile,
} from "@grokbox/runtime-kernel/selection";

export { assertBoxLocal, type LocalRuntimeContext } from "./internal/io/local.ts";
export {
  reviewedProfilePath,
  hostBundlesDir,
  retainedGenerationDir,
  retainedGenerationSourcePath,
} from "./internal/io/paths.ts";
export { openRuntimeStore, type RuntimeStore } from "./internal/io/configuration.node.ts";
export { saveRuntimeModels, saveRuntimeDesired, configurationWriteLayer } from "./internal/io/configuration-write.node.ts";
export { persistModelCredential } from "./internal/io/persist-model-credential.node.ts";
export { readManagedOwnership, type OwnershipReader } from "./internal/io/ownership-admission.node.ts";
export { changeRuntimeModel } from "./internal/io/model-selection.node.ts";
export {
  projectLiveStatus,
  readContracts,
  type RuntimeStatus,
} from "./internal/io/observe.ts";
export {
  observeEvents,
  observeRuntimeEvents,
  maintainObservationJournals,
  projectJournalEvent,
  projectControlEvent,
  type EventsObservation,
  type JournalLookup,
  type RuntimeEventSelector,
  HOST_STREAM_REJECT_REASONS,
  TURN_SEAM_ERROR_CODES,
  projectHostSeamStage,
  projectHostStreamRejected,
  type HostStreamRejectedEvent,
} from "./internal/io/journal.node.ts";
export { replaceModeld } from "./internal/roots/modeld-replace.node.ts";
export { observeModeldService, probeModeldExecution } from "./internal/wire/modeld-probe.node.ts";
export { observeJournalHealth, readJournalHealth, type JournalHealthObservation } from "./internal/host/journal-health.node.ts";
export {
  HOST_FAILURE_CATALOG,
  INVALID_STREAM_AGENT_MESSAGE,
  LOCAL_TRANSPORT_AGENT_MESSAGE,
  catalogAgentMessage,
  catalogByFailureCode,
  catalogByReason,
  mapAdmitCatch,
  mapTerminalReject,
  type HostFailureCatalogRow,
} from "./internal/host/failure-catalog.ts";
export {
  writeReviewedProfileFromCopy,
  ProfileWriteRefused,
  profileObserveThenWriteNext,
  profileWriteUnretainedNext,
  profileWriteMissingGoldenNext,
  profileWriteDriftNext,
  profileWriteExecutableNext,
  inspectRetainedWriteEnvelope,
  type ProfileWriteLineage,
  type ProfileWriteRefusal,
  type ProfileWriteInspect,
  type WriteReviewedProfileReceipt,
} from "./internal/process/profile.node.ts";
export { observeHostProvenance, type HostSeamObserveReceipt } from "./internal/ops/host-seam/observe.ts";
export {
  applyRetentionPlan,
  buildRetentionPlan,
  readRetentionPlanFile,
  unavailableTrash,
  type RetentionPlan,
} from "./internal/ops/host-seam/prune.ts";
export { watchHostSeamOnce, type HostSeamWatchOnceReceipt } from "./internal/ops/host-seam/watch.ts";
export { readOnlyHostStatus, HOST_UPGRADE_RPC_FORBIDDEN } from "./internal/ops/host-seam/gateway-readonly.ts";
export {
  replayHostSeam,
  assertReplayCoverage,
  bindReviewedProfile,
  writeGoldenLabels,
  writeReplayReport,
  readLastReplayReport,
  type ReplayReport,
} from "./internal/ops/host-seam/replay.ts";
export { projectHostSeamStatus, type HostSeamStatusFacets } from "./internal/ops/host-seam/seam-status.ts";
export {
  ENVELOPE_SLICE_COUNT,
  ENVELOPE_SLICE_IDS,
  ENVELOPE_WINDOWS_FILE,
  admitWriteEnvelope,
  classifyWriteEnvelopeDrift,
  diffEnvelopeWindows,
  encodeEnvelopeWindows,
  generationEnvelopePath,
  measureEnvelopeWindows,
  parseEnvelopeWindows,
  observeRetainedEnvelopeDrift,
  type EnvelopeDrift,
  type EnvelopeDriftObservation,
  type EnvelopeWindows,
  type WriteEnvelopeAdmission,
} from "./internal/ops/host-seam/envelope-windows.ts";
export {
  proposeFromSource,
  readProposeSource,
  writeCandidateArtifact,
  proposeSummary,
  autoPublishTopCandidate,
  type CandidateArtifact,
} from "./internal/ops/host-seam/propose.ts";
export {
  createAnalysisSession,
  createFakeAnalysisPort,
  writeAnalysisArtifact,
  attachWriteEnvelopeInspect,
  type AnalysisResult,
  type AnalysisEnvelopeEvidence,
} from "./internal/ops/host-seam/analyze.ts";

export { startModeldProcess, ensureModeld, modeldRootLayer, type StartedModeld, type ModeldEnsure } from "./internal/roots/modeld.runtime.ts";
export { openMonitorStore } from "./internal/io/monitor-store.node.ts";
export { runMonitor } from "./internal/roots/monitor.runtime.ts";
export { startRuntimeCommand, type RuntimeStartResult } from "./internal/roots/command.runtime.ts";
export { startControlOperation, controllerOperationId, diskPreloadSha256, reviewedProfileSha256 } from "./internal/roots/controller-program.node.ts";
export { stopPatchedHostCoverage, stopLivePatchedHost } from "./internal/process/host-stop.ts";
export type { IdentityOpResult } from "./internal/process/identity-op.ts";

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
export { reviewedProfilePath } from "./internal/io/paths.ts";
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
export { observeEvents, observeRuntimeEvents } from "./internal/io/journal.node.ts";
export { writeReviewedProfileFromCopy } from "./internal/process/profile.node.ts";
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
  type AnalysisResult,
} from "./internal/ops/host-seam/analyze.ts";

export { startModeldProcess, ensureModeld, modeldRootLayer, type StartedModeld, type ModeldEnsure } from "./internal/roots/modeld.runtime.ts";
export { openMonitorStore } from "./internal/io/monitor-store.node.ts";
export { runMonitor } from "./internal/roots/monitor.runtime.ts";
export { startRuntimeCommand, type RuntimeStartResult } from "./internal/roots/command.runtime.ts";
export { startControlOperation, controllerOperationId, diskPreloadSha256, reviewedProfileSha256 } from "./internal/roots/controller-program.node.ts";

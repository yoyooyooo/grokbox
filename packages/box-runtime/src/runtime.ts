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
export {
  projectLiveStatus,
  readContracts,
  type RuntimeStatus,
} from "./internal/io/observe.ts";
export { observeEvents } from "./internal/io/journal.node.ts";
export { writeReviewedProfileFromCopy } from "./internal/process/profile.node.ts";

export { startModeldProcess, ensureModeld, modeldRootLayer, type StartedModeld, type ModeldEnsure } from "./internal/roots/modeld.runtime.ts";
export { startControlOperation, controllerOperationId, diskPreloadSha256 } from "./internal/roots/controller-program.node.ts";

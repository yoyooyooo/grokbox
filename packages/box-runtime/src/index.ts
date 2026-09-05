export { BoxRuntimeError, type BoxRuntimeErrorCode } from "./errors.ts";
export { shouldTransformArgv } from "./argv.ts";
export { installCompileHook, transformCompileInput } from "./hook.ts";
export { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES, isLiveHostPath } from "./live-slices.ts";
export { assertBoxLocal, type LocalRuntimeContext } from "./local.ts";
export {
  CLI_INSTALL_ROOT,
  DEFAULT_DURABLE_ROOT,
  contractsDir,
  eventsPath,
  resolveDurableRoot,
} from "./paths.ts";
export {
  applyReset,
  applyUse,
  assertResetAllowed,
  assertRouteAssignment,
  disclosure,
  openRuntimeStore,
  parseApiKeyRef,
  parseModelId,
  type DesiredMode,
  type ModelsFile,
  type RuntimeStore,
} from "./models.ts";
export {
  projectStatus,
  projectLiveStatus,
  readContracts,
  readEvents,
  type HostOrigin,
  type HostReason,
  type RuntimeStatus,
} from "./observe.ts";
export { runIdentityChainInject, runLiveIdentityInject, runLiveIdentityDeactivate } from "./live-inject.ts";
export { runIdentityOperation, runIdentityDeactivate, attestationAgrees } from "./identity-op.ts";
export {
  runH3OfflineInject,
  runH3OfflineDeactivate,
  runH3OfflineAdopt,
  runH3OfflineAdoptDeactivate,
  identityLaunchFields,
} from "./h3-identity.ts";
export {
  decideLivePreflight,
  identityHostReady,
  preflightLiveH3,
  reviewOfficialAdoptCapability,
  runH3LiveIdentitySession,
  writeReviewedProfileFromCopy,
} from "./h3-live.ts";
export { pickLaunchEnv } from "./launch-env.ts";
export { decideH3LaunchStrategy, type H3LaunchStrategy } from "./launch-strategy.ts";
export {
  findUniqueOfficialChain,
  findAdoptedHostState,
  proveStableOfficialState,
  loadReviewedProfile,
} from "./official-chain.ts";
export {
  runTransientAdoptOperation,
  runTransientAdoptDeactivate,
  canHandoffAdopt,
  officialWouldSpawn,
  readAdoptOpState,
  writeAdoptOpState,
} from "./transient-adopt.ts";
export {
  applyPatchProfile,
  extractContractSlices,
  profileFromSource,
  sliceHashes,
  transformUnchecked,
  ROUTE_SESSION_SYMBOL,
  type PatchProfile,
  type SlicePatch,
} from "./transform.ts";
export { createManagedPromptSession, type PromptSession, type StreamHandle } from "./session.ts";
export { sha256Bytes, sha256Text } from "./hash.ts";
export {
  identitiesMatch,
  stableIdentitiesMatch,
  signalIfMatch,
  readOnlyProcessPort,
  singleOfficialChain,
  type ProcessIdentity,
  type ProcessPort,
} from "./process.ts";
export { armGuardian } from "./guardian.ts";
export { runObserveOrIdentityInject, type InjectContext } from "./inject.ts";
export { createModeld, createFileEnvSecretResolver, type AdmitResult } from "./modeld.ts";
export { observeAndHeal } from "./watchdog.ts";
export {
  runWatchdogTick,
  WATCHDOG_MUTATION_BUDGET,
  WATCHDOG_OPERATION_ID,
  type WatchdogTickResult,
} from "./coordinator.ts";
export { resolveAssignment } from "./models.ts";

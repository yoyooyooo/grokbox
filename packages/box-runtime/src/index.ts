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
  reviewedProfilePath,
} from "./paths.ts";
export {
  applyReset,
  applyUse,
  assertResetAllowed,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  disclosure,
  openRuntimeStore,
  parseApiKeyRef,
  parseModelId,
  STUB_ECHO_MODEL_ID,
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
export {
  runIdentityOperation,
  runIdentityDeactivate,
  attestationAgrees,
  canonicalOwnershipAgrees,
} from "./identity-op.ts";
export {
  runH3OfflineInject,
  runH3OfflineDeactivate,
  runH3OfflineAdopt,
  runH3OfflineAdoptDeactivate,
  identityLaunchFields,
} from "./h3-identity.ts";
export {
  createLiveH3AdoptPorts,
  decideLivePreflight,
  identityHostReady,
  liveDiskSha,
  preflightLiveH3,
  reviewOfficialAdoptCapability,
  runH3LiveIdentitySession,
  writeReviewedProfileFromCopy,
} from "./h3-live.ts";
export { liveH3AdoptAdapter, wireLiveManualReadopt } from "./live-readopt.ts";
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
  adoptJournalNeedsRecovery,
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
export {
  asHostPromptSession,
  createManagedPromptSession,
  type HostPromptSession,
  type PromptSession,
  type StreamHandle,
} from "./session.ts";
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
export { ephemeralRuntimeRoot } from "./ephemeral.ts";
export { createModeld, createFileEnvSecretResolver, type AdmitResult } from "./modeld.ts";
export {
  startStubModeldServer,
  probeStubModeld,
  modeldSocketPath,
  STUB_ECHO_PARTS,
} from "./modeld-ipc.ts";
export {
  bindHostSessionHook,
  createSessionSeam,
  createStubRouteDriver,
  createModeldRouteDriver,
} from "./seam.ts";
export { observeAndHeal } from "./watchdog.ts";
export {
  runWatchdogTick,
  runWatchdogCutover,
  runManualReadopt,
  WATCHDOG_MUTATION_BUDGET,
  WATCHDOG_OPERATION_ID,
  type ManualReadoptInput,
  type WatchdogTickResult,
} from "./coordinator.ts";
export { resolveAssignment } from "./models.ts";

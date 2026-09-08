export { BoxRuntimeError, runtimeNotReady, type BoxRuntimeErrorCode } from "@grokbox/runtime-kernel/contract";
export {
  applyReset,
  applyUse,
  assertResetAllowed,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  decideRouteSession,
  disclosure,
  parseApiKeyRef,
  parseModelId,
  parseModelsFile,
  routeModelAdmitted,
  STUB_ECHO_MODEL_ID,
  type DesiredFile,
  type DesiredMode,
  type ModelsFile,
} from "@grokbox/runtime-kernel/selection";
export { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";

export { shouldTransformArgv } from "./internal/host/argv.ts";
export { installCompileHook, transformCompileInput } from "./internal/host/compile-hook.ts";
export { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES, isLiveHostPath } from "./internal/host/live-slices.ts";
export { applyPatchProfile, profileFromSource, ROUTE_SESSION_SYMBOL, type PatchProfile } from "./internal/host/profile.ts";
export { bindCompiledHost, type HostBinding } from "./internal/host/host-binding.ts";
export { bindHostSessionHook } from "./internal/host/session-hook.ts";
export { loadModelsFileSync } from "./internal/host/selection.node.ts";
export {
  asHostPromptSession,
  type HostPromptSession,
  type PromptSession,
  type StreamHandle,
} from "./internal/host/session.ts";

export { assertBoxLocal, type LocalRuntimeContext } from "./internal/io/local.ts";
export {
  CLI_INSTALL_ROOT,
  DEFAULT_DURABLE_ROOT,
  contractsDir,
  eventsPath,
  hostBundlesDir,
  resolveDurableRoot,
  reviewedProfilePath,
} from "./internal/io/paths.ts";
export { openRuntimeStore, type RuntimeStore } from "./internal/io/configuration.node.ts";
export { ephemeralRuntimeRoot } from "./internal/io/ephemeral.ts";
export {
  projectStatus,
  projectLiveStatus,
  liveStatusAdapter,
  readContracts,
  readHostBundles,
  readEvents,
  type HostOrigin,
  type HostReason,
  type RuntimeStatus,
} from "./internal/io/observe.ts";
export { observeEvents } from "./internal/io/journal.node.ts";

export {
  identitiesMatch,
  stableIdentitiesMatch,
  signalIfMatch,
  readOnlyProcessPort,
  singleOfficialChain,
  type ProcessIdentity,
  type ProcessPort,
} from "./internal/process/process-port.ts";
export { armGuardian } from "./internal/process/guardian.node.ts";
export { pickLaunchEnv } from "./internal/process/launch.node.ts";
export { decideH3LaunchStrategy, type H3LaunchStrategy } from "./internal/process/launch-strategy.ts";
export { runIdentityChainInject, runLiveIdentityInject, runLiveIdentityDeactivate } from "./internal/process/live-inject.ts";
export {
  runIdentityOperation,
  runIdentityDeactivate,
  attestationAgrees,
  canonicalOwnershipAgrees,
} from "./internal/process/identity-op.ts";
export {
  runH3OfflineInject,
  runH3OfflineDeactivate,
  runH3OfflineAdopt,
  runH3OfflineAdoptDeactivate,
  identityLaunchFields,
} from "./internal/process/h3-identity.ts";
export {
  createLiveH3AdoptPorts,
  decideLivePreflight,
  identityHostReady,
  liveDiskSha,
  preflightLiveH3,
  reviewOfficialAdoptCapability,
  runH3LiveIdentitySession,
  writeReviewedProfileFromCopy,
  type WriteReviewedProfileFromCopyInput,
} from "./internal/process/h3-live.ts";
export { liveH3AdoptAdapter, wireLiveManualReadopt } from "./internal/process/live-readopt.ts";
export {
  findUniqueOfficialChain,
  findAdoptedHostState,
  proveStableOfficialState,
  loadReviewedProfile,
  waitOfficialReplacement,
} from "./internal/process/official-chain.ts";
export {
  runTransientAdoptOperation,
  runTransientAdoptDeactivate,
  canHandoffAdopt,
  officialWouldSpawn,
  readAdoptOpState,
  writeAdoptOpState,
  adoptJournalNeedsRecovery,
  settleStaleAdoptJournal,
} from "./internal/process/transient-adopt.ts";
export { runObserveOrIdentityInject, type InjectContext } from "./internal/process/inject.ts";
export { observeAndHeal } from "./internal/process/watchdog.ts";
export {
  resolveRuntimeHelpers,
  RUNTIME_HELPER_FILES,
} from "./internal/process/helpers/runtime-helpers.ts";

export {
  parseRuntimeStartMode,
  prepareRuntimeStart,
  watchdogRequiredForStart,
  type RuntimeStartMode,
  type RuntimeStartResult,
} from "./internal/roots/command.runtime.ts";
export {
  runWatchdogTick,
  runWatchdogCutover,
  runManualReadopt,
  WATCHDOG_MUTATION_BUDGET,
  WATCHDOG_OPERATION_ID,
  type ManualReadoptInput,
  type WatchdogTickResult,
} from "./internal/roots/controller.runtime.ts";

export { probeModeldHealth, modeldSocketPath } from "./internal/wire/modeld-probe.node.ts";

import { runtimeNotReady } from "@grokbox/runtime-kernel/contract";

/** T26 composition boundary. POC createModeld / stub Unix server are revoked. */
export function startInferenceServer(): never {
  return runtimeNotReady("modeld inference", "T26");
}

/** @deprecated Use startInferenceServer; kept so CLI can name the revoked entry. */
export function startStubModeldServer(): never {
  return startInferenceServer();
}

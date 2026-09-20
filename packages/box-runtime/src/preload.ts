import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { writeHostCompileMarker } from "./internal/host/compile-marker.node.ts";
import { installNativeCheckpointWorkerHook, NATIVE_CHECKPOINT_PAIR } from "./internal/host/native-checkpoint-worker-hook.ts";
import { createNativeCurrentStateOwner, NATIVE_CURRENT_STATE_SYMBOL } from "./internal/host/native-current-state-owner.ts";
import { createNativeCurrentStateRpc } from "./internal/host/native-current-state-rpc.ts";
import { NATIVE_CHECKPOINT_SLICE_IDS, NATIVE_CURRENT_STATE_SLICE_IDS, CONTEXT_SLICE_IDS } from "./internal/host/profile.ts";
import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { inspectPid } from "./internal/host/self-identity.node.ts";
import { installCompileHook } from "./internal/host/compile-hook.ts";
import { isLiveHostPath, LIVE_HOST_BUNDLE } from "./internal/host/live-slices.ts";
import { bindHostSessionHook } from "./internal/host/session-hook.ts";
import { createRunObserver, HOST_RUN_OBSERVATION_SYMBOL } from "./internal/host/run-observation.ts";
import { appendHostJournal as appendHostJournalAtRoot } from "./internal/host/terminal-journal.node.ts";
import { createAlertObserver, HOST_ALERT_OBSERVATION_SYMBOL } from "./internal/host/alert-observation.ts";
import { createServerActivityObserver, HOST_SERVER_ACTIVITY_SYMBOL } from "./internal/host/server-activity-observation.ts";
import { deferManagedHostResume } from "./internal/host/selection.node.ts";
import { hostContextClient } from "./internal/host/context-client.node.ts";
import { createHostContextControl, HOST_CONTEXT_CONTROL_SYMBOL } from "./internal/host/context-control.node.ts";
import { bindHostCompactHook, isHostManagedRootActive, recordHostManagedStepFailure, stateSystemCompactHookOptions } from "./internal/host/compact.ts";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "./internal/host/ownership-read.ts";
import { bindReceiverModel, HOST_RECEIVER_MODEL_SYMBOL } from "./internal/host/receiver-model.node.ts";
import { bindHostProfileTitle, HOST_PROFILE_TITLE_SYMBOL } from "./internal/host/title-marker.ts";
import { wrapHostAuxExecutor } from "./internal/host/aux-purpose.ts";
import { bindCompiledHost } from "./internal/host/host-binding.ts";
import { asHostPromptSession, createStreamingPromptSession, InvalidHostStateError, isHostManagedFailure } from "./internal/host/session.ts";
import { HOST_AUX_SYMBOL, HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, HOST_MANAGED_FAILURE_SYMBOL, HOST_MANAGED_STEP_FAILURE_SYMBOL, PACKED_SESSION_SYMBOL, ROUTE_SESSION_SYMBOL, HOST_RESUME_GATE_SYMBOL, type PatchProfile } from "./internal/host/profile.ts";

const target = process.env.GROKBOX_HOST_BUNDLE ?? LIVE_HOST_BUNDLE;
const profilePath = process.env.GROKBOX_PATCH_PROFILE;
const allowLiveHost = process.env.GROKBOX_ALLOW_LIVE_HOST === "1";
const mode = process.env.GROKBOX_PRELOAD_MODE ?? "identity";
const markerPath = process.env.GROKBOX_PRELOAD_MARKER;
const operationId = process.env.GROKBOX_OPERATION_ID;
const runRoot = process.env.GROKBOX_RUN_ROOT ?? join(homedir(), ".grokbox", "run");
const durableRoot = process.env.GROKBOX_BOX_RUNTIME_ROOT ?? "/workspace/.grokbox/box-runtime";
// Every native observer uses this installation's explicit policy source.
const appendHostJournal = (root: string, event: unknown) => appendHostJournalAtRoot(root, event, { configurationRoot: durableRoot });

function requiredPreloadPath(): string | null {
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--require" && argv[i + 1]) return argv[i + 1]!;
    if (part.startsWith("--require=")) return part.slice("--require=".length);
  }
  const opt = process.env.NODE_OPTIONS ?? "";
  const matched = opt.match(/--require(?:=|\s+)(\S+)/);
  return matched?.[1] ?? null;
}

const liveBlocked = isLiveHostPath(target) && !allowLiveHost;
const admittedMode = mode === "identity" || mode === "route" ? mode : null;

if (!liveBlocked && profilePath && admittedMode && operationId) {
  const bytes = readFileSync(profilePath);
  const profile = JSON.parse(bytes.toString("utf8")) as PatchProfile;
  const profileSha256 = sha256Bytes(bytes);
  // Capture the loaded module generation before executing Host code or re-reading mutable paths.
  const preloadPath = typeof __filename === "string" ? __filename : requiredPreloadPath();
  const preloadSha256 = preloadPath ? sha256Bytes(readFileSync(preloadPath)) : undefined;
  const self = inspectPid(process.pid);
  const binding = self ? bindCompiledHost(self, operationId, { profileId: profile.profileId, profileSha256,
    sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 }) : undefined;
  (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTE_SESSION_SYMBOL)] = bindHostSessionHook({
    mode: admittedMode,
    durableRoot,
    runRoot,
    binding,
    compile: {
      profileId: profile.profileId,
      profileSha256,
      sourceSha256: profile.sourceSha256,
      transformedSha256: profile.transformedSourceSha256,
    },
  });
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)] = bindHostOwnershipRead({
    ...(self ? { loaded: { pid: self.pid, start: self.start, profileSha256,
      sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 } } : {}),
  });
  if (profile.slices.some(slice => slice.id === "receiver-native-model-preview")) {
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_RECEIVER_MODEL_SYMBOL)] = bindReceiverModel({ durableRoot, mode: admittedMode,
      profileRevision: profileSha256, sourceRevision: profile.sourceSha256, preloadRevision: preloadSha256 });
  }
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_PROFILE_TITLE_SYMBOL)] = bindHostProfileTitle({ durableRoot });
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_RESUME_GATE_SYMBOL)] =
    (agentId: unknown, allowed: unknown) => admittedMode === "route" && deferManagedHostResume(durableRoot, agentId, allowed);
  // Child Node processes may inherit preload configuration. Allocate an Alert
  // observer only when this process actually compiles the qualified target.
  let activityObserverInstalled = false;
  const installServerActivityObservation = () => {
    if (activityObserverInstalled) return;
    activityObserverInstalled = true;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_SERVER_ACTIVITY_SYMBOL)] = createServerActivityObserver({
      generation: binding?.generationId ?? "unbound",
      instrumented: ["server-activity-live-observation", "server-activity-expiry-observation"].every(id => profile.slices.some(slice => slice.id === id)),
      emit: event => { void appendHostJournal(runRoot, event); },
    });
  };
  let alertObserverInstalled = false;
  const installAlertObservation = () => {
    if (alertObserverInstalled || admittedMode !== "route") return;
    alertObserverInstalled = true;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ALERT_OBSERVATION_SYMBOL)] = createAlertObserver({
      observerRole: "host_target",
      generation: binding?.generationId ?? "unbound", nativeSourceSha256: profile.sourceSha256, preloadSha256,
      capture: {
        manager: profile.slices.some(slice => slice.id === "alert-manager-observation"),
        mainDecision: profile.slices.some(slice => slice.id === "alert-main-decision"),
        automationDecision: ["alert-automation-decision", "alert-automation-throttle"].every(id => profile.slices.some(slice => slice.id === id)),
        inputCleanup: profile.slices.some(slice => slice.id === "alert-input-cleanup"),
      },
      emit: event => { void appendHostJournal(runRoot, event); },
    });
  };
  if (admittedMode === "route") {
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_RUN_OBSERVATION_SYMBOL)] = createRunObserver({
      generation: binding?.generationId ?? "unbound", emit: event => { void appendHostJournal(runRoot, event); },
      emitTool: event => { void appendHostJournal(runRoot, event); },
      instrumented: !!binding && ["run-queue-observation", "tool-execution-observation", "tool-execution-failure-observation"].every(id => profile.slices.some(slice => slice.id === id)),
    });
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_AUX_SYMBOL)] = wrapHostAuxExecutor;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_CONTEXT_CONTROL_SYMBOL)] = createHostContextControl({
    mode: admittedMode, runRoot, durableRoot, binding,
    compile: { profileId: profile.profileId, profileSha256, sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 },
  });
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_COMPACT_SYMBOL)] = bindHostCompactHook({ ...stateSystemCompactHookOptions(),
      context: hostContextClient({ mode: admittedMode, runRoot, durableRoot, binding, compile: { profileId: profile.profileId,
        profileSha256, sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 } }),
    });
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_STEP_SYMBOL)] = isHostManagedRootActive;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)] = isHostManagedFailure;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_STEP_FAILURE_SYMBOL)] = recordHostManagedStepFailure;
  }
  if (binding && profile.sourceSha256 === NATIVE_CHECKPOINT_PAIR.host
    && [...NATIVE_CHECKPOINT_SLICE_IDS, ...NATIVE_CURRENT_STATE_SLICE_IDS, ...CONTEXT_SLICE_IDS].every(id => profile.slices.some(slice => slice.id === id))) {
    const currentState = createNativeCurrentStateOwner({
      qualification: { hostSourceSha: profile.sourceSha256, nativeSchema: NATIVE_CHECKPOINT_PAIR.schema }, generation: binding.generationId });
    (globalThis as Record<symbol, unknown>)[Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)] = Object.assign(currentState, {
      call: createNativeCurrentStateRpc(currentState, profileSha256) });
  }
  // Worker threads inherit this preload. Only the exact independently reviewed
  // Host/worker pair with all client slices opts into the finite transaction
  // protocol. Existing workers advertise no capability and are never sent it.
  installNativeCheckpointWorkerHook({ targetPath: join(dirname(target), "agent-isolation", "agent-store-worker.cjs"),
    hostSourceSha: profile.sourceSha256,
    enabled: NATIVE_CHECKPOINT_SLICE_IDS.every(id => profile.slices.some(slice => slice.id === id)) });
  installCompileHook({
    targetPath: target,
    profile,
    argv: process.argv,
    allowLiveHost,
    onTransforming: () => { installAlertObservation(); installServerActivityObservation(); },
    onCompilation: (actual) => {
      // Workers and inherited child preloads cannot certify a main Host load.
      // The receipt records actual evaluated bytes, never the desired profile
      // hash as a substitute for a rejected transformation.
      if (!markerPath || !isMainThread || !self || !preloadSha256 || resolve(process.argv[1] ?? "") !== resolve(target)) return;
      writeHostCompileMarker(markerPath, operationId, profile.profileId, {
        version: 1, observationId: randomUUID(), at: new Date().toISOString(), pid: self.pid, start: self.start, uid: self.uid,
        operationDigest: sha256Text(operationId), rootDigest: sha256Text(resolve(durableRoot)), targetDigest: sha256Text(resolve(target)),
        exeDigest: sha256Text(self.exe), argvDigest: sha256Text(canonicalJson(self.cmdline)),
        mode: admittedMode, ...actual, profileDigest: profileSha256, preloadDigest: preloadSha256,
      });
    },
  });
}

/** Opt-in packed test factory. Default --require does not export this. Forbidden with live Host. */
if (process.env.GROKBOX_PACKED_SESSION_FACTORY === "1" && process.env.GROKBOX_ALLOW_LIVE_HOST !== "1") {
  (globalThis as Record<symbol, unknown>)[Symbol.for(PACKED_SESSION_SYMBOL)] = {
    asHostPromptSession,
    createStreamingPromptSession,
    InvalidHostStateError,
    // Same explicit test-only/live-excluded boundary as the session factory.
    // These are the bundled production functions, not substitute gate logic.
    bindHostSessionHook,
    bindHostCompactHook,
    stateSystemCompactHookOptions,
    hostContextClient,
    createHostContextControl,
    bindHostOwnershipRead,
    bindReceiverModel,
    deferManagedHostResume,
    isHostManagedFailure,
  };
}

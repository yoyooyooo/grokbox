import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { inspectPid } from "./internal/host/self-identity.node.ts";
import { installCompileHook } from "./internal/host/compile-hook.ts";
import { isLiveHostPath, LIVE_HOST_BUNDLE } from "./internal/host/live-slices.ts";
import { bindHostSessionHook } from "./internal/host/session-hook.ts";
import { createRunObserver, HOST_RUN_OBSERVATION_SYMBOL } from "./internal/host/run-observation.ts";
import { appendHostJournal } from "./internal/host/terminal-journal.node.ts";
import { createAlertObserver, HOST_ALERT_OBSERVATION_SYMBOL } from "./internal/host/alert-observation.ts";
import { createServerActivityObserver, HOST_SERVER_ACTIVITY_SYMBOL } from "./internal/host/server-activity-observation.ts";
import { deferManagedHostResume } from "./internal/host/selection.node.ts";
import { bindHostCompactHook, isHostManagedRootActive, recordHostManagedStepFailure, stateSystemCompactHookOptions } from "./internal/host/compact.ts";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "./internal/host/ownership-read.ts";
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
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)] = bindHostOwnershipRead();
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
    });
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_AUX_SYMBOL)] = wrapHostAuxExecutor;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_COMPACT_SYMBOL)] = bindHostCompactHook(stateSystemCompactHookOptions());
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_STEP_SYMBOL)] = isHostManagedRootActive;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)] = isHostManagedFailure;
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_MANAGED_STEP_FAILURE_SYMBOL)] = recordHostManagedStepFailure;
  }
  installCompileHook({
    targetPath: target,
    profile,
    argv: process.argv,
    allowLiveHost,
    onTransforming: () => { installAlertObservation(); installServerActivityObservation(); },
    onTransformed: (actual) => {
      if (!markerPath) return;
      const staging = `${markerPath}.${randomUUID()}.tmp`;
      writeFileSync(
        staging,
        `${JSON.stringify({
          operationId,
          pid: process.pid,
          start: inspectPid(process.pid)?.start,
          mode: admittedMode,
          transformed: true,
          compiled: true,
          modeld: false,
          compile: { profileId: profile.profileId, profileSha256, ...actual },
          ...(preloadSha256 ? { preloadSha256 } : {}),
        })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(staging, markerPath);
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
    bindHostOwnershipRead,
    deferManagedHostResume,
    isHostManagedFailure,
  };
}

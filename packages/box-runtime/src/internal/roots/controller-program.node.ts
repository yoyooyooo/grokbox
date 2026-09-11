import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { sha256Bytes, sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import {
  ControlResources,
  type ControllerReceipt,
  type ControllerRequest,
  type FrozenControllerCommand,
  type LeaseDecision,
  type OperationPrefix,
  type OperationRecord,
} from "@grokbox/runtime-kernel/ports";
import { parseDesiredFile, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { expectedCompileReceipt, compileReceiptAgrees, type CompileReceipt } from "../host/compile-receipt.ts";
import { LIVE_HOST_BUNDLE } from "../host/live-slices.ts";
import { ephemeralRuntimeRoot } from "../io/ephemeral.ts";
import { parseCoordinatorState } from "../io/coordinator-state.ts";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../io/authority.node.ts";
import { acquireExclusiveLock } from "../io/op-lock.ts";
import { coordinatorStatePath, desiredPath, modelsPath, reviewedProfilePath } from "../io/paths.ts";
import { pinLaunchProfile, parseReviewedProfile, loadDurableReviewedProfile } from "../process/profile.node.ts";
import { spawnIndependentGuardian } from "../process/guardian-process.ts";
import { identityLaunchFields } from "../process/h3-identity.ts";
import {
  createLiveH3AdoptPorts,
  liveDiskSha,
  readGatewayPid,
  reviewOfficialAdoptCapability,
} from "../process/h3-live.ts";
import { decideH3LaunchStrategy } from "../process/launch-strategy.ts";
import { fillMissingLaunchEnv, IDENTITY_LAUNCH_ALLOWLIST } from "../process/launch.node.ts";
import { linuxProcessPort, roleOf, readNamedProcEnv } from "../process/linux.node.ts";
import { proveStableOfficialState, type RoleClassifier } from "../process/official-chain.ts";
import type { ProcessPort } from "../process/process-port.ts";
import { resolvePreloadPath } from "../process/helpers/runtime-helpers.ts";
import { runTransientAdoptOperation, writeAdoptOpState } from "../process/transient-adopt.ts";
import type { IdentityMarker, IdentityOpResult } from "../process/identity-op.ts";
import { isDeepStrictEqual } from "node:util";

export const liveMutationAttempts = { signal: 0, spawn: 0, guardian: 0 };

let lastLiveAdopt: IdentityOpResult | null = null;

export function resetLiveMutationAttempts(): void {
  liveMutationAttempts.signal = 0;
  liveMutationAttempts.spawn = 0;
  liveMutationAttempts.guardian = 0;
  lastLiveAdopt = null;
}

export function diskPreloadSha256(path = resolvePreloadPath()): string | null {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return null;
  }
}

export function reviewedProfileSha256(boxRoot: string): string | null {
  const profile = loadDurableReviewedProfile(boxRoot);
  return profile ? expectedCompileReceipt(profile).profileSha256 : null;
}

export function controllerOperationId(
  intent: "apply" | "reconcile",
  boxRoot: string,
  generation?: { preloadSha256?: string; profileSha256?: string },
): string {
  return sha256Text(canonicalJson({
    intent,
    boxRoot,
    ...(generation?.preloadSha256 ? { preloadSha256: generation.preloadSha256 } : {}),
    ...(generation?.profileSha256 ? { profileSha256: generation.profileSha256 } : {}),
  }));
}

type StoreFile = Record<string, OperationRecord>;
const RECORD_STATES = new Set(["reserved", "running", "unknown", "terminal"]);
const HEX64 = /^[a-f0-9]{64}$/;

function storePath(boxRoot: string): string {
  return join(boxRoot, "state", "controller-operations.json");
}

function lockPath(boxRoot: string): string {
  return join(boxRoot, "state", "controller-operations.lock");
}

function parsePrefix(value: unknown): OperationPrefix | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.signaled !== "boolean" || typeof row.spawned !== "boolean" || typeof row.guardian !== "boolean") {
    return undefined;
  }
  return { signaled: row.signaled, spawned: row.spawned, guardian: row.guardian };
}

function parseStore(raw: string): { ok: true; store: StoreFile } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const store: StoreFile = {};
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id || !rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false };
    const row = rec as Record<string, unknown>;
    if (typeof row.fingerprint !== "string" || row.fingerprint.length === 0) return { ok: false };
    if (typeof row.state !== "string" || !RECORD_STATES.has(row.state)) return { ok: false };
    store[id] = {
      fingerprint: row.fingerprint,
      state: row.state as OperationRecord["state"],
      ...(parsePrefix(row.prefix) ? { prefix: parsePrefix(row.prefix) } : {}),
    };
  }
  return { ok: true, store };
}

function loadStore(boxRoot: string): { ok: true; store: StoreFile } | { ok: false; reason: "store-corrupt" } {
  const path = storePath(boxRoot);
  if (!existsSync(path)) return { ok: true, store: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "store-corrupt" };
  }
  const parsed = parseStore(raw);
  if (!parsed.ok) return { ok: false, reason: "store-corrupt" };
  return parsed;
}

function saveStore(boxRoot: string, store: StoreFile): void {
  const path = storePath(boxRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readOptionalJson(path: string): { present: false } | { present: true; value: unknown } | { present: true; invalid: true } {
  if (!existsSync(path)) return { present: false };
  try {
    return { present: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { present: true, invalid: true };
  }
}

export type LiveAdmissionPorts = {
  processes: ProcessPort;
  classify: RoleClassifier;
  gatewayPid: () => number | null;
  hostBundlePath: string;
  readHostSha: () => string | null;
};

export function defaultLiveAdmissionPorts(): LiveAdmissionPorts {
  return {
    processes: linuxProcessPort(),
    classify: roleOf,
    gatewayPid: () => readGatewayPid(),
    hostBundlePath: LIVE_HOST_BUNDLE,
    readHostSha: () => {
      try {
        return sha256Bytes(readFileSync(LIVE_HOST_BUNDLE));
      } catch {
        return null;
      }
    },
  };
}

function inspectLiveHost(
  profileSourceSha: string,
  live: LiveAdmissionPorts,
): { ok: true } | { ok: false; reason: string } {
  const sha = live.readHostSha();
  if (sha == null) return { ok: false, reason: "host-bundle-missing" };
  if (sha !== profileSourceSha) return { ok: false, reason: "source-mismatch" };
  const proven = proveStableOfficialState(live.processes, live.classify, { gatewayPid: live.gatewayPid() });
  if (!proven.ok) {
    return { ok: false, reason: proven.code === "missing-role" ? "host-missing" : proven.code };
  }
  const host = proven.chain.host;
  const observed = live.processes.inspect(host.pid);
  if (!observed || observed.start !== host.start || observed.uid !== host.uid) {
    return { ok: false, reason: "identity-mismatch" };
  }
  const names = host.cmdline.join(" ");
  if (!names.includes("host-main.cjs")) return { ok: false, reason: "topology-mismatch" };
  if (live.gatewayPid() !== host.pid) return { ok: false, reason: "gateway-mismatch" };
  return { ok: true };
}

/** Durable facts plus optional live Host identity. Omit `live` to skip /proc (tests). */
export function inspectControllerFacts(
  boxRoot: string,
  live?: LiveAdmissionPorts | null,
): { ok: boolean; reason: string | null; strategy?: "direct" | "transient" } {
  try {
    if (!existsSync(desiredPath(boxRoot))) return { ok: false, reason: "missing-desired" };
    const desired = parseDesiredFile(JSON.parse(readFileSync(desiredPath(boxRoot), "utf8")));
    if (!existsSync(modelsPath(boxRoot))) return { ok: false, reason: "missing-models" };
    parseModelsFile(JSON.parse(readFileSync(modelsPath(boxRoot), "utf8")));
    if (!existsSync(reviewedProfilePath(boxRoot))) return { ok: false, reason: "missing-source" };
    let profileJson: unknown;
    try {
      profileJson = JSON.parse(readFileSync(reviewedProfilePath(boxRoot), "utf8"));
    } catch {
      return { ok: false, reason: "invalid-source" };
    }
    let profile;
    try {
      profile = parseReviewedProfile(profileJson);
    } catch {
      return { ok: false, reason: "unreviewed-profile" };
    }
    if (!HEX64.test(profile.sourceSha256) || !HEX64.test(profile.transformedSourceSha256)) {
      return { ok: false, reason: "invalid-compile" };
    }
    const compilePath = join(boxRoot, "state", "compile-receipt.json");
    const compile = readOptionalJson(compilePath);
    if (compile.present) {
      if ("invalid" in compile) return { ok: false, reason: "compile-mismatch" };
      const expected = expectedCompileReceipt(profile);
      if (!compileReceiptAgrees(compile.value as CompileReceipt, expected)) {
        return { ok: false, reason: "compile-mismatch" };
      }
    }
    const coordinator = readOptionalJson(coordinatorStatePath(boxRoot));
    if (coordinator.present) {
      if ("invalid" in coordinator) return { ok: false, reason: "identity-invalid" };
      try {
        parseCoordinatorState(coordinator.value);
      } catch {
        return { ok: false, reason: "identity-invalid" };
      }
    }
    if (desired.mode === "disabled") return { ok: false, reason: "desired-disabled" };
    const strategy = desired.mode === "route" ? "transient" as const : "direct" as const;
    if (!live) return { ok: false, reason: "host-missing", strategy };
    const liveHost = inspectLiveHost(profile.sourceSha256, live);
    if (!liveHost.ok) return { ok: false, reason: liveHost.reason, strategy };
    return { ok: true, reason: null, strategy };
  } catch {
    return { ok: false, reason: "preflight-invalid" };
  }
}

function emptyAdoptResult(code: string): IdentityOpResult {
  return {
    ok: false,
    recoveryRequired: true,
    code,
    signaled: false,
    diskShaBefore: "",
    diskShaAfter: "",
    census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
    coverage: "none",
  };
}

export function observedAdoptMarkerMatches(
  marker: { pid?: number; start?: number; operationId?: string; compiled?: boolean; transformed?: boolean; mode?: string; preloadSha256?: string } | null,
  host: { pid: number; start: number },
  operationId: string,
  preloadSha256?: string,
): boolean {
  return Boolean(
    marker &&
    marker.pid === host.pid &&
    marker.start === host.start &&
    marker.operationId === operationId &&
    marker.compiled === true &&
    marker.transformed === true &&
    marker.mode === "route" &&
    (preloadSha256 == null || marker.preloadSha256 === preloadSha256),
  );
}

/** Reuse only the generation that actually compiled this profile with this preload. */
export function observedAdoptGenerationMatches(
  marker: IdentityMarker | null,
  host: { pid: number; start: number },
  profile: NonNullable<ReturnType<typeof loadDurableReviewedProfile>>,
  preloadSha256: string,
): boolean {
  return Boolean(marker && typeof marker.operationId === "string" && marker.operationId.length > 0 &&
    observedAdoptMarkerMatches(marker, host, marker.operationId, preloadSha256) &&
    compileReceiptAgrees(marker.compile, expectedCompileReceipt(profile)));
}

function readMarkerFile(path: string): IdentityMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IdentityMarker;
  } catch {
    return null;
  }
}

async function commitObservedAdopt(input: {
  command: FrozenControllerCommand;
  ephemeralRoot: string;
  host: import("../process/process-port.ts").ProcessIdentity;
  supervisor: import("../process/process-port.ts").ProcessIdentity;
  marker: IdentityMarker;
  profile: NonNullable<ReturnType<typeof loadDurableReviewedProfile>>;
}): Promise<IdentityOpResult> {
  const sha = liveDiskSha();
  const compile = input.marker.compile;
  if (!compile || compile.sourceSha256 !== sha) return emptyAdoptResult("compile-mismatch");
  const expected = expectedCompileReceipt(input.profile);
  if (!compileReceiptAgrees(compile, expected)) return emptyAdoptResult("compile-mismatch");
  const proposed: CoverageAttestation = {
    coverage: "attested",
    diskSha: compile.sourceSha256,
    pid: input.host.pid,
    start: input.host.start,
    identity: input.host,
    at: new Date().toISOString(),
    launchMode: "transient-adopt",
    operationId: input.marker.operationId,
    profileId: compile.profileId,
    transformedSha: compile.transformedSha256,
    compile: {
      profileId: compile.profileId,
      profileSha256: compile.profileSha256,
      sourceSha256: compile.sourceSha256,
      transformedSha256: compile.transformedSha256,
    },
    mode: "route",
    modeld: true,
  };
  await writeAttestation(input.ephemeralRoot, proposed);
  const record = await readAttestation(input.ephemeralRoot);
  if (!isDeepStrictEqual(record, proposed)) return emptyAdoptResult("attestation-uncommitted");
  const done = {
    launchMode: "transient-adopt" as const,
    phase: "attested" as const,
    operationId: input.marker.operationId,
    compile: proposed.compile,
    tempSupervisor: null,
    adoptingSupervisor: input.supervisor,
    host: {
      pid: input.host.pid,
      uid: input.host.uid,
      start: input.host.start,
      exe: input.host.exe,
      cmdline: input.host.cmdline,
    },
  };
  await writeAdoptOpState(input.ephemeralRoot, done);
  return {
    ok: true,
    recoveryRequired: false,
    signaled: false,
    diskShaBefore: sha,
    diskShaAfter: sha,
    census: { wrapper: 1, supervisor: 1, host: 1, tempSupervisor: 0, guardian: 0, extras: 0 },
    coverage: "attested",
    host: input.host,
    launchMode: "transient-adopt",
    committedAttestation: record!,
  };
}

async function applyLiveControllerAdopt(command: FrozenControllerCommand): Promise<IdentityOpResult> {
  const ephemeralRoot = ephemeralRuntimeRoot();
  const markerPath = join(ephemeralRoot, "state", "preload-marker.json");
  const overlayPath = join(ephemeralRoot, "state", "launch-env.json");
  const execPath = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
  const preloadPath = resolvePreloadPath();
  const ports = createLiveH3AdoptPorts({
    markerPath,
    preloadNeedle: preloadPath,
    overlayPath,
    execPath,
    hostBundle: LIVE_HOST_BUNDLE,
  });
  const proven = proveStableOfficialState(ports.processes, ports.classify, { gatewayPid: ports.readGatewayPid() });
  if (!proven.ok) return emptyAdoptResult(proven.code === "missing-role" ? "host-missing" : proven.code);
  const profile = loadDurableReviewedProfile(command.boxRoot);
  if (!profile) return emptyAdoptResult("missing-source");
  const host = proven.chain.host;
  const supervisor = proven.chain.supervisor;
  const marker = readMarkerFile(markerPath);
  const preloadSha = diskPreloadSha256(preloadPath);
  if (!preloadSha) return emptyAdoptResult("preload-unavailable");
  // A matching pathname (or today's bytes at that path) says nothing about already-loaded code.
  if (proven.mode === "transient-adopt" && ports.hasGrokboxPreload(host) &&
      observedAdoptGenerationMatches(marker, host, profile, preloadSha)) {
    return await commitObservedAdopt({ command, ephemeralRoot, host, supervisor, marker: marker!, profile });
  }
  const strategy = decideH3LaunchStrategy({
    supervisor,
    reviewedAdoptCapability: reviewOfficialAdoptCapability(supervisor),
  });
  const canSpawnTransient = command.strategy === "transient" && strategy === "transient-adopt-candidate";
  if (!canSpawnTransient) {
    if (proven.mode === "transient-adopt" && marker && !observedAdoptMarkerMatches(marker, host, command.operationId, preloadSha ?? undefined)) {
      return emptyAdoptResult("marker-generation-mismatch");
    }
    if (proven.mode !== "direct-launch") return emptyAdoptResult("adopt-unproven");
    if (command.strategy === "direct" && strategy !== "direct-overlay") {
      return emptyAdoptResult("launch-strategy-unavailable");
    }
    if (command.strategy === "transient") return emptyAdoptResult("launch-strategy-unavailable");
  }
  const launchSource = fillMissingLaunchEnv(
    readNamedProcEnv(host.pid, IDENTITY_LAUNCH_ALLOWLIST),
    readNamedProcEnv(supervisor.pid, IDENTITY_LAUNCH_ALLOWLIST),
  );
  const expectedMode = command.strategy === "transient" ? "route" : "identity";
  return await runTransientAdoptOperation({
    processes: ports.processes,
    classify: ports.classify,
    reviewedProfile: profile,
    diskSha: liveDiskSha,
    ephemeralRoot,
    operationId: command.operationId,
    readMarker: () => null,
    waitGone: ports.waitHostGone,
    waitReady: ports.waitReady,
    prepareTempLaunch: async (admitted) => {
      const profilePath = await pinLaunchProfile(ephemeralRoot, admitted);
      const launched = identityLaunchFields({
        source: launchSource,
        preloadPath,
        profilePath,
        markerPath,
        operationId: command.operationId,
        hostBundle: LIVE_HOST_BUNDLE,
        mode: expectedMode,
        durableRoot: command.boxRoot,
        runRoot: ephemeralRoot,
      });
      if (!launched.ok) throw new Error(launched.code);
      await ports.applyLaunchEnv(launched.env);
    },
    spawnTempSupervisor: ports.spawnTempSupervisor,
    waitNewHost: ports.waitNewHost,
    readGatewayPid: ports.readGatewayPid,
    adoptProveMs: ports.adoptProveMs,
    armGuardian: async (frozen) => {
      const guardian = await spawnIndependentGuardian({
        frozen,
        deadlineMs: ports.guardianDeadlineMs ?? 8000,
        stateDir: ephemeralRoot,
        execPath,
      });
      if (!guardian.armed) return { ok: false };
      return { ok: true, release: guardian.release };
    },
    expectedMode,
    hasGrokboxPreload: ports.hasGrokboxPreload,
    now: () => Date.now(),
  });
}

export function liveControlResourcesLayer(): Layer.Layer<ControlResources> {
  return Layer.succeed(ControlResources, {
    lease: (input: FrozenControllerCommand) => Effect.gen(function* () {
      const locked = yield* Effect.acquireRelease(
        Effect.tryPromise(() => acquireExclusiveLock(lockPath(input.boxRoot))),
        (acquired) => acquired.ok ? Effect.promise(() => acquired.lock.release()) : Effect.void,
      );
      if (!locked.ok) return { status: "busy" as const } satisfies LeaseDecision;
      const loaded = loadStore(input.boxRoot);
      if (!loaded.ok) return { status: "corrupt" as const } satisfies LeaseDecision;
      const existing = loaded.store[input.operationId];
      let decision: LeaseDecision = { status: "acquired" };
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) decision = { status: "conflict" };
        else if (existing.state === "terminal") decision = { status: "duplicate" };
        else if (existing.state === "unknown") {
          const live = defaultLiveAdmissionPorts();
          const proven = proveStableOfficialState(live.processes, live.classify, { gatewayPid: live.gatewayPid() });
          decision = proven.ok && proven.mode === "transient-adopt"
            ? { status: "acquired" }
            : { status: "uncertain" };
        }
        else decision = { status: "busy" };
      }
      if (decision.status !== "acquired") return decision;
      loaded.store[input.operationId] = { fingerprint: input.fingerprint, state: "running", prefix: existing?.prefix };
      yield* Effect.try({
        try: () => saveStore(input.boxRoot, loaded.store),
        catch: (error) => error,
      });
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        try {
          const latest = loadStore(input.boxRoot);
          if (!latest.ok) return;
          const row = latest.store[input.operationId];
          if (row && row.state === "running") {
            latest.store[input.operationId] = { ...row, state: "unknown" };
            saveStore(input.boxRoot, latest.store);
          }
        } catch {
          /* lock release still runs */
        }
      }));
      return decision;
    }),
    peek: (input: { operationId: string; boxRoot: string }) => Effect.try({
      try: () => {
        const loaded = loadStore(input.boxRoot);
        if (!loaded.ok) throw new Error("store-corrupt");
        return loaded.store[input.operationId] ?? null;
      },
      catch: (error) => error,
    }),
    settle: (input: { operationId: string; boxRoot: string; state: "running" | "unknown" | "terminal"; prefix?: OperationPrefix }) => Effect.try({
      try: () => {
        const loaded = loadStore(input.boxRoot);
        if (!loaded.ok) throw new Error("store-corrupt");
        const existing = loaded.store[input.operationId];
        if (existing) {
          loaded.store[input.operationId] = { ...existing, state: input.state, prefix: input.prefix ?? existing.prefix };
          saveStore(input.boxRoot, loaded.store);
        }
      },
      catch: (error) => error,
    }),
    preflight: (input: FrozenControllerCommand) => Effect.sync(() => inspectControllerFacts(input.boxRoot, defaultLiveAdmissionPorts())),
    recheck: (input: FrozenControllerCommand) => Effect.sync(() => inspectControllerFacts(input.boxRoot, defaultLiveAdmissionPorts())),
    signal: (input: FrozenControllerCommand) => Effect.tryPromise({
      try: async () => {
        liveMutationAttempts.signal += 1;
        lastLiveAdopt = await applyLiveControllerAdopt(input);
        return { signaled: lastLiveAdopt.signaled === true };
      },
      catch: (error) => error,
    }),
    spawn: (input: FrozenControllerCommand) => Effect.tryPromise({
      try: async () => {
        liveMutationAttempts.spawn += 1;
        lastLiveAdopt = await applyLiveControllerAdopt(input);
        return { spawned: lastLiveAdopt.signaled === true };
      },
      catch: (error) => error,
    }),
    armGuardian: (_input: FrozenControllerCommand) => Effect.sync(() => {
      liveMutationAttempts.guardian += 1;
      return { guardian: lastLiveAdopt?.ok === true || lastLiveAdopt?.signaled === true };
    }),
    wait: (_input: FrozenControllerCommand) => Effect.void,
    commit: (_input: FrozenControllerCommand) => Effect.succeed({ committed: lastLiveAdopt?.ok === true }),
  });
}

export async function startControlOperation(request: ControllerRequest): Promise<ControllerReceipt> {
  return Effect.runPromise(
    Effect.scoped(runControllerOperation(request).pipe(Effect.provide(liveControlResourcesLayer()))),
  );
}

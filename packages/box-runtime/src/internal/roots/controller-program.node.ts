import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
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
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { runtimeDesiredFromConfig, parseConfigJson } from "@grokbox/runtime-kernel/config";
import { expectedCompileReceipt, compileReceiptAgrees, type CompileReceipt } from "../host/compile-receipt.ts";
import { LIVE_HOST_BUNDLE } from "../host/live-slices.ts";
import { ephemeralRuntimeRoot } from "../io/ephemeral.ts";
import { parseCoordinatorState } from "../io/coordinator-state.ts";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../io/authority.node.ts";
import { operationLockPath, acquireOperationLease, acquireOperationRecoveryGates, inspectOperationLease, operationOwnerState, parseOperationLeaseOwner,
  recheckOperationLease, removeRecoveredOperationLease, type OperationLeaseOwner, type OperationLeaseObservation } from "../io/operation-lease.node.ts";
import { coordinatorStatePath, runtimeConfigPath, modelsPath, reviewedProfilePath } from "../io/paths.ts";
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
import type { ProcessIdentity, ProcessPort } from "../process/process-port.ts";
import { resolveNodeRequireablePreload } from "../process/helpers/runtime-helpers.ts";
import { runTransientAdoptOperation, writeAdoptOpState } from "../process/transient-adopt.ts";
import type { IdentityMarker, IdentityOpResult } from "../process/identity-op.ts";
import { probeModeldHealth } from "../wire/modeld-probe.node.ts";
import { isDeepStrictEqual } from "node:util";

export const liveMutationAttempts = { signal: 0, spawn: 0, guardian: 0 };

export function resetLiveMutationAttempts(): void {
  liveMutationAttempts.signal = 0;
  liveMutationAttempts.spawn = 0;
  liveMutationAttempts.guardian = 0;
}

export function diskPreloadSha256(path?: string): string | null {
  try {
    return sha256Bytes(readFileSync(path ?? resolveNodeRequireablePreload()));
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
  generation?: { preloadSha256?: string; profileSha256?: string; hostGeneration?: string },
): string {
  return sha256Text(canonicalJson({
    intent,
    boxRoot,
    ...(generation?.preloadSha256 ? { preloadSha256: generation.preloadSha256 } : {}),
    ...(generation?.profileSha256 ? { profileSha256: generation.profileSha256 } : {}),
    ...(generation?.hostGeneration ? { hostGeneration: generation.hostGeneration } : {}),
  }));
}

type StoreFile = Record<string, OperationRecord & { leaseOwner?: OperationLeaseOwner }>;
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
  const store: StoreFile = Object.create(null);
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || !rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false };
    const row = rec as Record<string, unknown>;
    if (typeof row.fingerprint !== "string" || row.fingerprint.length === 0) return { ok: false };
    if (typeof row.state !== "string" || !RECORD_STATES.has(row.state)) return { ok: false };
    const leaseOwner = row.leaseOwner === undefined ? undefined : parseOperationLeaseOwner(row.leaseOwner);
    if (leaseOwner === null) return { ok: false };
    store[id] = {
      fingerprint: row.fingerprint,
      state: row.state as OperationRecord["state"],
      ...(leaseOwner ? { leaseOwner } : {}),
      ...(parsePrefix(row.prefix) ? { prefix: parsePrefix(row.prefix) } : {}),
    };
  }
  return { ok: true, store };
}

function loadStore(boxRoot: string): { ok: true; store: StoreFile } | { ok: false; reason: "store-corrupt" } {
  const path = storePath(boxRoot);
  const corrupt = () => ({ ok: false as const, reason: "store-corrupt" as const });
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { ok: true, store: Object.create(null) } : corrupt();
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > 4 * 1024 * 1024) return corrupt();
    const bytes = Buffer.alloc(before.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd), current = lstatSync(path);
    if (length !== before.size || [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino
      || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs) || current.isSymbolicLink()) return corrupt();
    const parsed = parseStore(bytes.subarray(0, length).toString("utf8"));
    return parsed.ok ? parsed : corrupt();
  } catch { return corrupt(); }
  finally { closeSync(fd); }
}

function saveStore(boxRoot: string, store: StoreFile): void {
  const path = storePath(boxRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A crash's unpublished staging file must not block the next explicit recovery
  // or be followed as a symlink. Failed staging remains non-canonical evidence.
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(store)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
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

/** Stable deduplication scope for one observed Host lifetime, not execution authority.
 * A completed apply from before an explicit stop must not absorb a later start
 * of the same artifacts. Unknown/changing identity must not mint a fresh key.
 * The controller still owns its existing lease, preflight and mutation fences. */
export function observeControllerHostGeneration(live: LiveAdmissionPorts = defaultLiveAdmissionPorts()): string | null {
  try {
    const gatewayPid = live.gatewayPid();
    const identities = uniqueObservedAdoptIdentities(live.processes, live.classify);
    if (!identities || gatewayPid !== identities.host.pid) return null;
    const { host, supervisor } = identities;
    if (!isDeepStrictEqual(live.processes.inspect(host.pid), host)
      || !isDeepStrictEqual(live.processes.inspect(supervisor.pid), supervisor)
      || live.gatewayPid() !== gatewayPid) return null;
    return sha256Text(canonicalJson({
      host: { pid: host.pid, uid: host.uid, start: host.start },
      supervisor: { pid: supervisor.pid, uid: supervisor.uid, start: supervisor.start },
    }));
  } catch {
    return null;
  }
}

/** Re-acquire an unknown operation only when the live census is a unique official chain. */
export function recoverUnknownLease(live: LiveAdmissionPorts): Extract<LeaseDecision, { status: "acquired" } | { status: "uncertain" }> {
  const gatewayPid = live.gatewayPid();
  const proven = proveStableOfficialState(live.processes, live.classify, { gatewayPid });
  return proven.ok
    && (proven.mode === "transient-adopt" || proven.mode === "direct-launch")
    && gatewayPid === proven.chain.host.pid
    ? { status: "acquired" }
    : { status: "uncertain" };
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
    if (!existsSync(runtimeConfigPath(boxRoot))) return { ok: false, reason: "missing-desired" };
    const desired = runtimeDesiredFromConfig(parseConfigJson(readFileSync(runtimeConfigPath(boxRoot), "utf8")));
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

/** Honest unique Host+supervisor from census. Missing/duplicate → null; never invent PIDs. */
export function uniqueObservedAdoptIdentities(
  processes: ProcessPort,
  classify: RoleClassifier,
): { host: ProcessIdentity; supervisor: ProcessIdentity } | null {
  let host: ProcessIdentity | null = null;
  let supervisor: ProcessIdentity | null = null;
  for (const ident of processes.list()) {
    const role = classify(ident);
    if (role === "host") {
      if (host) return null;
      host = ident;
    } else if (role === "supervisor") {
      if (supervisor) return null;
      supervisor = ident;
    }
  }
  return host && supervisor ? { host, supervisor } : null;
}

/**
 * Commit eligibility does not require prove.mode === "transient-adopt".
 * Post-handoff orphan Host (ppid ≠ supervisor) is allowed when preload + marker generation match.
 * Unique supervisor must be observed; mismatch/missing stays ineligible.
 */
export function observedAdoptCommitEligible(input: {
  marker: IdentityMarker | null;
  host: { pid: number; start: number };
  supervisor: { pid: number } | null;
  profile: NonNullable<ReturnType<typeof loadDurableReviewedProfile>>;
  preloadSha256: string;
  hasGrokboxPreload: boolean;
}): boolean {
  if (!input.supervisor || !Number.isInteger(input.supervisor.pid) || input.supervisor.pid <= 0) return false;
  if (!input.hasGrokboxPreload) return false;
  return observedAdoptGenerationMatches(input.marker, input.host, input.profile, input.preloadSha256);
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
  const preloadPath = resolveNodeRequireablePreload();
  const ports = createLiveH3AdoptPorts({
    markerPath,
    preloadNeedle: preloadPath,
    overlayPath,
    execPath,
    hostBundle: LIVE_HOST_BUNDLE,
  });
  const profile = loadDurableReviewedProfile(command.boxRoot);
  if (!profile) return emptyAdoptResult("missing-source");
  const preloadSha = diskPreloadSha256(preloadPath);
  if (!preloadSha) return emptyAdoptResult("preload-unavailable");

  const tryCommitObserved = async (): Promise<IdentityOpResult | null> => {
    const identities = uniqueObservedAdoptIdentities(ports.processes, ports.classify);
    if (!identities) return null;
    const marker = readMarkerFile(markerPath);
    if (!observedAdoptCommitEligible({
      marker,
      host: identities.host,
      supervisor: identities.supervisor,
      profile,
      preloadSha256: preloadSha,
      hasGrokboxPreload: ports.hasGrokboxPreload(identities.host),
    })) {
      return null;
    }
    return await commitObservedAdopt({
      command,
      ephemeralRoot,
      host: identities.host,
      supervisor: identities.supervisor,
      marker: marker!,
      profile,
    });
  };

  const observed = await tryCommitObserved();
  if (observed) return observed;

  const proven = proveStableOfficialState(ports.processes, ports.classify, { gatewayPid: ports.readGatewayPid() });
  if (!proven.ok) return emptyAdoptResult(proven.code === "missing-role" ? "host-missing" : proven.code);
  const host = proven.chain.host;
  const supervisor = proven.chain.supervisor;
  const marker = readMarkerFile(markerPath);
  const strategy = decideH3LaunchStrategy({
    supervisor,
    reviewedAdoptCapability: reviewOfficialAdoptCapability(supervisor),
  });
  const canSpawnTransient = command.strategy === "transient" && strategy === "transient-adopt-candidate";
  if (!canSpawnTransient) {
    if (proven.mode === "transient-adopt" && marker && !observedAdoptMarkerMatches(marker, host, command.operationId, preloadSha)) {
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
  const spawned = await runTransientAdoptOperation({
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
    modeldReady: () => probeModeldHealth(ephemeralRoot),
    now: () => Date.now(),
  });
  if (spawned.ok) return spawned;
  const after = await tryCommitObserved();
  if (after) return { ...after, signaled: spawned.signaled || after.signaled };
  return spawned;
}

export function liveControlResourcesLayer(
  live: LiveAdmissionPorts = defaultLiveAdmissionPorts(),
): Layer.Layer<ControlResources> {
  let operationAdopt: IdentityOpResult | null = null;
  return Layer.succeed(ControlResources, {
    lease: (input: FrozenControllerCommand) => Effect.gen(function* () {
      const locked = yield* Effect.acquireRelease(
        Effect.tryPromise(() => acquireOperationLease(lockPath(input.boxRoot), input.operationId)),
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
        else if (existing.state === "unknown") decision = recoverUnknownLease(live);
        else decision = { status: "busy" };
      }
      if (decision.status !== "acquired") return decision;
      loaded.store[input.operationId] = { fingerprint: input.fingerprint, state: "running", prefix: existing?.prefix, leaseOwner: locked.lock.owner };
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
        operationAdopt = await applyLiveControllerAdopt(input);
        return { signaled: operationAdopt.signaled === true };
      },
      catch: (error) => error,
    }),
    spawn: (input: FrozenControllerCommand) => Effect.tryPromise({
      try: async () => {
        liveMutationAttempts.spawn += 1;
        operationAdopt = await applyLiveControllerAdopt(input);
        return { spawned: operationAdopt.signaled === true };
      },
      catch: (error) => error,
    }),
    armGuardian: (_input: FrozenControllerCommand) => Effect.sync(() => {
      liveMutationAttempts.guardian += 1;
      return { guardian: operationAdopt?.ok === true || operationAdopt?.signaled === true };
    }),
    wait: (_input: FrozenControllerCommand) => Effect.void,
    commit: (_input: FrozenControllerCommand) => Effect.succeed({ committed: operationAdopt?.ok === true }),
  });
}

export async function startControlOperation(request: ControllerRequest): Promise<ControllerReceipt> {
  return Effect.runPromise(
    Effect.scoped(runControllerOperation(request).pipe(Effect.provide(liveControlResourcesLayer()))),
  );
}

export type OperationRecoveryReport = {
  process: "operation-recovery";
  outcome: "clear" | "ready" | "blocked" | "recovered";
  reason: string | null;
  locks: Array<OperationLeaseObservation & { name: "controller" | "identity" }>;
  operations: { running: number; unknown: number; terminal: number };
  clearedLocks: number;
  markedUnknown: number;
  signaled: false;
  adopted: false;
  replayAuthorized: false;
  next: string;
};

async function operationRecoveryFacts(boxRoot: string, runRoot: string) {
  const paths = [lockPath(boxRoot), operationLockPath(runRoot)];
  const snapshots = await Promise.all(paths.map(inspectOperationLease));
  const loaded = loadStore(boxRoot);
  const entries = loaded.ok ? Object.entries(loaded.store) : [];
  const running = entries.filter(([, row]) => row.state === "running" || row.state === "reserved");
  let reason: string | null = !loaded.ok ? "operation_store_unavailable"
    : snapshots.some(row => !["missing", "stale"].includes(row.observation.state)) ? "lock_owner_live_or_unproven" : null;
  if (!reason) for (const [, row] of running) {
    // A stale lock at the same pathname cannot supply the missing identity of
    // an older running operation. Only that operation's own captured owner can
    // justify demotion; otherwise preserve its original row and lock footprint.
    if (!row.leaseOwner || await operationOwnerState(row.leaseOwner) !== "stale") {
      reason = "operation_owner_live_or_unproven"; break;
    }
  }
  const needsRecovery = snapshots.some(row => row.observation.state === "stale") || running.length > 0;
  const report: OperationRecoveryReport = {
    process: "operation-recovery", outcome: reason ? "blocked" : needsRecovery ? "ready" : "clear", reason,
    locks: snapshots.map((snapshot, index) => ({ name: index === 0 ? "controller" : "identity", ...snapshot.observation })),
    operations: { running: running.length, unknown: entries.filter(([, row]) => row.state === "unknown").length,
      terminal: entries.filter(([, row]) => row.state === "terminal").length },
    clearedLocks: 0, markedUnknown: 0, signaled: false, adopted: false, replayAuthorized: false,
    next: reason ? "grokbox runtime status --json" : needsRecovery ? "grokbox runtime operation-recovery --confirm"
      : entries.some(([, row]) => row.state === "unknown") ? "grokbox runtime re-adopt --confirm" : "none",
  };
  return { paths, snapshots, loaded, running, report };
}

/** Metadata-only recovery, not a second adopt executor. Both physical gates
 * remain owned by this Effect Scope. A partial metadata commit leaves unknown,
 * never a fabricated attestation or permission to replay business work.
 */
export async function recoverControllerOperationState(input: { boxRoot: string; ephemeralRoot?: string; confirm?: boolean; signal?: AbortSignal }): Promise<OperationRecoveryReport> {
  const runRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  if (!isAbsolute(input.boxRoot) || !isAbsolute(runRoot)) throw new BoxRuntimeError("invalid_usage", "Operation recovery requires absolute local roots.");
  // acquireRelease deliberately masks interruption until resource ownership is
  // registered. Refuse an already-cancelled caller before that acquisition starts.
  if (input.signal?.aborted) throw new BoxRuntimeError("invalid_usage", "Operation metadata recovery was cancelled before inspection; no recovery was attempted.",
    { next: "grokbox runtime operation-recovery --json" });
  const program = Effect.gen(function* () {
    if (input.confirm !== true) return (yield* Effect.tryPromise(() => operationRecoveryFacts(input.boxRoot, runRoot))).report;
    const paths = [lockPath(input.boxRoot), operationLockPath(runRoot)];
    const gate = yield* Effect.acquireRelease(
      Effect.tryPromise(() => acquireOperationRecoveryGates(paths)),
      held => held ? Effect.promise(() => held.release()) : Effect.void,
    );
    const facts = yield* Effect.tryPromise(() => operationRecoveryFacts(input.boxRoot, runRoot));
    if (!gate) return { ...facts.report, outcome: "blocked" as const, reason: "operation_busy", next: "grokbox runtime status --json" };
    if (facts.report.outcome !== "ready" || !facts.loaded.ok) return facts.report;
    const store = facts.loaded.store;
    // Only the short commit/cleanup boundary is uninterruptible: the gate must
    // not be released while a pending unlink could still affect its successor.
    return yield* Effect.uninterruptible(Effect.tryPromise(async () => {
      for (const snapshot of facts.snapshots) await recheckOperationLease(snapshot);
      for (const [id, row] of facts.running) store[id] = { ...row, state: "unknown" };
      if (facts.running.length > 0) saveStore(input.boxRoot, store);
      for (const snapshot of facts.snapshots) await removeRecoveredOperationLease(snapshot);
      return { ...facts.report, outcome: "recovered" as const,
        locks: facts.report.locks.map(row => ({ name: row.name, state: "missing" as const, recoverable: false })),
        operations: { ...facts.report.operations, running: 0, unknown: facts.report.operations.unknown + facts.running.length },
        clearedLocks: facts.snapshots.filter(row => row.observation.state === "stale").length,
        markedUnknown: facts.running.length,
        next: "grokbox runtime re-adopt --confirm",
      };
    }));
  });
  try { return await Effect.runPromise(Effect.scoped(program), { signal: input.signal }); }
  catch {
    // Cancellation before commit has no mutation; cancellation during the short
    // uninterruptible commit may follow a metadata commit. Never promise rollback.
    throw new BoxRuntimeError("invalid_usage", "Operation metadata recovery did not return a completion receipt; metadata may already have changed. Inspect again before any adopt; no Host signal or business replay was requested.",
      { next: "grokbox runtime operation-recovery --json" });
  }
}

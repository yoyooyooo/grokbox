import { projectHostCompileReceipt } from "@grokbox/runtime-kernel/host-health";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { observeHostCompilation } from "../../src/internal/io/host-compilation.node.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { liveControlResourcesLayer, readControllerOperation, recoverControllerOperationState } from "../../src/internal/roots/controller-program.node.ts";
import { runTransientAdoptOperation } from "../../src/internal/process/transient-adopt.ts";
import { unresolvedAdoption, writeAdoptionOwner, adoptionEvidencePath } from "../../src/internal/process/adopt-evidence.ts";
import { modeldStorePorts } from "../../src/internal/io/store.node.ts";
import { expectedCompileReceipt } from "../../src/internal/host/compile-receipt.ts";
import { inspectOperationLease, operationLockPath, acquireOperationLease } from "../../src/internal/io/operation-lease.node.ts";
import { FakeProcessTree } from "../fake-tree.ts";
import type { ProcessIdentity } from "../../src/internal/process/process-port.ts";
import type { IdentityMarker, IdentityOpResult } from "../../src/internal/process/identity-op.ts";
import type { ControllerReceipt } from "@grokbox/runtime-kernel/ports";

const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const outputs: Array<{ mode: string; checkpointFaults: number; archiveFaults: number }> = [];
for (const mode of ["result-once", "result-direct", "result-persistent", "result-interrupt", "result-interrupt-persistent", "terminal-checkpoint", "archive", "inflight", "success"] as const) {
  const root = await mkdtemp(join(process.argv[2]!, `${mode}-`)), runRoot = join(root, "run"), markerPath = join(runRoot, "state", "preload-marker.json");
  await mkdir(join(runRoot, "state"), { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }));
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }); tree.spawn("host", { parent: supervisor });
  const profile = { profileId: "public-fixture", sourceSha256: "a".repeat(64), transformedSourceSha256: "b".repeat(64), slices: [] };
  const compile = expectedCompileReceipt(profile), ownership = new AbortController();
  let host: ProcessIdentity | null = null, temp: ProcessIdentity | null = null, marker: IdentityMarker | null = null, inner: IdentityOpResult | undefined;
  let checkpointFaults = 0, archiveFaults = 0;
  const beforeReturn = barrier(), allowReturn = barrier(), cancelled = barrier();
  const originalSync = fs.fsyncSync, originalRename = fs.renameSync;
  fs.fsyncSync = fd => {
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (mode.startsWith("result-") && path.startsWith(join(root, "state", "controller-operations.json."))
      && (checkpointFaults === 0 || mode.endsWith("persistent")) && JSON.parse(fs.readFileSync(path, "utf8")).original?.prefix?.diagnostic) {
      checkpointFaults++; throw Object.assign(Error("public fixture result checkpoint EIO"), { code: "EIO" });
    }
    if (mode === "terminal-checkpoint" && checkpointFaults === 0 && path.startsWith(join(root, "state", "controller-operations.json.")) && JSON.parse(fs.readFileSync(path, "utf8")).original?.state === "terminal") {
      checkpointFaults++; throw Object.assign(Error("public fixture terminal checkpoint EIO"), { code: "EIO" });
    }
    if (["archive", "inflight"].includes(mode) && path.startsWith(join(runRoot, "state", "adoptions", "original", "marker.json."))) {
      archiveFaults++; throw Object.assign(Error("public fixture marker archive EIO"), { code: "EIO" });
    }
    return originalSync(fd);
  };
  fs.renameSync = (from, to) => {
    const selected = mode === "inflight" && String(to) === join(runRoot, "state", "adopt-op.json") && JSON.parse(fs.readFileSync(from, "utf8")).phase === "attested";
    originalRename(from, to); if (selected) ownership.abort();
  };
  syncBuiltinESMExports();
  let receipt: ControllerReceipt | undefined;
  try {
    const layer = liveControlResourcesLayer({ inspect: () => ({ ok: true, reason: null, strategy: "transient" }), adopt: async (command, signal) => {
      signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      inner = await runTransientAdoptOperation({ signal, operationId: command.operationId, ephemeralRoot: runRoot, markerPath, preloadSha256: "d".repeat(64), reviewedProfile: profile,
        diskSha: () => profile.sourceSha256, processes: tree, classify: row => { const role = tree.roles().find(item => item.pid === row.pid)?.role; return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" || role === "guardian" ? role : null; }, now: Date.now,
        readMarker: () => marker, readGatewayPid: () => host?.pid ?? null, waitGone: async row => !tree.inspect(row.pid),
        spawnTempSupervisor: async () => { temp = tree.spawn("temp-supervisor"); host = tree.spawn("host", { parent: temp }); return temp; }, waitNewHost: async () => host,
        creationEvidence: () => temp && host ? { operationId: "original", tempSupervisor: { pid: temp.pid, start: temp.start }, host: { pid: host.pid, start: host.start } } : null,
        childEvidence: () => host ? { pid: host.pid, start: host.start, exitCode: null, signal: null } : undefined,
        waitReady: async () => { marker = { operationId: "original", pid: host!.pid, start: host!.start, mode: "route", compiled: true, transformed: true, modeld: false, compile, preloadSha256: "d".repeat(64) };
          await writeFile(markerPath, JSON.stringify(marker)); return mode.startsWith("result-") ? null : marker; },
        armGuardian: async () => ({ ok: true, signal: ownership.signal, end: () => ownership.signal.aborted ? "expired" : "active",
          owners: () => ({ guardian: { pid: 900001, start: 1 }, holder: { pid: 900002, start: 2 } }),
          release: () => { tree.signal(wrapper, "SIGCONT"); tree.spawn("supervisor", { parent: wrapper }); } }),
        hasGrokboxPreload: row => row.pid === host?.pid, expectedMode: "route", modeldReady: async () => true });
      if (mode.startsWith("result-interrupt")) { beforeReturn.resolve(); await allowReturn.promise; }
      return inner;
    } });
    const program = runControllerOperation({ intent: "apply", confirmed: true, operationId: "original", boxRoot: root, strategy: mode === "result-direct" ? "direct" : "transient" }).pipe(Effect.provide(layer));
    if (mode.startsWith("result-interrupt")) {
      const fiber = Effect.runFork(program); await beforeReturn.promise;
      assert.equal((await inspectOperationLease(operationLockPath(runRoot))).observation.state, "missing", "inner lease precedes outer result checkpoint");
      assert.equal((await inspectOperationLease(join(root, "state", "controller-operations.lock"))).observation.state, "live");
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
      try { await cancelled.promise; } finally { allowReturn.resolve(); await interrupted; }
    } else receipt = await Effect.runPromise(program);
  } finally { fs.fsyncSync = originalSync; fs.renameSync = originalRename; syncBuiltinESMExports(); }
  const row = readControllerOperation(root, "original")!, journal = JSON.parse(await readFile(join(runRoot, "state", "adopt-op.json"), "utf8"));
  const owner = JSON.parse(await readFile(join(runRoot, "state", "adoption-owner.json"), "utf8"));
  const authority = await modeldStorePorts(root, runRoot).authority();
  if (mode.startsWith("result-")) {
    assert.equal(inner!.code, "marker-mismatch"); assert.equal(tree.signals.length, 6);
    if (receipt) { assert.equal(receipt.reason, "marker-mismatch"); assert(receipt.signaled && receipt.spawned && receipt.guardian); assert.equal(receipt.persistence, "uncertain"); assert.notEqual(receipt.outcome, "signaled"); }
    if (mode.endsWith("persistent")) { assert(checkpointFaults > 1); assert.equal(row.state, "running"); assert.equal(row.prefix, undefined); }
    else { assert.equal(checkpointFaults, 1); assert.equal(row.state, "unknown"); assert(row.prefix?.signaled && row.prefix.spawned && row.prefix.guardian); assert.equal(row.prefix.diagnostic?.code, "marker-mismatch"); assert.equal(row.prefix.persistence, "uncertain"); }
    assert.equal(journal.failure.code, "marker-mismatch"); assert.equal(owner.state, "unresolved"); assert.notEqual(authority.state, "committed");
  } else if (mode === "terminal-checkpoint") {
    assert.equal(checkpointFaults, 1); assert.equal(receipt!.outcome, "unknown"); assert.equal(receipt!.reason, "settlement-failed");
    assert(receipt!.signaled && receipt!.spawned && receipt!.guardian); assert.equal(receipt!.persistence, "uncertain");
    assert.equal(row.state, "unknown"); assert(row.prefix!.signaled && row.prefix!.spawned && row.prefix!.guardian);
    assert.equal(row.prefix!.persistence, "uncertain"); assert.equal(authority.state, "committed", "physical adoption completed independently of the outer ledger failure");
  } else if (mode === "success") {
    assert.equal(receipt!.outcome, "signaled"); assert.equal(row.state, "terminal"); assert.equal(authority.state, "committed"); assert.equal(owner.state, "complete"); assert.match(owner.journalSha256, /^[a-f0-9]{64}$/);
    // The issued pair alone cannot pass the consumer at the pre-completion / hard-death boundary.
    await writeAdoptionOwner(runRoot, "original", "unresolved");
    assert.equal((await modeldStorePorts(root, runRoot).authority()).state, "pending");
    assert.equal(JSON.parse(await readFile(join(runRoot, "state", "adopt-op.json"), "utf8")).phase, "attested");
  } else {
    assert.equal(receipt!.outcome, "recovery-required"); assert.equal(row.state, "unknown"); assert.equal(owner.state, "unresolved");
    assert.equal(journal.phase, "recovery-required", "archive failure must not skip recovery-journal settlement");
    assert.equal(unresolvedAdoption(runRoot), "original"); assert.notEqual(authority.state, "committed");
    assert.equal(archiveFaults, mode === "archive" ? 2 : 1);
    assert.equal(receipt!.reason, mode === "archive" ? "journal-persist-failed" : "guardian-ownership-ended");
    if (mode === "inflight") assert.equal(inner!.committedAttestation?.operationId, "original");
  }
  for (const path of [operationLockPath(runRoot), join(root, "state", "controller-operations.lock")]) assert.equal((await inspectOperationLease(path)).observation.state, "missing");
  outputs.push({ mode, checkpointFaults, archiveFaults });
}
const root = await mkdtemp(join(process.argv[2]!, "compilation-")), runRoot = join(root, "run");
await mkdir(join(root, "state"), { mode: 0o700 }); await mkdir(join(runRoot, "state", "adoptions", "original"), { recursive: true, mode: 0o700 });
const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }), official = tree.spawn("host", { parent: supervisor });
const temp = tree.spawn("temp-supervisor"), host = tree.spawn("host", { parent: temp }), guardian = tree.spawn("guardian"), holder = tree.spawn("guardian");
for (const row of [temp, host, guardian, holder]) tree.kill(row);
const claim = await acquireOperationLease(join(root, "fixture-owner.lock"), "original"); assert(claim.ok);
const leaseOwner = { ...claim.lock.owner, start: String(BigInt(claim.lock.owner.start) + 1n) }; await claim.lock.release();
const ref = (row: ProcessIdentity) => ({ pid: row.pid, start: row.start });
const compile = { profileId: "fixture", profileSha256: "a".repeat(64), sourceSha256: "b".repeat(64), transformedSha256: "c".repeat(64) };
const launch = { rootDigest: sha256Text(root), targetDigest: sha256Text("/fixture/host-main.cjs"), exeDigest: sha256Text(host.exe), argvDigest: sha256Text(canonicalJson(host.cmdline)), uid: leaseOwner.uid, mode: "route" };
const diagnostic = { code: "guardian-ownership-ended", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired", child: { ...ref(host), exitCode: null, signal: null }, cleanup: [{ role: "host", ...ref(host), signalSent: true, outcome: "unproven", observed: "same-identity" }] };
const store: Record<string, unknown> = { original: { state: "unknown", fingerprint: "fixture", leaseOwner, prefix: { signaled: true, spawned: true, guardian: true, diagnostic } } };
for (let i = 0; i < 5; i++) store[`older-${i}`] = { state: "unknown", fingerprint: `older-${i}` };
const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original", tempSupervisor: temp, adoptingSupervisor: null, host: null, failure: diagnostic,
  creation: { version: 1, operationId: "original", tempSupervisor: ref(temp), host: ref(host), guardian: ref(guardian), holder: ref(holder), compile, preloadSha256: "d".repeat(64), launch } };
const observation = { version: 1, observationId: "12345678-1234-4234-8234-123456789abc", at: new Date().toISOString(), ...ref(host), ...launch, operationDigest: sha256Text("original"),
  patch: "applied", nativeCompilation: "returned", code: "compiled", sourceSha: compile.sourceSha256, candidateSha: compile.transformedSha256, profileDigest: compile.profileSha256, preloadDigest: "d".repeat(64) };
assert(projectHostCompileReceipt(observation));
const marker = { operationId: "original", ...ref(host), mode: "route", compiled: true, transformed: true, modeld: false, compile, preloadSha256: "d".repeat(64), compilationObservation: observation };
await writeFile(join(root, "state", "controller-operations.json"), JSON.stringify(store));
for (const path of [join(runRoot, "state", "adopt-op.json"), adoptionEvidencePath(runRoot, "original", "journal")]) await writeFile(path, JSON.stringify(journal));
const markerPath = join(runRoot, "state", "preload-marker.json");
await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
assert.equal((await observeHostCompilation(root, runRoot, "/fixture/host-main.cjs", { inspect: () => null })).state, "historical");
const survivor = tree.spawn("extra");
marker.compilationObservation = { ...observation, ...ref(survivor), exeDigest: sha256Text(survivor.exe), argvDigest: sha256Text(canonicalJson(survivor.cmdline)) };
assert(projectHostCompileReceipt(marker.compilationObservation));
for (const path of [markerPath, adoptionEvidencePath(runRoot, "original", "marker")]) await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
assert.equal((await observeHostCompilation(root, runRoot, "/fixture/host-main.cjs", { inspect: () => null })).state, "invalid");
await writeFile(join(runRoot, "attestation.json"), JSON.stringify({ operationId: "prior" })); await writeAdoptionOwner(runRoot, "original", "unresolved");
const recovered = await recoverControllerOperationState({ boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original" }, {
  processes: tree, classify: row => { const role = tree.roles().find(item => item.pid === row.pid)?.role; return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" || role === "guardian" ? role : null; },
  gatewayPid: () => official.pid, hasRelevantPreload: () => false,
});
assert.equal(recovered.outcome, "blocked"); assert.equal(recovered.operations.unknown, 6); assert(tree.inspect(survivor.pid));
console.log(JSON.stringify({ cases: outputs, noProviderRequests: true, structuredCompilationRejected: true }));

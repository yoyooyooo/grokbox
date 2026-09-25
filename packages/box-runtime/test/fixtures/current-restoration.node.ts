import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs, { readFileSync, readlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireRetirementObserver } from "../../src/internal/process/retirement-observer.node.ts";
import { recoverControllerOperationState } from "../../src/internal/roots/controller-program.node.ts";
import { acquireOperationLease } from "../../src/internal/io/operation-lease.node.ts";
import { restorationSnapshot } from "../../src/internal/process/restoration-proof.ts";
import { unresolvedAdoption } from "../../src/internal/process/adopt-evidence.ts";
import { startModeldProcess } from "../../src/internal/roots/modeld.runtime.ts";
import type { CurrentRestorationQualification } from "../../src/internal/process/current-restoration.ts";
import type { RestorationPorts } from "../../src/internal/process/adopt-restoration.ts";
import { FakeProcessTree } from "../fake-tree.ts";

if (!isMainThread) {
  const word = new Int32Array(workerData.shared);
  let service: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  parentPort!.on("message", async message => {
    if (message === "start") {
      try {
        service = await startModeldProcess({ durableRoot: workerData.root, runRoot: workerData.runRoot, env: {},
          fetch: Object.assign(async () => { throw Error("network forbidden"); }, { preconnect: async () => {} }) as typeof fetch });
        Atomics.store(word, 0, 2);
      } catch (error) {
        Atomics.store(word, 0, error instanceof Error && error.message.includes("daemon_socket_busy") ? 1 : -1);
      }
      Atomics.notify(word, 0);
    } else if (message === "stop") { await service?.stop(); parentPort!.close(); }
  });
  parentPort!.postMessage("READY");
} else if (process.argv[2] === "modeld-child") {
  const service = await startModeldProcess({ durableRoot: process.argv[3]!, runRoot: process.argv[4]!, env: {},
    fetch: Object.assign(async () => { throw Error("network forbidden"); }, { preconnect: async () => {} }) as typeof fetch });
  console.log("MODELD_READY");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  await service.stop();
} else {
const root = process.argv[2]!, executable = process.argv[3]!, runRoot = join(root, "run"), hash = "a".repeat(64);
assert.equal(process.pid, 1); // This fixture owns its entire procfs/PID view.
await mkdir(join(root, "state"), { recursive: true }); await mkdir(join(runRoot, "state"), { recursive: true, mode: 0o700 });
function identity(pid: number) { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/); return { pid, start: Number(fields[19]) }; }
function lines(child: ChildProcessWithoutNullStreams) {
  const rows: string[] = []; let pending: ((line: string) => void) | undefined;
  const input = createInterface({ input: child.stdout });
  input.on("line", line => { if (pending) { const done = pending; pending = undefined; done(line); } else rows.push(line); });
  return () => rows.length ? Promise.resolve(rows.shift()!) : new Promise<string>(resolve => { pending = resolve; });
}
const candidate = spawn(executable, [join(runRoot, "retained.lock"), join(runRoot, "cloexec.lock")], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
const next = lines(candidate), candidateJoined = new Promise(resolve => candidate.once("close", resolve));
let stage = "before", keeper: ChildProcessWithoutNullStreams | undefined, keeperJoined: Promise<unknown> | undefined;
let modeld: ChildProcessWithoutNullStreams | undefined, modeldJoined: Promise<number | null> | undefined;
let starter: Worker | undefined, starterJoined: Promise<number> | undefined;
const realLink = fs.linkSync;
try {
  assert.match(await next(), /^READY /); const originalLifetime = identity(candidate.pid!);
  const oldImage = sha256Bytes(readFileSync(`/proc/${candidate.pid}/exe`));
  candidate.stdin.write("x"); stage = "image"; assert.equal(await next(), `BASH ${candidate.pid}`);
  assert.deepEqual(identity(candidate.pid!), originalLifetime);
  keeper = spawn("/usr/bin/bash", ["--noprofile", "--norc", "-c", "printf 'KEEPER\\n'; read -r finish"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  keeperJoined = new Promise(resolve => keeper!.once("close", resolve)); assert.equal(await lines(keeper)(), "KEEPER");
  const upper = identity(keeper.pid!), anchor = identity(process.pid);
  assert.ok(anchor.start < originalLifetime.start - 1);
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }), host = tree.spawn("host", { parent: supervisor });
  const temp = { pid: 90001, start: originalLifetime.start, uid: process.getuid!(), ppid: 1, ancestry: [1], exe: "/fixture/node", cmdline: ["node", "/fixture/temp"] };
  const lease = await acquireOperationLease(join(root, "owned.lock"), "original"); if (!lease.ok) throw Error("lease");
  const leaseOwner = { ...lease.lock.owner, start: String(BigInt(lease.lock.owner.start) + 1n) }; await lease.lock.release();
  const original = { state: "unknown", fingerprint: "original", leaseOwner, prefix: { signaled: true, spawned: true, guardian: true } };
  const store = { original, older: { state: "unknown", fingerprint: "older" } };
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original", tempSupervisor: temp, adoptingSupervisor: null, host: null };
  const marker = { operationId: "original", pid: 90002, start: originalLifetime.start, compiled: true, transformed: true, modeld: false,
    compile: { profileId: "fixture", profileSha256: hash, sourceSha256: hash, transformedSha256: hash }, preloadSha256: hash };
  const paths = [join(root, "state", "controller-operations.json"), join(runRoot, "state", "adopt-op.json"), join(runRoot, "state", "preload-marker.json")];
  for (const [i, row] of [store, journal, marker].entries()) await writeFile(paths[i]!, JSON.stringify(row), { mode: 0o600 });
  const before = await Promise.all(paths.map(path => readFile(path)));
  modeld = spawn(process.execPath, [process.argv[1]!, "modeld-child", root, runRoot], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  modeld.stderr.resume();
  modeldJoined = new Promise(resolve => modeld!.once("close", resolve));
  assert.equal(await lines(modeld)(), "MODELD_READY");
  const modeldOwner = identity(modeld.pid!);
  modeld.stdin.end("stop\n"); assert.equal(await modeldJoined, 0);
  const modeldRecord = join(runRoot, "modeld.sock.owner.json"), ownerBytes = await readFile(modeldRecord);
  const q: CurrentRestorationQualification = { version: 1, kind: "maintainer-qualified-current-retirement", operationId: "original", qualifiedAt: new Date().toISOString(), qualifierUid: process.getuid!(),
    provenance: { supportedWriterSha256: hash, launchSha256: hash, inventorySha256: hash, pidViewSha256: hash, clockCalibrationSha256: hash, allocationSha256: hash },
    original: { operations: restorationSnapshot(paths[0]!).sha256!, journal: restorationSnapshot(paths[1]!).sha256!, marker: restorationSnapshot(paths[2]!).sha256!, attestation: null, ownerClaim: null, archivedJournal: null, archivedMarker: null },
    launch: { rootDigest: sha256Text(root), targetDigest: hash, exeDigest: hash, argvDigest: hash, uid: process.getuid!(), mode: "route" },
    view: { bootId: leaseOwner.bootId, pid: readlinkSync("/proc/self/ns/pid"), time: readlinkSync("/proc/self/ns/time"), mnt: readlinkSync("/proc/self/ns/mnt"), anchor, clock: { anchor, originalStart: anchor.start } },
    hostScope: { lowerInclusive: temp.start - 1, upper, invariant: "detached-session-leader" },
    resources: { guardian: [], holder: [], delegatedNative: [], delegatedTools: [], restartOwners: [], independentOwners: [], scopes: [], roots: [root, runRoot], inodes: [],
      modeld: { kind: "absent", owners: [modeldOwner], socketPath: join(runRoot, "modeld.sock") } }, replacements: [] };
  const observed = () => Effect.runPromise(Effect.scoped(Effect.gen(function* () { const observer = yield* acquireRetirementObserver(); return yield* Effect.tryPromise(() => observer.observe(q, { hosts: [], markerPid: marker.pid })); })));
  const retained = await observed();
  assert.equal(retained.candidates.length, 1); assert.notEqual(retained.candidates[0]!.image.sha256, oldImage);
  assert.ok(retained.candidates[0]!.descriptors.some(fd => fd.locked && fd.relevant));
  const qualify = (row: typeof retained.candidates[number]) => { q.replacements = [{ lifetime: originalLifetime, imageSha256: row.image.sha256, librarySha256: row.image.libraries, qualificationSha256: hash, descriptors: row.descriptors.map(({ fd, digest }) => ({ fd, digest })) }]; };
  qualify(retained.candidates[0]!);
  // A qualified independent-holder entry must never bypass a selected
  // candidate's real image/descriptor/lock proof.
  q.resources.independentOwners = [originalLifetime];
  const qualificationPath = join(root, "qualification.json"), save = () => writeFile(qualificationPath, JSON.stringify(q), { mode: 0o600 }); await save();
  const ports: RestorationPorts = { processes: tree, classify: row => tree.roles().find(item => item.pid === row.pid)?.role as never, gatewayPid: () => host.pid, hasRelevantPreload: () => false };
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original", restorationQualification: qualificationPath };
  await assert.rejects(recoverControllerOperationState(input, ports));
  assert.equal(unresolvedAdoption(runRoot), "original");
  q.resources.independentOwners = []; await save();
  candidate.stdin.write("retire\n"); stage = "retired"; assert.equal(await next(), "RETIRED");
  await assert.rejects(recoverControllerOperationState(input, ports)); // The old descriptor qualification is stale.
  const retired = await observed();
  assert.ok(retired.candidates[0]!.descriptors.every(fd => !fd.locked && !fd.relevant));
  qualify(retired.candidates[0]!);
  q.replacements[0]!.imageSha256 = oldImage; await save();
  await assert.rejects(recoverControllerOperationState(input, ports));
  qualify(retired.candidates[0]!);
  q.resources.modeld.owners = [anchor]; await save(); await assert.rejects(recoverControllerOperationState(input, ports));
  q.resources.modeld.owners = [modeldOwner]; await save();
  const word = new Int32Array(new SharedArrayBuffer(4));
  starter = new Worker(new URL(import.meta.url), { workerData: { root, runRoot, shared: word.buffer } });
  starterJoined = new Promise(resolve => starter!.once("exit", resolve));
  await new Promise<void>((resolve, reject) => { starter!.once("message", () => resolve()); starter!.once("error", reject); });
  const attemptStart = () => {
    Atomics.store(word, 0, 0); starter!.postMessage("start");
    assert.notEqual(Atomics.wait(word, 0, 0, 5000), "timed-out");
    return Atomics.load(word, 0);
  };
  const completion = join(runRoot, "state", "adopt-restoration-original.json.complete.json");
  let contended = false;
  fs.linkSync = (from, to) => {
    if (String(to) === completion) assert.equal(attemptStart(), 1);
    realLink(from, to);
    if (String(to) === completion) {
      // Independent service owner progresses while this event loop cannot run
      // callbacks. Its actual OFD acquisition must fail even AFTER the link.
      assert.equal(attemptStart(), 1); contended = true;
      assert.deepEqual(readFileSync(modeldRecord), ownerBytes);
    }
  };
  syncBuiltinESMExports();
  const recovered = await recoverControllerOperationState(input, ports);
  fs.linkSync = realLink; syncBuiltinESMExports();
  assert.ok(contended);
  assert.equal(recovered.outcome, "restored"); assert.equal(recovered.operations.unknown, 2);
  assert.equal(unresolvedAdoption(runRoot), null);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
  assert.deepEqual(await readFile(modeldRecord), ownerBytes);
  assert.equal(attemptStart(), 2); // Positive control: the same real starter succeeds after scope release.
  console.log(JSON.stringify({ serviceStartBlockedThroughCompletion: true, serviceStartAfterRelease: true, samePidExec: true, oldImageRejected: true, inheritedLockRejected: true, retiredResourcesAccepted: true,
    originalBytesPreserved: true, stoppedModeldAbsent: true, privateInputs: false, signals: 0 }));
} finally {
  fs.linkSync = realLink; syncBuiltinESMExports();
  starter?.postMessage("stop"); if (starterJoined) assert.equal(await starterJoined, 0);
  if (modeld && modeld.exitCode === null) modeld.stdin.end("stop\n");
  if (modeldJoined) assert.equal(await modeldJoined, 0);
  if (stage === "before") candidate.stdin.end("xretire\nfinish\n");
  else if (stage === "image") candidate.stdin.end("retire\nfinish\n");
  else candidate.stdin.end("finish\n");
  keeper?.stdin.end("finish\n"); await candidateJoined; await keeperJoined;
  assert.equal(candidate.exitCode, 0); if (keeper) assert.equal(keeper.exitCode, 0);
}

}

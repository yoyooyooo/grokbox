import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
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
import { probeModeldExecution, probeModeldIdentity } from "../../src/internal/wire/modeld-probe.node.ts";
import type { CurrentRestorationQualification } from "../../src/internal/process/current-restoration.ts";
import type { RestorationPorts } from "../../src/internal/process/adopt-restoration.ts";
import { FakeProcessTree } from "../fake-tree.ts";

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
let modeld: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
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
  modeld = await startModeldProcess({ durableRoot: root, runRoot, env: {}, fetch: Object.assign(async () => { throw Error("network forbidden"); }, { preconnect: async () => {} }) as typeof fetch });
  const service = await probeModeldIdentity(runRoot); assert.ok(service);
  const q: CurrentRestorationQualification = { version: 1, kind: "maintainer-qualified-current-retirement", operationId: "original", qualifiedAt: new Date().toISOString(), qualifierUid: process.getuid!(),
    provenance: { supportedWriterSha256: hash, launchSha256: hash, inventorySha256: hash, pidViewSha256: hash, clockCalibrationSha256: hash, allocationSha256: hash },
    original: { operations: restorationSnapshot(paths[0]!).sha256!, journal: restorationSnapshot(paths[1]!).sha256!, marker: restorationSnapshot(paths[2]!).sha256!, attestation: null, ownerClaim: null, archivedJournal: null, archivedMarker: null },
    launch: { rootDigest: sha256Text(root), targetDigest: hash, exeDigest: hash, argvDigest: hash, uid: process.getuid!(), mode: "route" },
    view: { bootId: leaseOwner.bootId, pid: readlinkSync("/proc/self/ns/pid"), time: readlinkSync("/proc/self/ns/time"), mnt: readlinkSync("/proc/self/ns/mnt"), anchor, clock: { anchor, originalStart: anchor.start } },
    hostScope: { lowerInclusive: temp.start - 1, upper, invariant: "detached-session-leader" },
    resources: { guardian: [], holder: [], delegatedNative: [], delegatedTools: [], restartOwners: [], independentOwners: [], scopes: [], roots: [root, runRoot], inodes: [],
      modeld: { kind: "same-epoch-unused", owner: { ...anchor }, socketPath: join(runRoot, "modeld.sock"), codePath: process.argv[1]!, codeSha256: sha256Bytes(readFileSync(process.argv[1]!)), epoch: service.generation, provenanceSha256: hash } }, replacements: [] };
  const observed = () => Effect.runPromise(Effect.scoped(Effect.gen(function* () { const observer = yield* acquireRetirementObserver(); return yield* Effect.tryPromise(() => observer.observe(q, { hosts: [], markerPid: marker.pid })); })));
  const retained = await observed();
  assert.equal(retained.candidates.length, 1); assert.notEqual(retained.candidates[0]!.image.sha256, oldImage);
  assert.ok(retained.candidates[0]!.descriptors.some(fd => fd.locked && fd.relevant));
  const qualify = (row: typeof retained.candidates[number]) => { q.replacements = [{ lifetime: originalLifetime, imageSha256: row.image.sha256, librarySha256: row.image.libraries, qualificationSha256: hash, descriptors: row.descriptors.map(({ fd, digest }) => ({ fd, digest })) }]; };
  qualify(retained.candidates[0]!);
  const qualificationPath = join(root, "qualification.json"), save = () => writeFile(qualificationPath, JSON.stringify(q), { mode: 0o600 }); await save();
  const ports: RestorationPorts = { processes: tree, classify: row => tree.roles().find(item => item.pid === row.pid)?.role as never, gatewayPid: () => host.pid, hasRelevantPreload: () => false };
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original", restorationQualification: qualificationPath };
  await assert.rejects(recoverControllerOperationState(input, ports));
  assert.equal(unresolvedAdoption(runRoot), "original");
  candidate.stdin.write("retire\n"); stage = "retired"; assert.equal(await next(), "RETIRED");
  await assert.rejects(recoverControllerOperationState(input, ports)); // The old descriptor qualification is stale.
  const retired = await observed();
  assert.ok(retired.candidates[0]!.descriptors.every(fd => !fd.locked && !fd.relevant));
  qualify(retired.candidates[0]!);
  q.replacements[0]!.imageSha256 = oldImage; await save();
  await assert.rejects(recoverControllerOperationState(input, ports));
  qualify(retired.candidates[0]!);
  const modeldBinding = q.resources.modeld;
  assert.equal(modeldBinding.kind, "same-epoch-unused");
  if (modeldBinding.kind !== "same-epoch-unused") throw Error("fixture binding");
  const code = modeldBinding.codeSha256;
  modeldBinding.codeSha256 = hash; await save(); await assert.rejects(recoverControllerOperationState(input, ports));
  modeldBinding.codeSha256 = code; modeldBinding.owner.start++; await save(); await assert.rejects(recoverControllerOperationState(input, ports));
  modeldBinding.owner.start--; await save();
  const recovered = await recoverControllerOperationState(input, ports);
  assert.equal(recovered.outcome, "restored"); assert.equal(recovered.operations.unknown, 2);
  assert.equal(unresolvedAdoption(runRoot), null);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
  assert.equal((await probeModeldExecution(runRoot))?.execution.admission, "open");
  console.log(JSON.stringify({ samePidExec: true, oldImageRejected: true, inheritedLockRejected: true, retiredResourcesAccepted: true,
    originalBytesPreserved: true, modeldFenceReleased: true, privateInputs: false, signals: 0 }));
} finally {
  await modeld?.stop();
  if (stage === "before") candidate.stdin.end("xretire\nfinish\n");
  else if (stage === "image") candidate.stdin.end("retire\nfinish\n");
  else candidate.stdin.end("finish\n");
  keeper?.stdin.end("finish\n"); await candidateJoined; await keeperJoined;
  assert.equal(candidate.exitCode, 0); if (keeper) assert.equal(keeper.exitCode, 0);
}

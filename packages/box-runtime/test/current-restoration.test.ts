import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { prepareOriginalRestoration, type RestorationPorts } from "../src/internal/process/adopt-restoration.ts";
import { restorationSnapshot, restorationReceiptPath } from "../src/internal/process/restoration-proof.ts";
import { unresolvedAdoption, writeAdoptionOwner } from "../src/internal/process/adopt-evidence.ts";
import type { CurrentRestorationQualification, RetirementObservation } from "../src/internal/process/current-restoration.ts";
import { FakeProcessTree } from "./fake-tree.ts";

const hash = "a".repeat(64);
async function fixture(replacement = false) {
  const root = await mkdtemp(join(tmpdir(), "current-retirement-")), runRoot = join(root, "run");
  await mkdir(join(root, "state")); await mkdir(join(runRoot, "state"), { recursive: true });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }), host = tree.spawn("host", { parent: supervisor });
  const oldTemp = tree.spawn("temp-supervisor", { parent: wrapper }), markerHost = tree.spawn("extra"), candidate = tree.spawn("extra"), upper = tree.spawn("extra");
  tree.kill(oldTemp); tree.kill(markerHost); if (!replacement) tree.kill(candidate);
  const lease = await acquireOperationLease(join(root, "owned.lock"), "original"); if (!lease.ok) throw Error("lease");
  const leaseOwner = { ...lease.lock.owner, start: String(BigInt(lease.lock.owner.start) + 1n) }; await lease.lock.release();
  const original = { state: "unknown", fingerprint: "original", leaseOwner, prefix: { signaled: true, spawned: true, guardian: true } };
  const store = { original, older: { state: "unknown", fingerprint: "older" } };
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original", tempSupervisor: oldTemp, adoptingSupervisor: null, host: null };
  const marker = { operationId: "original", pid: markerHost.pid, start: markerHost.start, compiled: true, transformed: true, modeld: false,
    compile: { profileId: "fixture", profileSha256: hash, sourceSha256: hash, transformedSha256: hash }, preloadSha256: hash };
  const files = [join(root, "state", "controller-operations.json"), join(runRoot, "state", "adopt-op.json"), join(runRoot, "state", "preload-marker.json")];
  for (const [i, value] of [store, journal, marker].entries()) await writeFile(files[i]!, JSON.stringify(value), { mode: 0o600 });
  const ref = (row: { pid: number; start: number }) => ({ pid: row.pid, start: row.start });
  const q: CurrentRestorationQualification = { version: 1, kind: "maintainer-qualified-current-retirement", operationId: "original", qualifiedAt: new Date().toISOString(), qualifierUid: process.getuid!(),
    provenance: { supportedWriterSha256: hash, launchSha256: hash, inventorySha256: hash, pidViewSha256: hash, clockCalibrationSha256: hash, allocationSha256: hash },
    original: { operations: restorationSnapshot(files[0]!).sha256!, journal: restorationSnapshot(files[1]!).sha256!, marker: restorationSnapshot(files[2]!).sha256!, attestation: null, ownerClaim: null, archivedJournal: null, archivedMarker: null },
    launch: { rootDigest: sha256Text(root), targetDigest: hash, exeDigest: hash, argvDigest: hash, uid: process.getuid!(), mode: "route" },
    view: { bootId: leaseOwner.bootId, pid: "pid:[1]", time: "time:[1]", mnt: "mnt:[1]", anchor: ref(wrapper), clock: { anchor: ref(wrapper), originalStart: wrapper.start } },
    hostScope: { lowerInclusive: oldTemp.start - 1, upper: ref(upper), invariant: "detached-session-leader" },
    resources: { guardian: [], holder: [], delegatedNative: [], delegatedTools: [], restartOwners: [], independentOwners: [], scopes: [], roots: [root, runRoot], inodes: [], modeld: { kind: "absent", owners: [], socketPath: join(runRoot, "modeld.sock") } },
    replacements: replacement ? [{ lifetime: ref(candidate), imageSha256: hash, librarySha256: [hash], qualificationSha256: hash, descriptors: [{ fd: 0, digest: hash }] }] : [] };
  const observation: RetirementObservation = { version: 1, view: structuredClone(q.view), procMountSha256: hash, census: tree.list().map(row => ({ ...ref(row), pgid: row.pid === candidate.pid ? row.pid : wrapper.pid, sid: row.pid === candidate.pid ? row.pid : wrapper.pid, nspid: [row.pid], nstgid: [row.pid] })),
    candidates: replacement ? [{ lifetime: ref(candidate), relevantPreload: false, image: { sha256: hash, libraries: [hash], anchorSha256: hash }, descriptors: [{ fd: 0, digest: hash, relevant: false, locked: false }] }] : [], resourceHolders: [], modeld: null };
  const qualificationPath = join(root, "qualification.json");
  const save = async () => writeFile(qualificationPath, JSON.stringify(q), { mode: 0o600 }); await save();
  let reads = 0;
  const ports: RestorationPorts = { processes: tree, classify: row => { const role = tree.roles().find(item => item.pid === row.pid)?.role; return role === "extra" ? null : role as never; },
    gatewayPid: () => host.pid, hasRelevantPreload: () => false,
    current: { recoveryOwner: ref(wrapper), recheckModeld: async () => {}, assertModeldFence: () => {}, observe: async () => { reads++; return structuredClone(observation); } } };
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original", restorationQualification: qualificationPath };
  const prepare = () => prepareOriginalRestoration({ operationId: "original", runRoot, storePath: files[0]!, expectedOperation: original, ports, qualificationPath });
  return { root, runRoot, files, q, observation, ports, input, save, prepare, reads: () => reads, candidate, markerHost, journal };
}

for (const replacement of [false, true]) test(`qualified ${replacement ? "exec replacement" : "complete absence"} discharges only the old resource boundary without inventing historical files`, async () => {
  const f = await fixture(replacement), before = await Promise.all(f.files.map(path => readFile(path)));
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
  const result = await recoverControllerOperationState(f.input, f.ports);
  expect(result).toMatchObject({ outcome: "restored", operations: { unknown: 2 }, adopted: false, signaled: false, replayAuthorized: false });
  expect(f.reads()).toBe(3); expect(unresolvedAdoption(f.runRoot)).toBeNull();
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  for (const path of [join(f.runRoot, "state", "adoption-owner.json"), join(f.runRoot, "state", "adoptions", "original", "journal.json")]) expect(restorationSnapshot(path, true).bytes).toBeNull();
  await writeAdoptionOwner(f.runRoot, "new-id", "unresolved"); expect(unresolvedAdoption(f.runRoot)).toBe("new-id");
});

for (const fault of ["lock", "preload", "relevant-fd", "image", "library", "fd", "hidden-pid", "sibling-view", "offset-clock", "new-candidate", "delegated", "inventory", "pending-inventory", "creation", "compile", "absent-owner-appears", "absent-archive-appears", "qualification-change", "census-change", "mount-change", "auxv-change", "fence-loss", "fence-loss-final"] as const) test(`current proof refuses ${fault}`, async () => {
  const f = await fixture(true);
  if (fault === "preload") f.observation.candidates[0]!.relevantPreload = true;
  if (fault === "lock") f.observation.candidates[0]!.descriptors[0]!.locked = true;
  if (fault === "relevant-fd") f.observation.candidates[0]!.descriptors[0]!.relevant = true;
  if (fault === "image") f.observation.candidates[0]!.image.sha256 = "b".repeat(64);
  if (fault === "library") f.observation.candidates[0]!.image.libraries.push("b".repeat(64));
  if (fault === "fd") f.observation.candidates[0]!.descriptors[0]!.digest = "b".repeat(64);
  if (fault === "hidden-pid") f.observation.census[0]!.nstgid.push(f.markerHost.pid);
  if (fault === "sibling-view") f.observation.view.pid = "pid:[2]";
  if (fault === "offset-clock") f.q.view.clock.originalStart += 5;
  if (fault === "new-candidate") f.observation.census.push({ pid: 90000, start: f.candidate.start, pgid: 90000, sid: 90000, nspid: [90000], nstgid: [90000] });
  if (fault === "delegated") f.q.resources.delegatedTools.push({ pid: f.candidate.pid, start: f.candidate.start });
  if (fault === "pending-inventory") (f.q.resources as unknown as Record<string, unknown>).status = "pending";
  if (fault === "inventory") delete (f.q.resources as Partial<typeof f.q.resources>).delegatedNative;
  if (fault === "creation" || fault === "compile") {
    const path = f.files[fault === "creation" ? 1 : 2]!;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (fault === "creation") value.creation = null; else value.compilationObservation = null;
    await writeFile(path, JSON.stringify(value));
    f.q.original[fault === "creation" ? "journal" : "marker"] = restorationSnapshot(path).sha256!;
  }
  await f.save();
  if (fault === "fence-loss-final") { let checks = 0; f.ports.current!.assertModeldFence = () => { if (++checks === 2) throw Error("lost before completion"); }; }
  if (["absent-owner-appears", "absent-archive-appears", "qualification-change", "census-change", "mount-change", "auxv-change", "fence-loss"].includes(fault)) {
    let n = 0; const observe = f.ports.current!.observe;
    f.ports.current!.observe = async (...args) => {
      if (++n === 2) {
        if (fault === "absent-owner-appears") await writeAdoptionOwner(f.runRoot, "original", "unresolved");
        if (fault === "absent-archive-appears") { const dir = join(f.runRoot, "state", "adoptions", "original"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "journal.json"), await readFile(f.files[1]!)); }
        if (fault === "qualification-change") { f.q.qualifiedAt = "2000-01-01T00:00:00.000Z"; await f.save(); }
        if (fault === "census-change") f.observation.census[0]!.pgid++;
        if (fault === "mount-change") f.observation.procMountSha256 = "b".repeat(64);
        if (fault === "auxv-change") f.observation.candidates[0]!.image.anchorSha256 = "b".repeat(64);
        if (fault === "fence-loss") f.ports.current!.recheckModeld = async () => { throw Error("fence-lost"); };
      }
      return observe(...args);
    };
  }
  const result = await recoverControllerOperationState(f.input, f.ports).catch(() => null);
  if (result) expect(result.reason).toBe("restoration-evidence-unproven");
  expect(result?.outcome).not.toBe("restored"); expect(unresolvedAdoption(f.runRoot)).toBe("original");
  const historical = await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports);
  expect(historical.restoration).toBeUndefined();
});

test("current observation cancellation joins work before releasing recovery gates and cannot publish", async () => {
  const f = await fixture(); const cancellation = new AbortController();
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), allowed = new Promise<void>(resolve => { release = resolve; });
  const observe = f.ports.current!.observe;
  f.ports.current!.observe = async (...args) => { entered(); await allowed; return observe(...args); };
  const work = recoverControllerOperationState({ ...f.input, signal: cancellation.signal }, f.ports); void work.catch(() => undefined);
  await began; cancellation.abort();
  const competitor = await recoverControllerOperationState(f.input, f.ports);
  expect(competitor.reason).toBe("operation_busy");
  release(); await expect(work).rejects.toMatchObject({ code: "invalid_usage" });
  expect(restorationSnapshot(restorationReceiptPath(f.runRoot, "original"), true).bytes).toBeNull();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
});

test("recorded modern Host lifetime can be retired by qualified replacement without relabelling it absent", async () => {
  const f = await fixture(true), journal = JSON.parse(await readFile(f.files[1]!, "utf8")), marker = JSON.parse(await readFile(f.files[2]!, "utf8"));
  const store = JSON.parse(await readFile(f.files[0]!, "utf8"));
  const lifetime = { pid: f.candidate.pid, start: f.candidate.start };
  const diagnostic = { code: "fixture-failure", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired", child: { ...lifetime, exitCode: null, signal: null } };
  Object.assign(marker, lifetime);
  journal.failure = diagnostic;
  journal.creation = { version: 1, operationId: "original", host: lifetime, tempSupervisor: { pid: journal.tempSupervisor.pid, start: journal.tempSupervisor.start },
    guardian: { pid: 90001, start: 1 }, holder: { pid: 90002, start: 2 }, compile: marker.compile, preloadSha256: marker.preloadSha256 };
  store.original.prefix.diagnostic = diagnostic;
  for (const [i, row] of [store, journal, marker].entries()) await writeFile(f.files[i]!, JSON.stringify(row));
  f.q.original.operations = restorationSnapshot(f.files[0]!).sha256!; f.q.original.journal = restorationSnapshot(f.files[1]!).sha256!; f.q.original.marker = restorationSnapshot(f.files[2]!).sha256!;
  await f.save();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  expect(f.ports.processes.inspect(f.candidate.pid)?.start).toBe(f.candidate.start);
});

for (const role of ["guardian", "delegatedTools"] as const) test(`qualified unknown ${role} uses the declared complete scope without an ancestry or leader omission`, async () => {
  const f = await fixture(true);
  const row = f.observation.census.find(row => row.pid === f.candidate.pid)!;
  row.sid = row.pgid = f.q.view.anchor.pid; // Not H's detached-leader scope.
  f.q.resources.scopes.push({ role, lowerInclusive: f.candidate.start, upper: f.q.hostScope.upper,
    qualificationSha256: hash, retirement: role === "guardian" ? "node-image-or-absence" : "absence" });
  await f.save();
  if (role === "guardian") expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  else { await expect(recoverControllerOperationState(f.input, f.ports)).rejects.toMatchObject({ code: "invalid_usage" }); expect(unresolvedAdoption(f.runRoot)).toBe("original"); }
});

test("nonmatching completed publication never discharges missing original evidence", async () => {
  const f = await fixture();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  await writeFile(`${restorationReceiptPath(f.runRoot, "original")}.complete.json`, JSON.stringify({ version: 2, operationId: "original", publication: "complete", receiptSha256: "b".repeat(64) }));
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
  expect((await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).reason).toBe("restoration-receipt-unavailable");
});

test("captured marker clock cannot replace the independently qualified causal endpoint", async () => {
  const f = await fixture(), marker = JSON.parse(await readFile(f.files[2]!, "utf8"));
  marker.start = f.q.hostScope.upper.start + 1000000; // A producer's offset clock.
  await writeFile(f.files[2]!, JSON.stringify(marker)); f.q.original.marker = restorationSnapshot(f.files[2]!).sha256!; await f.save();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
});


test("historical current-proof inspection never emits unexpected raw evidence fields", async () => {
  const f = await fixture();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  const path = restorationReceiptPath(f.runRoot, "original"), row = JSON.parse(await readFile(path, "utf8"));
  row.evidence.raw = "PRIVATE_FIXTURE_BODY";
  const bytes = JSON.stringify(row); await writeFile(path, bytes);
  await writeFile(`${path}.complete.json`, JSON.stringify({ version: 2, operationId: "original", publication: "complete", receiptSha256: sha256Text(bytes) }));
  const result = await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports);
  expect(result.reason).toBe("restoration-receipt-unavailable");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_BODY");
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
});

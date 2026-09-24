import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectHostCompileReceipt } from "@grokbox/runtime-kernel/host-health";
import { observeHostCompilation } from "../src/internal/io/host-compilation.node.ts";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { prepareOriginalRestoration, restorationReceiptPath, type RestorationPorts } from "../src/internal/process/adopt-restoration.ts";
import { adoptionEvidencePath, unresolvedAdoption, writeAdoptionOwner } from "../src/internal/process/adopt-evidence.ts";
import { FakeProcessTree } from "./fake-tree.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-restoration-")), runRoot = join(root, "run");
  await mkdir(join(root, "state"), { mode: 0o700 }); await mkdir(join(runRoot, "state"), { recursive: true, mode: 0o700 });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  const oldTemp = tree.spawn("temp-supervisor"), oldHost = tree.spawn("host", { parent: oldTemp });
  tree.kill(oldHost); tree.kill(oldTemp);
  const guardian = tree.spawn("guardian"), holder = tree.spawn("guardian"); tree.kill(guardian); tree.kill(holder);
  const claim = await acquireOperationLease(join(root, "owner.lock"), "original");
  if (!claim.ok) throw new Error("fixture owner unavailable");
  const leaseOwner = { ...claim.lock.owner, start: String(BigInt(claim.lock.owner.start) + 1n) };
  await claim.lock.release();
  const files = [join(root, "state", "controller-operations.json"), join(runRoot, "state", "adopt-op.json"),
    join(runRoot, "state", "preload-marker.json"), join(runRoot, "attestation.json")];
  const store = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`unknown-${i}`, { state: "unknown", fingerprint: `prior-${i}` }]));
  const diagnostic = { code: "guardian-ownership-ended", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired", child: { pid: oldHost.pid, start: oldHost.start, exitCode: null, signal: null }, cleanup: [{ role: "host", pid: oldHost.pid, start: oldHost.start, signalSent: true, outcome: "unproven", observed: "same-identity" }] };
  const compile = { profileId: "fixture", profileSha256: "a".repeat(64), sourceSha256: "b".repeat(64), transformedSha256: "c".repeat(64) };
  const ref = (row: { pid: number; start: number }) => ({ pid: row.pid, start: row.start });
  store.original = { prefix: { signaled: true, spawned: true, guardian: true, diagnostic }, state: "unknown", fingerprint: "original-fingerprint", leaseOwner } as never;
  const launch = { rootDigest: sha256Text(root), targetDigest: sha256Text(oldHost.cmdline[1]!), exeDigest: sha256Text(oldHost.exe), argvDigest: sha256Text(canonicalJson(oldHost.cmdline)), uid: leaseOwner.uid, mode: "route" as const };
  const compilationObservation = { version: 1, observationId: "12345678-1234-4234-8234-123456789abc", at: new Date().toISOString(), pid: oldHost.pid, start: oldHost.start,
    ...launch, operationDigest: sha256Text("original"), patch: "applied", nativeCompilation: "returned", code: "compiled", sourceSha: compile.sourceSha256,
    candidateSha: compile.transformedSha256, profileDigest: compile.profileSha256, preloadDigest: "d".repeat(64) };
  expect(projectHostCompileReceipt(compilationObservation)).not.toBeNull();
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original",
    tempSupervisor: oldTemp, adoptingSupervisor: null, host: null, failure: diagnostic,
    creation: { version: 1, operationId: "original", tempSupervisor: ref(oldTemp), host: ref(oldHost), guardian: ref(guardian), holder: ref(holder), compile, preloadSha256: "d".repeat(64), launch } };
  const marker = { operationId: "original", pid: oldHost.pid, start: oldHost.start, compiled: true, transformed: true, modeld: false, mode: "route", compile, preloadSha256: "d".repeat(64), compilationObservation };
  await Promise.all([store, journal, marker, { operationId: "prior-attestation" }].map((value, i) => writeFile(files[i]!, JSON.stringify(value), { mode: 0o600 })));
  await mkdir(join(runRoot, "state", "adoptions", "original"), { recursive: true });
  await writeFile(adoptionEvidencePath(runRoot, "original", "journal"), JSON.stringify(journal));
  await writeFile(adoptionEvidencePath(runRoot, "original", "marker"), JSON.stringify(marker));
  await writeAdoptionOwner(runRoot, "original", "unresolved");
  const ports: RestorationPorts = { processes: tree, classify: row => {
    const role = tree.roles().find(item => item.pid === row.pid)?.role;
    return role === "extra" ? null : role as ReturnType<RestorationPorts["classify"]>;
  }, gatewayPid: () => host.pid, hasRelevantPreload: () => false };
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: "original" };
  const prepared = () => prepareOriginalRestoration({ operationId: "original", runRoot, storePath: files[0]!, expectedOperation: store.original, ports });
  return { root, runRoot, files, ports, tree, host, oldHost, oldTemp, input, prepared, journal };
}

test("connected recovery publishes only original-operation restoration; all six unknowns and evidence survive byte-for-byte", async () => {
  const f = await fixture(), before = await Promise.all(f.files.map(path => readFile(path)));
  expect(await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).toMatchObject({ outcome: "blocked", reason: "restoration-confirm-required" });
  const result = await recoverControllerOperationState(f.input, f.ports);
  expect((await observeHostCompilation(f.root, f.runRoot, f.oldHost.cmdline[1]!, { inspect: () => null })).state).toBe("historical");
  expect(result).toMatchObject({ outcome: "restored", adopted: false, signaled: false, replayAuthorized: false,
    clearedLocks: 0, markedUnknown: 0, operations: { unknown: 6 }, restoration: { operationId: "original", physicallyRestored: true } });
  expect(JSON.parse(await readFile(restorationReceiptPath(f.runRoot, "original"), "utf8"))).toEqual({ ...result.restoration, physicallyRestored: false, publication: "prepared" });
  const historical = await recoverControllerOperationState({ ...f.input, confirm: false }, {
    ...f.ports, gatewayPid: () => { throw Error("historical receipt inspection must not observe live Gateway"); },
  });
  expect(historical).toMatchObject({ outcome: "recorded", restorationHistorical: true, operations: { unknown: 6 },
    adopted: false, replayAuthorized: false, restoration: result.restoration });
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  expect(f.tree.signals).toHaveLength(4); // Fixture disposal only, recovery never signals.
  await expect(recoverControllerOperationState(f.input, f.ports)).rejects.toMatchObject({ code: "invalid_usage" });
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
});

test("marker-bound Host prevents restoration even with null journal Host", async () => {
  const f = await fixture();
  f.tree.procs.get(f.oldHost.pid)!.alive = true;
  expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "blocked", reason: "restoration-evidence-unproven" });
});

for (const mutation of ["gateway", "preload", "guardian", "duplicate", "commit", "operation", "live-owner", "malformed-failure", "malformed-attestation"] as const) test(`restoration refuses ${mutation} uncertainty`, async () => {
  const f = await fixture();
  if (mutation === "gateway") f.ports.gatewayPid = () => f.oldHost.pid;
  if (mutation === "preload") f.ports.hasRelevantPreload = () => true;
  if (mutation === "guardian") f.tree.spawn("guardian");
  if (mutation === "duplicate") f.tree.spawn("host");
  if (mutation === "commit") await writeFile(f.files[1]!, JSON.stringify({ ...f.journal, phase: "commit-attestation" }));
  if (mutation === "malformed-failure") await writeFile(f.files[1]!, JSON.stringify({ ...f.journal, tempSupervisor: null, failure: {} }));
  if (mutation === "malformed-attestation") await writeFile(f.files[3]!, "null");
  if (mutation === "operation") f.input.restoreOperation = "different";
  let held: Awaited<ReturnType<typeof acquireOperationLease>> | undefined;
  if (mutation === "live-owner") held = await acquireOperationLease(join(f.root, "state", "controller-operations.lock"), "other");
  try {
    const before = await Promise.all(f.files.map(path => readFile(path)));
    expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "blocked", clearedLocks: 0, markedUnknown: 0 });
    expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  } finally { if (held?.ok) await held.lock.release(); }
});

for (const mutation of ["journal", "marker", "attestation", "store", "identity", "gateway", "receipt"] as const) test(`immediate publication recheck rejects ${mutation} CAS change`, async () => {
  const f = await fixture(), prepared = f.prepared();
  if (mutation === "journal") await writeFile(f.files[1]!, JSON.stringify({ ...f.journal, extra: true }));
  if (mutation === "marker") await writeFile(f.files[2]!, "{}");
  if (mutation === "attestation") await writeFile(f.files[3]!, "{}");
  if (mutation === "store") await writeFile(f.files[0]!, "{}");
  if (mutation === "identity") f.tree.spawn("host", { pid: f.host.pid });
  if (mutation === "gateway") f.ports.gatewayPid = () => null;
  if (mutation === "receipt") await writeFile(restorationReceiptPath(f.runRoot, "original"), "uncertain prior receipt\n");
  expect(() => prepared.publish()).toThrow();
  if (mutation === "receipt") expect(await readFile(restorationReceiptPath(f.runRoot, "original"), "utf8")).toBe("uncertain prior receipt\n");
});

test("concurrent original-operation recovery has at most one receipt publisher", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([recoverControllerOperationState(f.input, f.ports), recoverControllerOperationState(f.input, f.ports)]);
  expect(results.filter(row => row.status === "fulfilled" && row.value.outcome === "restored")).toHaveLength(1);
});


test("public recovery inspection refuses a malformed historical receipt without changing evidence", async () => {
  const f = await fixture(), path = restorationReceiptPath(f.runRoot, "original");
  await writeFile(path, JSON.stringify({ operationId: "original", physicallyRestored: true, raw: "excluded-fixture-output" }));
  const before = await Promise.all([...f.files, path].map(file => readFile(file)));
  const result = await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports);
  expect(result).toMatchObject({ outcome: "blocked", reason: "restoration-receipt-unavailable", operations: { unknown: 6 } });
  expect(JSON.stringify(result)).not.toContain("excluded-fixture-output");
  expect(await Promise.all([...f.files, path].map(file => readFile(file)))).toEqual(before);
});

for (const source of ["contradictory-child", "exec-changed-child", "missing-creation", "missing-compile"] as const) test(`restoration rejects ${source} original provenance without role-based owner omission`, async () => {
  const f = await fixture();
  const journal = JSON.parse(await readFile(f.files[1]!, "utf8")), marker = JSON.parse(await readFile(f.files[2]!, "utf8"));
  if (source === "contradictory-child") {
    const survivor = f.tree.spawn("extra");
    journal.failure.child = { pid: survivor.pid, start: survivor.start, exitCode: null, signal: null };
    journal.failure.cleanup = [{ role: "host", pid: survivor.pid, start: survivor.start, signalSent: true, outcome: "unproven", observed: "same-identity" }];
    const store = JSON.parse(await readFile(f.files[0]!, "utf8")); store.original.prefix.diagnostic = journal.failure;
    await writeFile(f.files[0]!, JSON.stringify(store));
  }
  if (source === "exec-changed-child") {
    const row = f.tree.procs.get(f.oldHost.pid)!; row.alive = true; row.role = "extra"; row.ident.cmdline = ["unclassified-fixture"]; row.ident.exe = "/fixture/changed";
  }
  if (source === "missing-creation") delete journal.creation;
  if (source === "missing-compile") delete marker.compile;
  for (const path of [f.files[1]!, adoptionEvidencePath(f.runRoot, "original", "journal")]) await writeFile(path, JSON.stringify(journal));
  for (const path of [f.files[2]!, adoptionEvidencePath(f.runRoot, "original", "marker")]) await writeFile(path, JSON.stringify(marker));
  const before = await Promise.all(f.files.map(path => readFile(path)));
  expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "blocked", operations: { unknown: 6 }, adopted: false });
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
});

test("failed post-link proof remains incomplete through public historical inspection", async () => {
  const f = await fixture(); let reads = 0;
  f.ports.gatewayPid = () => ++reads <= 2 ? f.host.pid : null;
  await expect(recoverControllerOperationState(f.input, f.ports)).rejects.toMatchObject({ code: "invalid_usage" });
  expect(reads).toBe(3);
  const path = restorationReceiptPath(f.runRoot, "original"), preserved = await readFile(path);
  expect(JSON.parse(preserved.toString())).toMatchObject({ publication: "prepared", physicallyRestored: false });
  const historical = await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports);
  expect(historical).toMatchObject({ outcome: "blocked", operations: { unknown: 6 }, replayAuthorized: false });
  expect(historical.restoration).toBeUndefined(); expect(reads).toBe(3);
  expect(await readFile(path)).toEqual(preserved);
  await expect(recoverControllerOperationState(f.input, { ...f.ports, gatewayPid: () => f.host.pid })).rejects.toMatchObject({ code: "invalid_usage" });
});


test("completed original restoration discharges only its resource boundary and preserves archived evidence across later writes", async () => {
  const f = await fixture(), original = await readFile(adoptionEvidencePath(f.runRoot, "original", "journal"));
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
  expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "restored", operations: { unknown: 6 } });
  expect(unresolvedAdoption(f.runRoot)).toBeNull();
  const { writeAdoptOpState } = await import("../src/internal/process/transient-adopt.ts");
  await writeAdoptionOwner(f.runRoot, "later", "unresolved");
  await writeAdoptOpState(f.runRoot, { operationId: "later", launchMode: "transient-adopt", phase: "wrapper-stop", tempSupervisor: null, adoptingSupervisor: null, host: null });
  expect(await readFile(adoptionEvidencePath(f.runRoot, "original", "journal"))).toEqual(original);
  expect(unresolvedAdoption(f.runRoot)).toBe("later");
  expect(await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).toMatchObject({ outcome: "recorded", restorationHistorical: true, operations: { unknown: 6 }, replayAuthorized: false });
});


for (const field of ["pid", "start", "uid", "operationDigest", "rootDigest", "targetDigest", "exeDigest", "argvDigest", "mode", "sourceSha", "candidateSha", "profileDigest", "preloadDigest", "at", "invalid", "null", "missing-launch", "live-other"] as const) test(`structured compilation ${field} contradiction blocks original restoration`, async () => {
  const f = await fixture(), marker = JSON.parse(await readFile(f.files[2]!, "utf8"));
  if (["pid", "start", "uid"].includes(field)) marker.compilationObservation[field]++;
  else if (field.endsWith("Digest") || ["sourceSha", "candidateSha"].includes(field)) marker.compilationObservation[field] = "e".repeat(64);
  else if (field === "mode") marker.compilationObservation.mode = "identity";
  else if (field === "at") marker.compilationObservation.at = "2099-01-01T00:00:00.000Z";
  else if (field === "invalid") marker.compilationObservation.code = "not-a-compilation-code";
  else if (field === "null") marker.compilationObservation = null;
  else if (field === "missing-launch") {
    const journal = JSON.parse(await readFile(f.files[1]!, "utf8")); delete journal.creation.launch;
    for (const path of [f.files[1]!, adoptionEvidencePath(f.runRoot, "original", "journal")]) await writeFile(path, JSON.stringify(journal));
  } else {
    const survivor = f.tree.spawn("extra");
    marker.compilationObservation.pid = survivor.pid; marker.compilationObservation.start = survivor.start;
    marker.compilationObservation.exeDigest = sha256Text(survivor.exe); marker.compilationObservation.argvDigest = sha256Text(canonicalJson(survivor.cmdline));
    expect(projectHostCompileReceipt(marker.compilationObservation)).not.toBeNull();
  }
  for (const path of [f.files[2]!, adoptionEvidencePath(f.runRoot, "original", "marker")]) await writeFile(path, JSON.stringify(marker));
  const before = await Promise.all(f.files.map(path => readFile(path)));
  expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "blocked", operations: { unknown: 6 }, adopted: false });
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  if (field !== "missing-launch") expect((await observeHostCompilation(f.root, f.runRoot, f.oldHost.cmdline[1]!, { inspect: () => null })).state).not.toBe("current");
});

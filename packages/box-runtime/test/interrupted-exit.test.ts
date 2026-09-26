import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { prepareOfficialExit } from "../src/internal/process/interrupted-exit.node.ts";
import { officialExitCompletionPath, readOfficialExit, officialExitEvidencePaths } from "../src/internal/process/restoration-proof.ts";
import { unresolvedAdoption } from "../src/internal/process/adopt-evidence.ts";
import type { RestorationPorts } from "../src/internal/process/adopt-restoration.ts";
import { FakeProcessTree } from "./fake-tree.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-exit-recovery-")), runRoot = join(root, "run"), id = "original";
  await mkdir(join(root, "state"), { mode: 0o700 });
  await mkdir(join(runRoot, "state/adoptions", id), { recursive: true, mode: 0o700 });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  const old = tree.spawn("host", { parent: supervisor }); tree.kill(old);
  const host = tree.spawn("host", { parent: supervisor });
  const { pid, start, uid, exe, cmdline } = old, stable = { pid, start, uid, exe, cmdline };
  const archived = { launchMode: "transient-adopt", phase: "attested", operationId: id, tempSupervisor: null, adoptingSupervisor: supervisor, host: stable };
  const journal = { launchMode: "transient-adopt", phase: "deactivate-term", tempSupervisor: null, adoptingSupervisor: supervisor, host: stable };
  const claim = await acquireOperationLease(join(root, "owner.lock"), id);
  if (!claim.ok) throw Error("fixture lease missing");
  const leaseOwner = { ...claim.lock.owner, start: String(BigInt(claim.lock.owner.start) + 1n) };
  await claim.lock.release();
  const original = { state: "unknown", fingerprint: "original", leaseOwner };
  const store = { original, other: { state: "unknown", fingerprint: "other" } };
  const files = { ...officialExitEvidencePaths(runRoot, id), operations: join(root, "state/controller-operations.json") };
  const owner = { version: 1, operationId: id, state: "complete", journalSha256: sha256Text(JSON.stringify(archived)) };
  const values = { operations: store, owner, journal, archivedJournal: archived, attestation: { operationId: id, identity: old } };
  for (const [role, path] of Object.entries(files)) await writeFile(path, JSON.stringify(values[role as keyof typeof values]), { mode: 0o600 });
  const ports: RestorationPorts = { processes: tree, classify: row => {
    const role = tree.roles().find(r => r.pid === row.pid)?.role;
    return role === "extra" ? null : role as ReturnType<RestorationPorts["classify"]>;
  }, gatewayPid: () => host.pid, hasRelevantPreload: () => false };
  const prepare = () => prepareOfficialExit({ operationId: id, runRoot, storePath: files.operations, expectedOperation: original, ports });
  const input = { boxRoot: root, ephemeralRoot: runRoot, confirm: true, restoreOperation: id };
  return { root, runRoot, id, tree, wrapper, supervisor, old, host, files, values, original, ports, prepare, input };
}

test("original recovery records a completed official exit without changing old evidence or unknowns", async () => {
  const f = await fixture(), before = await Promise.all(Object.values(f.files).map(path => readFile(path)));
  expect(unresolvedAdoption(f.runRoot)).toBe(f.id);
  expect(await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).toMatchObject({ outcome: "blocked", reason: "restoration-confirm-required" });
  const result = await recoverControllerOperationState(f.input, f.ports);
  expect(result).toMatchObject({ outcome: "restored", signaled: false, adopted: false, replayAuthorized: false, clearedLocks: 0, markedUnknown: 0,
    operations: { unknown: 2 }, officialExit: { operationId: f.id, kind: "interrupted-official-exit", physicallyRestored: true } });
  expect(unresolvedAdoption(f.runRoot)).toBeNull();
  expect(await Promise.all(Object.values(f.files).map(path => readFile(path)))).toEqual(before);
  expect(f.tree.signals).toHaveLength(1); // Fixture retirement only.
  const historical = await recoverControllerOperationState({ ...f.input, confirm: false }, { ...f.ports,
    gatewayPid: () => { throw Error("history must not read the current process"); } });
  expect(historical).toMatchObject({ outcome: "recorded", restorationHistorical: true, officialExit: result.officialExit, operations: { unknown: 2 } });
});

for (const change of ["old-live", "gateway", "host-preload", "supervisor-preload", "unreadable", "guardian", "holder", "duplicate", "supervisor", "archive", "attestation", "owner", "wrong-operation"] as const)
  test(`official exit does not discharge ${change} uncertainty`, async () => {
    const f = await fixture();
    if (change === "old-live") f.tree.procs.get(f.old.pid)!.alive = true;
    if (change === "gateway") f.ports.gatewayPid = () => f.old.pid;
    if (change === "host-preload") f.ports.hasRelevantPreload = pid => pid === f.host.pid;
    if (change === "supervisor-preload") f.ports.hasRelevantPreload = pid => pid === f.supervisor.pid;
    if (change === "unreadable") f.ports.hasRelevantPreload = () => { throw Error("unreadable"); };
    if (change === "guardian") f.tree.spawn("guardian");
    if (change === "holder") { const p = f.tree.spawn("extra"); f.tree.procs.get(p.pid)!.ident.cmdline = ["node", "/owned/injector-hold.cjs"]; }
    if (change === "duplicate") f.tree.spawn("host");
    if (change === "supervisor") f.tree.spawn("supervisor", { pid: f.supervisor.pid, parent: f.wrapper });
    if (change === "archive") await writeFile(f.files.archivedJournal, JSON.stringify({ ...f.values.archivedJournal, phase: "spawn-temp" }));
    if (change === "attestation") await writeFile(f.files.attestation, JSON.stringify({ operationId: "other", identity: f.old }));
    if (change === "owner") await writeFile(f.files.owner, JSON.stringify({ ...f.values.owner, operationId: "other" }));
    if (change === "wrong-operation") f.input.restoreOperation = "other";
    expect(await recoverControllerOperationState(f.input, f.ports)).toMatchObject({ outcome: "blocked", signaled: false, markedUnknown: 0 });
    expect(readOfficialExit(f.runRoot, f.id)).toBeNull();
    expect(unresolvedAdoption(f.runRoot)).not.toBeNull();
  });

for (const role of ["operations", "owner", "journal", "archivedJournal", "attestation"] as const)
  test(`publication rechecks the original ${role} file instance`, async () => {
    const f = await fixture(), prepared = f.prepare()!;
    await writeFile(f.files[role], JSON.stringify(f.values[role]) + "\n");
    expect(() => prepared.publish()).toThrow("restoration-exit-evidence-changed");
    expect(readOfficialExit(f.runRoot, f.id)).toBeNull();
  });

test("late generation change and cancellation cannot publish an official exit", async () => {
  const f = await fixture(), prepared = f.prepare()!;
  f.tree.spawn("host", { pid: f.host.pid, parent: f.supervisor });
  expect(() => prepared.publish()).toThrow(); expect(readOfficialExit(f.runRoot, f.id)).toBeNull();
  const other = await fixture(), pending = other.prepare()!, abort = new AbortController(); abort.abort();
  expect(() => pending.publish(abort.signal)).toThrow("restoration-exit-cancelled"); expect(readOfficialExit(other.runRoot, other.id)).toBeNull();
});

test("new controller rows do not revive an old physical resource, while changed source evidence fences again", async () => {
  const f = await fixture(); f.prepare()!.publish();
  await writeFile(f.files.operations, JSON.stringify({ ...f.values.operations, next: { state: "running", fingerprint: "next" } }));
  expect(unresolvedAdoption(f.runRoot)).toBeNull();
  await writeFile(f.files.journal, JSON.stringify({ ...f.values.journal, changed: true }));
  expect(unresolvedAdoption(f.runRoot)).toBe(f.id);
  expect(readOfficialExit(f.runRoot, f.id)?.kind).toBe("interrupted-official-exit");
});

test("corrupted completion cannot discharge the resource or masquerade as historical success", async () => {
  const f = await fixture(); f.prepare()!.publish();
  const path = officialExitCompletionPath(f.runRoot, f.id), envelope = JSON.parse(await readFile(path, "utf8"));
  envelope.receipt.chain.host.pid++;
  await writeFile(path, JSON.stringify(envelope));
  expect(unresolvedAdoption(f.runRoot)).toBe(f.id);
  expect(await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).toMatchObject({ outcome: "blocked", reason: "restoration-receipt-unavailable" });
});

test("concurrent recovery has one immutable publisher and preserves every original row", async () => {
  const f = await fixture(), before = await readFile(f.files.operations);
  const results = await Promise.allSettled([recoverControllerOperationState(f.input, f.ports), recoverControllerOperationState(f.input, f.ports)]);
  expect(results.filter(r => r.status === "fulfilled" && r.value.outcome === "restored")).toHaveLength(1);
  expect(await readFile(f.files.operations)).toEqual(before);
});

test("wrapper exit after the final census cannot certify stale official parentage", async () => {
  const f = await fixture(), prepared = f.prepare()!, list = f.tree.list.bind(f.tree);
  // Production classification uses the captured argv, not a new alive-only
  // census. Keep the wrapper classifiable after its captured row becomes stale.
  f.ports.classify = row => { const role = f.tree.procs.get(row.pid)?.role; return role === "extra" ? null : role ?? null; };
  let samples = 0;
  f.tree.list = () => {
    const rows = list();
    if (++samples === 2) f.tree.kill(f.wrapper);
    return rows;
  };
  expect(() => prepared.publish()).toThrow("restoration-exit-official-chain-unproven");
  expect(existsSync(officialExitCompletionPath(f.runRoot, f.id))).toBe(false);
});

test("individually readable evidence cannot occupy the completion name with an unreadable envelope", async () => {
  const f = await fixture();
  await writeFile(f.files.operations, JSON.stringify({ ...f.values.operations,
    large: { state: "unknown", fingerprint: '"'.repeat(1_100_000) } }));
  const prepared = f.prepare()!;
  let failure: unknown;
  try { prepared.publish(); } catch (error) { failure = error; }
  expect(existsSync(officialExitCompletionPath(f.runRoot, f.id))).toBe(false);
  expect(failure).toMatchObject({ message: "restoration-exit-receipt-too-large" });
  expect(unresolvedAdoption(f.runRoot)).toBe(f.id);
});


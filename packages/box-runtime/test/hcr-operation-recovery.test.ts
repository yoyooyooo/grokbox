import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLease, inspectOperationLease, operationOwnerState, recheckOperationLease,
  removeRecoveredOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const roots: string[] = [];
const workers: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
const locks = (root: string) => [join(root, "state", "controller-operations.lock"), join(root, "run", "ops", "identity.lock")];
const storePath = (root: string) => join(root, "state", "controller-operations.json");
const request = (root: string, confirm = false) => ({ boxRoot: root, ephemeralRoot: join(root, "run"), confirm });
async function fixtureRoot() { const root = await fs.mkdtemp(join(tmpdir(), "grokbox-hcr-crash-")); roots.push(root); return root; }
function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("disposable_worker_timeout")), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function owner(root: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/hcr-operation-owner.ts", import.meta.url)), root],
    { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  workers.push({ child, exited });
  await bounded(new Promise<void>((resolve, reject) => {
    let out = "";
    child.once("error", reject);
    child.once("close", () => reject(new Error("disposable_worker_exited_before_ready")));
    child.stdout!.on("data", chunk => { out += chunk.toString(); if (out.includes("ready\n")) resolve(); });
    child.stderr!.resume();
  }));
  const pid = child.pid!;
  return { pid, child, exited, crash: async () => { child.kill("SIGKILL"); await bounded(exited); } };
}
afterEach(async () => {
  for (const { child, exited } of workers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(exited);
  }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

linuxTest("read-only recovery observation creates no files or gate in an empty root", async () => {
  const root = await fixtureRoot();
  expect(await recoverControllerOperationState(request(root))).toMatchObject({ outcome: "clear", signaled: false, adopted: false, replayAuthorized: false });
  expect(await fs.readdir(root)).toEqual([]);
});

linuxTest("a live owner and its kernel gates refuse recovery without touching metadata", async () => {
  const root = await fixtureRoot();
  await owner(root);
  const before = await Promise.all([...locks(root), storePath(root)].map(path => fs.readFile(path, "utf8")));
  expect(await recoverControllerOperationState(request(root))).toMatchObject({ outcome: "blocked", reason: "lock_owner_live_or_unproven" });
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", reason: "operation_busy", markedUnknown: 0, clearedLocks: 0 });
  expect(await Promise.all([...locks(root), storePath(root)].map(path => fs.readFile(path, "utf8")))).toEqual(before);
});

linuxTest("hard exit releases physical gates but never silently removes locks or retries work", async () => {
  const root = await fixtureRoot();
  const worker = await owner(root);
  const preserved = [join(root, "run", "attestation.json"), join(root, "run", "adopt-op.json")];
  for (const path of preserved) await fs.writeFile(path, "synthetic-boundary-must-not-change\n");
  const before = await fs.readFile(storePath(root), "utf8");
  await worker.crash();
  expect((await inspectOperationLease(locks(root)[0]!)).observation).toMatchObject({ state: "stale", format: "identity-v1", recoverable: true });
  const ordinary = await acquireOperationLease(locks(root)[0]!, "new-operation");
  expect(ordinary.ok).toBe(false);
  if (ordinary.ok) await ordinary.lock.release();
  expect(await recoverControllerOperationState(request(root))).toMatchObject({ outcome: "ready", operations: { running: 1 } });
  expect(await fs.readFile(storePath(root), "utf8")).toBe(before);
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "recovered", operations: { running: 0, unknown: 1 }, clearedLocks: 2, markedUnknown: 1, signaled: false, adopted: false, replayAuthorized: false });
  const after = JSON.parse(await fs.readFile(storePath(root), "utf8"));
  expect(after["fixture-operation"]).toEqual({ ...JSON.parse(before)["fixture-operation"], state: "unknown" });
  for (const path of preserved) expect(await fs.readFile(path, "utf8")).toBe("synthetic-boundary-must-not-change\n");
  for (const path of locks(root)) expect((await inspectOperationLease(path)).observation.state).toBe("missing");
  const next = await acquireOperationLease(locks(root)[0]!, "fixture-operation");
  expect(next.ok).toBe(true);
  if (next.ok) await next.lock.release();
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "clear", clearedLocks: 0, markedUnknown: 0, next: "grokbox runtime re-adopt --confirm" });
});

linuxTest("same-process concurrent acquisitions have one winner, including across helper exit", async () => {
  const root = await fixtureRoot(), path = locks(root)[0]!;
  const results = await Promise.all([acquireOperationLease(path, "a"), acquireOperationLease(path, "b")]);
  try {
    expect(results.filter(row => row.ok)).toHaveLength(1);
    const held = results.find(row => row.ok);
    if (held?.ok) expect((await inspectOperationLease(path)).owner).toEqual(held.lock.owner);
  } finally { for (const result of results) if (result.ok) await result.lock.release(); }
  expect((await inspectOperationLease(path)).observation.state).toBe("missing");
});

linuxTest("legacy dead PID recovery requires a stale controller witness for ownerless running rows", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  for (const path of locks(root)) await fs.writeFile(path, `${worker.pid}\n`);
  const store = JSON.parse(await fs.readFile(storePath(root), "utf8"));
  delete store["fixture-operation"].leaseOwner;
  await fs.writeFile(storePath(root), JSON.stringify(store));
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "recovered", markedUnknown: 1, clearedLocks: 2 });
  expect(JSON.parse(await fs.readFile(storePath(root), "utf8"))["fixture-operation"].state).toBe("unknown");
  store["fixture-operation"].state = "running";
  await fs.writeFile(storePath(root), JSON.stringify(store));
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", reason: "operation_owner_live_or_unproven", markedUnknown: 0 });
});

linuxTest("a live identity operation fences recovery of an otherwise stale controller record", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const snapshot = await inspectOperationLease(locks(root)[1]!);
  await removeRecoveredOperationLease(snapshot);
  const identity = await acquireOperationLease(locks(root)[1]!, "other-identity-operation");
  expect(identity.ok).toBe(true);
  const before = await fs.readFile(storePath(root), "utf8");
  try {
    expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", reason: "operation_busy", clearedLocks: 0 });
    expect(await fs.readFile(storePath(root), "utf8")).toBe(before);
    expect((await inspectOperationLease(locks(root)[0]!)).observation.state).toBe("stale");
  } finally { if (identity.ok) await identity.lock.release(); }
});

linuxTest("owner identity distinguishes PID reuse without treating a legacy live PID as stale", async () => {
  const root = await fixtureRoot(), acquired = await acquireOperationLease(locks(root)[0]!, "identity-check");
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) return;
  try {
    expect(await operationOwnerState(acquired.lock.owner)).toBe("live");
    expect(await operationOwnerState({ ...acquired.lock.owner, start: String(BigInt(acquired.lock.owner.start) + 1n) })).toBe("stale");
    expect(await operationOwnerState({ version: 0, pid: process.pid })).toBe("live");
    expect(await operationOwnerState({ ...acquired.lock.owner, uid: acquired.lock.owner.uid + 1 })).toBe("unproven");
  } finally { await acquired.lock.release(); }
});

linuxTest("replaced stale records are rejected; old release never unlinks a successor", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const path = locks(root)[0]!, stale = await inspectOperationLease(path);
  const replacement = `${path}.replacement`;
  await fs.writeFile(replacement, `${process.pid}\n`);
  await fs.rename(replacement, path);
  await expect(recheckOperationLease(stale)).rejects.toThrow("operation_recovery_conflict");
  await expect(removeRecoveredOperationLease(stale)).rejects.toThrow("operation_recovery_conflict");
  expect(await fs.readFile(path, "utf8")).toBe(`${process.pid}\n`);
  await fs.unlink(path);
  const acquired = await acquireOperationLease(path, "release-check");
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) return;
  await fs.writeFile(replacement, "replacement\n");
  await fs.rename(replacement, path);
  await acquired.lock.release();
  expect(await fs.readFile(path, "utf8")).toBe("replacement\n");
});

linuxTest("malformed and symlink records are never reclaimed or followed", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const path = locks(root)[0]!, before = await fs.readFile(storePath(root), "utf8");
  await fs.writeFile(path, "{truncated");
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", clearedLocks: 0 });
  await fs.unlink(path);
  const target = join(root, "preserved");
  await fs.writeFile(target, `${worker.pid}\n`);
  await fs.symlink(target, path);
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", clearedLocks: 0 });
  expect(await fs.readFile(storePath(root), "utf8")).toBe(before);
  expect(await fs.readFile(target, "utf8")).toBe(`${worker.pid}\n`);
  expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
});

linuxTest("a lost lock with a proven dead operation owner can demote running, not terminal records", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const store = JSON.parse(await fs.readFile(storePath(root), "utf8"));
  store.finished = { fingerprint: "finished-fingerprint", state: "terminal", prefix: { signaled: false, spawned: false, guardian: false } };
  await fs.writeFile(storePath(root), JSON.stringify(store));
  for (const path of locks(root)) await fs.unlink(path);
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "recovered", clearedLocks: 0, markedUnknown: 1 });
  expect(JSON.parse(await fs.readFile(storePath(root), "utf8")).finished).toEqual(store.finished);
});

linuxTest("concurrent recoverers cannot both remove locks or mark the operation unknown", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const results = await Promise.all([recoverControllerOperationState(request(root, true)), recoverControllerOperationState(request(root, true))]);
  expect(results.filter(row => row.outcome === "recovered")).toHaveLength(1);
  expect(results.reduce((total, row) => total + row.markedUnknown, 0)).toBe(1);
  expect(results.reduce((total, row) => total + row.clearedLocks, 0)).toBe(2);
});

linuxTest("failed store publication leaves stale locks and running evidence recoverable", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const before = await fs.readFile(storePath(root), "utf8");
  const failure = spyOn(syncFs, "renameSync").mockImplementation(() => { throw new Error("fixture store publication failure"); });
  try {
    await expect(recoverControllerOperationState(request(root, true))).rejects.toMatchObject({ code: "invalid_usage" });
    expect(await fs.readFile(storePath(root), "utf8")).toBe(before);
    for (const path of locks(root)) expect((await inspectOperationLease(path)).observation.state).toBe("stale");
  } finally { failure.mockRestore(); }
  // The abandoned staging file is not canonical and cannot absorb/block recovery.
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "recovered", clearedLocks: 2, markedUnknown: 1 });
});

linuxTest("even a dangling store symlink is unavailable, never an empty operation store", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  await fs.unlink(storePath(root));
  const target = join(root, "not-created");
  await fs.symlink(target, storePath(root));
  expect(await recoverControllerOperationState(request(root))).toMatchObject({ outcome: "blocked", reason: "operation_store_unavailable" });
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", clearedLocks: 0 });
  expect((await fs.lstat(storePath(root))).isSymbolicLink()).toBe(true);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

linuxTest("invalid store blocks before any stale lock is removed", async () => {
  const root = await fixtureRoot(), worker = await owner(root);
  await worker.crash();
  const before = await Promise.all(locks(root).map(path => fs.readFile(path, "utf8")));
  await fs.writeFile(storePath(root), "{truncated");
  expect(await recoverControllerOperationState(request(root, true))).toMatchObject({ outcome: "blocked", reason: "operation_store_unavailable", clearedLocks: 0 });
  expect(await Promise.all(locks(root).map(path => fs.readFile(path, "utf8")))).toEqual(before);
});

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { prepareOriginalRestoration, restorationReceiptPath, type RestorationPorts } from "../src/internal/process/adopt-restoration.ts";
import { FakeProcessTree } from "./fake-tree.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-restoration-")), runRoot = join(root, "run");
  await mkdir(join(root, "state")); await mkdir(join(runRoot, "state"), { recursive: true });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  const oldTemp = tree.spawn("temp-supervisor"), oldHost = tree.spawn("host", { parent: oldTemp });
  tree.kill(oldHost); tree.kill(oldTemp);
  const claim = await acquireOperationLease(join(root, "owner.lock"), "original");
  if (!claim.ok) throw new Error("fixture owner unavailable");
  const leaseOwner = { ...claim.lock.owner, start: String(BigInt(claim.lock.owner.start) + 1n) };
  await claim.lock.release();
  const files = [join(root, "state", "controller-operations.json"), join(runRoot, "state", "adopt-op.json"),
    join(runRoot, "state", "preload-marker.json"), join(runRoot, "attestation.json")];
  const store = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`unknown-${i}`, { state: "unknown", fingerprint: `prior-${i}` }]));
  store.original = { state: "unknown", fingerprint: "original-fingerprint", leaseOwner } as never;
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: "original",
    tempSupervisor: oldTemp, adoptingSupervisor: null, host: null };
  const marker = { operationId: "original", pid: oldHost.pid, start: oldHost.start, compiled: true, transformed: true, modeld: false };
  await Promise.all([store, journal, marker, { operationId: "prior-attestation" }].map((value, i) => writeFile(files[i]!, JSON.stringify(value))));
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
  expect(result).toMatchObject({ outcome: "restored", adopted: false, signaled: false, replayAuthorized: false,
    clearedLocks: 0, markedUnknown: 0, operations: { unknown: 6 }, restoration: { operationId: "original", physicallyRestored: true } });
  expect(JSON.parse(await readFile(restorationReceiptPath(f.runRoot, "original"), "utf8"))).toEqual(result.restoration);
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  expect(f.tree.signals).toHaveLength(2); // Fixture disposal only, recovery never signals.
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

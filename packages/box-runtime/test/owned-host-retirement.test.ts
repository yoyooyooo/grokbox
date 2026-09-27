import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireOperationLease } from "../src/internal/io/operation-lease.node.ts";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { acquireAdvisoryGate } from "../src/internal/io/advisory-gate.node.ts";
import { FakeProcessTree } from "./fake-tree.ts";
import { adoptionEvidencePath, writeAdoptionOwner } from "../src/internal/process/adopt-evidence.ts";
import { retireFailedAdoptionHost, type HostRetirementPorts } from "../src/internal/process/owned-host-retirement.node.ts";
import type { RestorationPorts } from "../src/internal/process/adopt-restoration.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-owned-retirement-")), runRoot = join(root, "run"), id = "owned-failed-op";
  await mkdir(join(root, "state"), { mode: 0o700 });
  await mkdir(join(runRoot, "state", "adoptions", id), { recursive: true, mode: 0o700 });
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  const temp = tree.spawn("temp-supervisor"), host = tree.spawn("host", { parent: temp });
  const guardian = tree.spawn("guardian"), holder = tree.spawn("guardian");
  tree.kill(temp); tree.kill(guardian); tree.kill(holder);
  tree.procs.get(host.pid)!.ident.ppid = 53; tree.procs.get(host.pid)!.ident.ancestry = [53];
  const ref = (p: { pid: number; start: number }) => ({ pid: p.pid, start: p.start });
  const compile = { profileId: "owned", profileSha256: "a".repeat(64), sourceSha256: "b".repeat(64), transformedSha256: "c".repeat(64) };
  const diagnostic = { code: "marker-mismatch", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "released",
    signals: [{ ...ref(wrapper), signal: "SIGSTOP", sent: true }], child: { ...ref(host), exitCode: null, signal: null }, cleanup: [] };
  const lease = await acquireOperationLease(join(root, "fixture-owner.lock"), id);
  if (!lease.ok) throw Error("fixture owner unavailable");
  const leaseOwner = { ...lease.lock.owner, start: String(BigInt(lease.lock.owner.start) + 1n) };
  await lease.lock.release();
  for (const row of tree.procs.values()) row.ident.uid = leaseOwner.uid;
  host.uid = leaseOwner.uid;
  const launch = { rootDigest: sha256Text(root), targetDigest: sha256Text(host.cmdline[1]!), exeDigest: sha256Text(host.exe),
    argvDigest: sha256Text(JSON.stringify(host.cmdline)), uid: host.uid, mode: "route" as const };
  const operation = { state: "unknown", fingerprint: "d".repeat(64), leaseOwner, prefix: { signaled: true, spawned: true, guardian: true, diagnostic } };
  const journal = { launchMode: "transient-adopt", phase: "recovery-required", operationId: id, tempSupervisor: temp, adoptingSupervisor: null, host: null,
    failure: diagnostic, creation: { version: 1, operationId: id, host: ref(host), tempSupervisor: ref(temp), guardian: ref(guardian), holder: ref(holder), compile, preloadSha256: "e".repeat(64), launch } };
  const marker = { operationId: id, ...ref(host), mode: "route", modeld: false, compiled: true, transformed: true, compile, preloadSha256: "e".repeat(64) };
  const files = [join(root, "state/controller-operations.json"), join(runRoot, "state/adopt-op.json"), join(runRoot, "state/preload-marker.json")];
  await Promise.all([{ [id]: operation }, journal, marker].map((value, i) => writeFile(files[i]!, JSON.stringify(value), { mode: 0o600 })));
  await writeFile(adoptionEvidencePath(runRoot, id, "journal"), JSON.stringify(journal), { mode: 0o600 });
  await writeFile(adoptionEvidencePath(runRoot, id, "marker"), JSON.stringify(marker), { mode: 0o600 });
  await writeAdoptionOwner(runRoot, id, "unresolved");
  await writeFile(join(root, "config.json"), JSON.stringify({ schemaVersion: 4, runtime: { desiredMode: "disabled" } }), { mode: 0o600 });
  const ports: RestorationPorts = { processes: tree, classify: p => {
    const role = tree.roles().find(row => row.pid === p.pid)?.role; return role === "extra" ? null : role as ReturnType<RestorationPorts["classify"]>;
  }, gatewayPid: () => host.pid, hasRelevantPreload: pid => pid === host.pid };
  let signals = 0, closes = 0, pins = 0;
  const retirement: HostRetirementPorts = { bootId: () => leaseOwner.bootId, assertModeldAbsent: () => {}, recheckOwnership: async () => {}, gateDescriptors: () => [3, 4, 5], observeIdle: async () => ({}), pin: async () => {
    pins++;
    return { terminate: async () => { signals++; tree.kill(tree.inspect(host.pid)!); return { signaled: true, exitObserved: true }; }, close: async () => { closes++; } };
  } };
  const input = { boxRoot: root, runRoot, storePath: files[0]!, operationId: id, expectedOperation: operation, ports, retirement, signal: new AbortController().signal };
  return { root, runRoot, id, tree, wrapper, supervisor, host, temp, files, input, retirement, counts: () => ({ signals, closes, pins }) };
}

test("formal recovery composes retirement under its resource gates without settling the original operation", async () => {
  const f = await fixture();
  const before = await Promise.all(f.files.map(p => readFile(p)));
  const request = { boxRoot: f.root, ephemeralRoot: f.runRoot, retireOwnedHost: f.id, confirm: true };
  const result = await recoverControllerOperationState(request, f.input.ports, f.retirement);
  expect(result).toMatchObject({ outcome: "retired", signaled: true, adopted: false, replayAuthorized: false,
    hostRetirement: { state: "exit-observed" }, operations: { unknown: 1 } });
  expect(await Promise.all(f.files.map(p => readFile(p)))).toEqual(before);
});

test("the live modeld service gate blocks formal retirement before any helper or signal", async () => {
  const f = await fixture();
  const gate = await acquireAdvisoryGate(join(f.runRoot, "modeld.sock.gate"));
  if (!gate) throw Error("fixture gate unavailable");
  try {
    const result = await recoverControllerOperationState({ boxRoot: f.root, ephemeralRoot: f.runRoot, retireOwnedHost: f.id, confirm: true }, f.input.ports, f.retirement);
    expect(result).toMatchObject({ outcome: "blocked", reason: "retirement-modeld-busy", signaled: false });
    expect(f.counts()).toEqual({ signals: 0, pins: 0, closes: 0 });
  } finally { await gate.release(); }
});

test("formal cancellation after dispatch joins the helper and preserves signal uncertainty", async () => {
  const f = await fixture(), cancel = new AbortController();
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  let joined = false;
  f.retirement.pin = async (_target, signal) => ({
    terminate: async () => {
      dispatched();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { signaled: true, exitObserved: false };
    },
    close: async () => {
      const gate = await acquireAdvisoryGate(join(f.root, "state/controller-operations.lock.gate"));
      if (gate) { await gate.release(); throw Error("controller gate released before helper join"); }
      joined = true;
    },
  });
  const work = recoverControllerOperationState({ boxRoot: f.root, ephemeralRoot: f.runRoot, retireOwnedHost: f.id,
    confirm: true, signal: cancel.signal }, f.input.ports, f.retirement).then(value => ({ value }), error => ({ error }));
  await started; cancel.abort();
  const result = await work;
  expect(joined).toBe(true); expect("error" in result).toBe(true);
  if ("error" in result) {
    expect(String(result.error.message)).toContain("SIGTERM may already have been requested or delivered");
    expect(String(result.error.message)).not.toContain("no Host signal");
  }
  const gate = await acquireAdvisoryGate(join(f.root, "state/controller-operations.lock.gate"));
  expect(gate).not.toBeNull(); await gate?.release();
});

test("owned retirement signals once, preserves the original unknown and never becomes restoration", async () => {
  const f = await fixture(), before = await Promise.all(f.files.map(p => readFile(p)));
  const result = await retireFailedAdoptionHost(f.input);
  expect(result).toMatchObject({ state: "exit-observed", signaled: true, target: { pid: f.host.pid, start: f.host.start } });
  expect(await Promise.all(f.files.map(p => readFile(p)))).toEqual(before);
  expect(await retireFailedAdoptionHost(f.input)).toMatchObject({ state: "previous-attempt", signaled: false });
  expect(f.counts()).toEqual({ signals: 1, closes: 1, pins: 1 });
});

for (const mutation of ["boot", "routing", "modeld", "busy", "pid-reuse", "exec", "wrapper", "supervisor", "temp", "gateway", "preload", "marker", "cancel"] as const) {
  test(`owned retirement refuses ${mutation} before signal`, async () => {
    const f = await fixture();
    if (mutation === "boot") f.retirement.bootId = () => "different-boot";
    if (mutation === "routing") await writeFile(join(f.root, "config.json"), JSON.stringify({ schemaVersion: 4, runtime: { desiredMode: "route" } }));
    if (mutation === "modeld") f.retirement.assertModeldAbsent = () => { throw Error("modeld present"); };
    if (mutation === "busy") f.retirement.observeIdle = async () => { throw Error("busy"); };
    if (mutation === "pid-reuse") f.tree.procs.get(f.host.pid)!.ident.start++;
    if (mutation === "exec") f.tree.procs.get(f.host.pid)!.ident.exe = "/other/node";
    if (mutation === "wrapper") f.tree.procs.get(f.wrapper.pid)!.ident.start++;
    if (mutation === "supervisor") f.tree.procs.get(f.supervisor.pid)!.ident.ppid = 999;
    if (mutation === "temp") f.tree.procs.get(f.temp.pid)!.alive = true;
    if (mutation === "gateway") f.input.ports.gatewayPid = () => 999;
    if (mutation === "preload") f.input.ports.hasRelevantPreload = () => true;
    if (mutation === "marker") await writeFile(f.files[2]!, "{}");
    if (mutation === "cancel") f.input.signal = AbortSignal.abort();
    await expect(retireFailedAdoptionHost(f.input)).rejects.toThrow();
    expect(f.counts().signals).toBe(0);
  });
}

for (const change of ["file", "parentage", "modeld", "lease", "cancel"] as const) test(`fresh pre-signal recheck refuses ${change} during idle observation`, async () => {
  const f = await fixture(), cancellation = new AbortController(); f.input.signal = cancellation.signal;
  f.retirement.observeIdle = async () => {
    if (change === "file") await writeFile(f.files[1]!, "{}");
    if (change === "parentage") f.tree.procs.get(f.supervisor.pid)!.ident.ancestry = [987];
    if (change === "modeld") f.retirement.assertModeldAbsent = () => { throw Error("modeld present"); };
    if (change === "lease") f.retirement.recheckOwnership = async () => { throw Error("lease changed"); };
    if (change === "cancel") cancellation.abort();
  };
  await expect(retireFailedAdoptionHost(f.input)).rejects.toThrow();
  expect(f.counts()).toEqual({ signals: 0, pins: 1, closes: 1 });
});

test("lost signal result consumes the intent and a second invocation cannot resend", async () => {
  const f = await fixture(); let sends = 0;
  f.retirement.pin = async () => ({ terminate: async () => { sends++; throw Error("lost reply"); }, close: async () => {} });
  expect(await retireFailedAdoptionHost(f.input)).toMatchObject({ state: "exit-unproven", signaled: "unknown" });
  expect(await retireFailedAdoptionHost(f.input)).toMatchObject({ state: "previous-attempt", signaled: false });
  expect(sends).toBe(1);
});

test("ownership loss after intent publication neither signals nor permits another attempt", async () => {
  const f = await fixture(); let checks = 0;
  f.retirement.recheckOwnership = async () => { if (++checks > 1) throw Error("lease lost"); };
  expect(await retireFailedAdoptionHost(f.input)).toMatchObject({ state: "exit-unproven", signaled: false });
  expect(f.counts().signals).toBe(0);
  expect(await retireFailedAdoptionHost(f.input)).toMatchObject({ state: "previous-attempt", signaled: false });
  expect(f.counts().signals).toBe(0);
});

test("exclusive intent publication admits only one concurrent signal", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([retireFailedAdoptionHost(f.input), retireFailedAdoptionHost(f.input)]);
  expect(results.filter(r => r.status === "fulfilled" && r.value.signaled === true)).toHaveLength(1);
  expect(f.counts().signals).toBe(1);
});

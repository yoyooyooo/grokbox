import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { acquireCurrentRestorationPorts } from "../src/internal/process/current-restoration-ports.node.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";
import { restorationSnapshot, restorationReceiptPath } from "../src/internal/process/restoration-proof.ts";
import { unresolvedAdoption, writeAdoptionOwner } from "../src/internal/process/adopt-evidence.ts";

import { currentRestorationFixture as fixture } from "./current-restoration-fixture.ts";
const hash = "a".repeat(64);

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

for (const fault of ["lock", "preload", "relevant-fd", "image", "library", "fd", "hidden-pid", "sibling-view", "offset-clock", "new-candidate", "delegated", "inventory", "pending-inventory", "creation", "compile", "absent-owner-appears", "absent-archive-appears", "qualification-change", "census-change", "mount-change", "auxv-change", "modeld-appears", "modeld-appears-final"] as const) test(`current proof refuses ${fault}`, async () => {
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
  if (fault === "modeld-appears-final") { let checks = 0; f.ports.current!.assertModeldAbsent = () => { if (++checks === 8) throw Error("modeld appeared before completion"); }; }
  if (["absent-owner-appears", "absent-archive-appears", "qualification-change", "census-change", "mount-change", "auxv-change", "modeld-appears"].includes(fault)) {
    let n = 0; const observe = f.ports.current!.observe;
    f.ports.current!.observe = async (...args) => {
      if (++n === 2) {
        if (fault === "absent-owner-appears") await writeAdoptionOwner(f.runRoot, "original", "unresolved");
        if (fault === "absent-archive-appears") { const dir = join(f.runRoot, "state", "adoptions", "original"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "journal.json"), await readFile(f.files[1]!)); }
        if (fault === "qualification-change") { f.q.qualifiedAt = "2000-01-01T00:00:00.000Z"; await f.save(); }
        if (fault === "census-change") f.observation.census[0]!.pgid++;
        if (fault === "mount-change") f.observation.procMountSha256 = "b".repeat(64);
        if (fault === "auxv-change") f.observation.candidates[0]!.image.anchorSha256 = "b".repeat(64);
        if (fault === "modeld-appears") f.ports.current!.assertModeldAbsent = () => { throw Error("fence-lost"); };
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

for (const holdsRequiredResource of [false, true]) test(`unrelated process churn ${holdsRequiredResource ? "cannot hide a required holder" : "does not change the retirement proof"}`, async () => {
  const f = await fixture(true), before = await Promise.all(f.files.map(path => readFile(path)));
  const observe = f.ports.current!.observe;
  let reads = 0;
  f.ports.current!.observe = async (...args) => {
    const row = { pid: 90000, start: f.q.hostScope.upper.start + 1000, pgid: 90000, sid: 90000, nspid: [90000], nstgid: [90000] };
    const observation = await observe(...args);
    if (++reads === 2) {
      observation.census.push(row);
      if (holdsRequiredResource) observation.resourceHolders.push({ pid: row.pid, start: row.start });
    }
    return observation;
  };
  const result = await recoverControllerOperationState(f.input, f.ports).catch(() => null);
  if (holdsRequiredResource) {
    expect(result?.outcome).not.toBe("restored");
    expect(unresolvedAdoption(f.runRoot)).toBe("original");
  } else {
    expect(result?.outcome).toBe("restored");
    expect(unresolvedAdoption(f.runRoot)).toBeNull();
  }
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
});

for (const message of ["restoration-observation-unproved", "private-input-value-must-not-escape"]) test(`recovery exposes only a fixed diagnostic code: ${message.startsWith("restoration-")}`, async () => {
  const f = await fixture();
  f.ports.current!.observe = async () => { throw Error(message); };
  const error = await recoverControllerOperationState(f.input, f.ports).catch(error => error);
  expect(error.code).toBe("invalid_usage");
  if (message.startsWith("restoration-")) expect(error.message).toContain(message);
  else expect(error.message).not.toContain(message);
  expect(restorationSnapshot(restorationReceiptPath(f.runRoot, "original"), true).bytes).toBeNull();
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
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

for (const contradictoryLaunch of [false, true]) test(`recorded modern Host replacement reconciles retained launch: ${contradictoryLaunch ? "conflict" : "matching"}`, async () => {
  const f = await fixture(true), journal = JSON.parse(await readFile(f.files[1]!, "utf8")), marker = JSON.parse(await readFile(f.files[2]!, "utf8"));
  const store = JSON.parse(await readFile(f.files[0]!, "utf8"));
  const lifetime = { pid: f.candidate.pid, start: f.candidate.start };
  const diagnostic = { code: "fixture-failure", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired", child: { ...lifetime, exitCode: null, signal: null } };
  Object.assign(marker, lifetime);
  journal.failure = diagnostic;
  journal.creation = { version: 1, operationId: "original", host: lifetime, tempSupervisor: { pid: journal.tempSupervisor.pid, start: journal.tempSupervisor.start },
    guardian: { pid: 90001, start: 1 }, holder: { pid: 90002, start: 2 }, compile: marker.compile, preloadSha256: marker.preloadSha256, launch: structuredClone(f.q.launch) };
  store.original.prefix.diagnostic = diagnostic;
  for (const [i, row] of [store, journal, marker].entries()) await writeFile(f.files[i]!, JSON.stringify(row));
  f.q.original.operations = restorationSnapshot(f.files[0]!).sha256!; f.q.original.journal = restorationSnapshot(f.files[1]!).sha256!; f.q.original.marker = restorationSnapshot(f.files[2]!).sha256!;
  if (contradictoryLaunch) f.q.launch.argvDigest = "b".repeat(64);
  await f.save();
  const result = await recoverControllerOperationState(f.input, f.ports);
  expect(result.outcome).toBe(contradictoryLaunch ? "blocked" : "restored");
  if (contradictoryLaunch) { expect(result.reason).toBe("restoration-evidence-unproven"); expect(f.reads()).toBe(0); }
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

for (const kind of ["live-outside-scope", "upper-endpoint", "zero-start", "independent-owner", "journal-conflict"] as const) test(`partial creation preserves diagnostic child obligation: ${kind}`, async () => {
  const f = await fixture();
  const child = kind === "upper-endpoint" ? f.q.hostScope.upper : f.ports.processes.inspect(f.ports.gatewayPid()!)!;
  const diagnostic = { code: "fixture-child", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired",
    child: { pid: child.pid, start: kind === "zero-start" ? 0 : child.start, exitCode: null, signal: null } };
  const store = JSON.parse(await readFile(f.files[0]!, "utf8")), journal = JSON.parse(await readFile(f.files[1]!, "utf8"));
  store.original.prefix.diagnostic = diagnostic; journal.failure = diagnostic;
  if (kind === "journal-conflict") journal.host = f.candidate;
  if (kind === "independent-owner") f.q.resources.independentOwners.push({ pid: child.pid, start: child.start });
  await writeFile(f.files[0]!, JSON.stringify(store)); await writeFile(f.files[1]!, JSON.stringify(journal));
  f.q.original.operations = restorationSnapshot(f.files[0]!).sha256!; f.q.original.journal = restorationSnapshot(f.files[1]!).sha256!; await f.save();
  const before = await Promise.all(f.files.map(path => readFile(path))), targets: Array<Array<{ pid: number; start: number }>> = [];
  const observe = f.ports.current!.observe;
  f.ports.current!.observe = async (q, target) => { targets.push(target.hosts); return observe(q, target); };
  const result = await recoverControllerOperationState(f.input, f.ports).catch(() => null);
  expect(result?.outcome).not.toBe("restored");
  expect((await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).restoration).toBeUndefined();
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
  if (kind === "live-outside-scope") { expect(targets).toHaveLength(1); expect(targets[0]).toContainEqual(expect.objectContaining({ pid: child.pid, start: child.start })); }
  else expect(targets).toHaveLength(0);
});

test("valid absent diagnostic child remains a proof target without inventing creation metadata", async () => {
  const f = await fixture(), child = { pid: 90123, start: f.q.hostScope.upper.start + 10 };
  const diagnostic = { code: "fixture-child", phase: "spawn-temp", recoveryRequired: true, guardianEnd: "expired", child: { ...child, exitCode: null, signal: null } };
  const store = JSON.parse(await readFile(f.files[0]!, "utf8")), journal = JSON.parse(await readFile(f.files[1]!, "utf8"));
  store.original.prefix.diagnostic = diagnostic; journal.failure = diagnostic;
  await writeFile(f.files[0]!, JSON.stringify(store)); await writeFile(f.files[1]!, JSON.stringify(journal));
  f.q.original.operations = restorationSnapshot(f.files[0]!).sha256!; f.q.original.journal = restorationSnapshot(f.files[1]!).sha256!; await f.save();
  const before = await Promise.all(f.files.map(path => readFile(path))), observe = f.ports.current!.observe;
  f.ports.current!.observe = async (q, targets) => { expect(targets.hosts).toContainEqual(expect.objectContaining(child)); return observe(q, targets); };
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  expect(unresolvedAdoption(f.runRoot)).toBeNull();
  expect(await Promise.all(f.files.map(path => readFile(path)))).toEqual(before);
});

test("retired live-modeld qualification and completed-proof shape grant no authority", async () => {
  const f = await fixture();
  (f.q.resources as unknown as Record<string, unknown>).modeld = { kind: "same-epoch-unused", owner: f.q.view.anchor,
    socketPath: join(f.runRoot, "modeld.sock"), codePath: "/fixture/entry.js", epoch: f.q.view.bootId, codeSha256: hash, provenanceSha256: hash };
  await f.save();
  expect((await recoverControllerOperationState(f.input, f.ports)).reason).toBe("restoration-evidence-unproven");
  f.q.resources.modeld = { kind: "absent", owners: [], socketPath: join(f.runRoot, "modeld.sock") }; await f.save();
  expect((await recoverControllerOperationState(f.input, f.ports)).outcome).toBe("restored");
  const path = restorationReceiptPath(f.runRoot, "original"), row = JSON.parse(await readFile(path, "utf8"));
  row.proof.kind = "qualified-current-retirement";
  const bytes = JSON.stringify(row); await writeFile(path, bytes);
  await writeFile(`${path}.complete.json`, JSON.stringify({ version: 2, operationId: "original", publication: "complete", receiptSha256: sha256Text(bytes) }));
  expect((await recoverControllerOperationState({ ...f.input, confirm: false }, f.ports)).reason).toBe("restoration-receipt-unavailable");
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
});

test("current modeld absence binds the canonical socket and releases its real service gate on cancellation", async () => {
  const f = await fixture(), canonical = f.q.resources.modeld.socketPath;
  f.q.resources.modeld.socketPath = join(f.runRoot, "unrelated-empty.sock");
  await expect(Effect.runPromise(Effect.scoped(acquireCurrentRestorationPorts(f.q, f.runRoot)))).rejects.toBeTruthy();
  expect(restorationSnapshot(`${canonical}.owner.json`, true).bytes).toBeNull();
  f.q.resources.modeld.socketPath = canonical;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    yield* acquireCurrentRestorationPorts(f.q, f.runRoot);
    entered(); yield* Effect.never;
  })));
  await held;
  const start = () => startModeldProcess({ durableRoot: f.root, runRoot: f.runRoot, env: {},
    fetch: Object.assign(async () => { throw Error("network forbidden"); }, { preconnect: async () => {} }) as typeof fetch });
  try {
    await expect(start()).rejects.toMatchObject({ message: expect.stringContaining("daemon_socket_busy") });
    expect(restorationSnapshot(`${canonical}.owner.json`, true).bytes).toBeNull();
  } finally { await Effect.runPromise(Fiber.interrupt(fiber)); }
  const service = await start();
  try {
    expect(service.ensure.kind).toBe("owned");
    await expect(Effect.runPromise(Effect.scoped(acquireCurrentRestorationPorts(f.q, f.runRoot)))).rejects.toBeTruthy();
  } finally { await service.stop(); }
  expect(unresolvedAdoption(f.runRoot)).toBe("original");
});

import * as syncFs from "node:fs";
import { expect, test, spyOn } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { liveControlResourcesLayer, readControllerOperation } from "../src/internal/roots/controller-program.node.ts";
import { runTransientAdoptOperation } from "../src/internal/process/transient-adopt.ts";
import type { IdentityMarker } from "../src/internal/process/identity-op.ts";
import { FakeProcessTree } from "./fake-tree.ts";
import { expectedCompileReceipt } from "../src/internal/host/compile-receipt.ts";
import type { PatchProfile } from "../src/internal/host/profile.ts";

const profile: PatchProfile = { profileId: "failure-fixture", sourceSha256: "a".repeat(64), transformedSourceSha256: "b".repeat(64), slices: [] };

for (const scenario of ["delayed-gateway", "guardian-expiry", "identity-reuse", "child-exit"] as const) test(`kernel and original filesystem owner retain ${scenario} failure and refuse replay`, async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-controller-failure-")), tree = new FakeProcessTree();
  const wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  tree.spawn("host", { parent: supervisor });
  let temp: ReturnType<typeof tree.spawn> | null = null, host: ReturnType<typeof tree.spawn> | null = null;
  let marker: IdentityMarker | null = null, calls = 0;
  const ownership = new AbortController();
  const classify = (row: { pid: number }) => {
    const role = tree.roles().find(item => item.pid === row.pid)?.role;
    return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null;
  };
  const layer = liveControlResourcesLayer({
    inspect: () => ({ ok: true, reason: null, strategy: "transient" }),
    adopt: async command => {
      calls++;
      return runTransientAdoptOperation({
        operationId: command.operationId, ephemeralRoot: join(root, "run"), reviewedProfile: profile,
        diskSha: () => profile.sourceSha256, processes: tree, classify, now: Date.now,
        readMarker: () => marker, readGatewayPid: () => null,
        waitGone: async identity => !tree.inspect(identity.pid) || tree.inspect(identity.pid)!.start !== identity.start,
        spawnTempSupervisor: async () => { temp = tree.spawn("temp-supervisor"); host = tree.spawn("host", { parent: temp }); return temp; },
        waitNewHost: async () => host,
        waitReady: async () => {
          marker = { operationId: command.operationId, pid: host!.pid, start: host!.start, mode: "identity",
            transformed: true, compiled: true, modeld: false, compile: expectedCompileReceipt(profile) };
          if (scenario === "guardian-expiry") ownership.abort();
          if (scenario === "identity-reuse") tree.spawn("temp-supervisor", { pid: temp!.pid });
          if (scenario === "child-exit") tree.kill(host!);
          return null;
        },
        childEvidence: () => host ? { pid: host.pid, start: host.start, exitCode: scenario === "child-exit" ? 17 : null, signal: null } : undefined,
        armGuardian: async () => ({ ok: true, signal: ownership.signal, end: () => ownership.signal.aborted ? "expired" : "released",
          release: () => { tree.signal(wrapper, "SIGCONT"); } }),
        hasGrokboxPreload: row => row.pid === host?.pid,
      });
    },
  });
  const request = { intent: "apply" as const, confirmed: true, operationId: "original", boxRoot: root, strategy: "transient" as const };
  const execute = () => Effect.runPromise(runControllerOperation(request).pipe(Effect.provide(layer)));
  const result = await execute();
  const expectedCode = scenario === "guardian-expiry" ? "guardian-ownership-ended" : "marker-mismatch";
  expect(result).toMatchObject({ outcome: "recovery-required", reason: expectedCode, signaled: true, spawned: true, guardian: true,
    diagnostic: { code: expectedCode, phase: "spawn-temp", recoveryRequired: true, readiness: { compiled: true, gatewayPid: null } } });
  const record = readControllerOperation(root, "original");
  expect(record).toMatchObject({ state: "unknown", prefix: { signaled: true, spawned: true, guardian: true, diagnostic: result.diagnostic } });
  expect(JSON.parse(await readFile(join(root, "run", "state", "adopt-op.json"), "utf8"))).toMatchObject({ operationId: "original", phase: "recovery-required", failure: result.diagnostic });
  if (scenario === "identity-reuse") {
    expect(tree.alive(temp!.pid)).toBe(true);
    expect(tree.signals.some(row => row.pid === temp!.pid && row.signal === "SIGTERM")).toBe(false);
    expect(result.diagnostic?.cleanup).toContainEqual({ role: "temp-supervisor", pid: temp!.pid, start: temp!.start,
      signalSent: false, outcome: "unproven", observed: "different-identity" });
  }
  if (scenario === "guardian-expiry") expect(tree.signals.filter(row => row.signal === "SIGTERM")).toHaveLength(4);
  expect(await execute()).toMatchObject({ outcome: "unknown", reason: "uncertain-operation" });
  expect(calls).toBe(1);
  expect(readControllerOperation(root, "original")).toEqual(record);
});

for (const publication of ["before", "attestation-inflight", "journal-inflight"] as const) test(`ownership expiry ${publication} preserves publication uncertainty`, async () => {
  const { writeFile } = await import("node:fs/promises");
  const { writeAttestation } = await import("../src/internal/io/authority.node.ts");
  const root = await mkdtemp(join(tmpdir(), "grokbox-adopt-commit-expiry-"));
  const previous = '{"operationId":"previous","preserved":true}\n';
  await writeFile(join(root, "attestation.json"), previous);
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  tree.spawn("host", { parent: supervisor });
  const ownership = new AbortController();
  let host: ReturnType<typeof tree.spawn> | null = null;
  let restore: (() => void) | undefined, inFlightPublished = false;
  let result;
  try { result = await runTransientAdoptOperation({
    operationId: "original", ephemeralRoot: root, reviewedProfile: profile, diskSha: () => profile.sourceSha256,
    processes: tree, classify: row => {
      const role = tree.roles().find(item => item.pid === row.pid)?.role;
      return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null;
    }, now: Date.now, readMarker: () => null, readGatewayPid: () => host?.pid ?? null,
    waitGone: async row => !tree.inspect(row.pid),
    spawnTempSupervisor: async () => { const temp = tree.spawn("temp-supervisor"); host = tree.spawn("host", { parent: temp }); return temp; },
    waitNewHost: async () => host,
    waitReady: async pid => ({ operationId: "original", pid, start: host!.start, mode: "identity", compiled: true, transformed: true, modeld: false, compile: expectedCompileReceipt(profile) }),
    armGuardian: async () => ({ ok: true, signal: ownership.signal, end: () => ownership.signal.aborted ? "expired" : "released", release: () => {
      tree.signal(wrapper, "SIGCONT"); tree.spawn("supervisor", { parent: wrapper });
    } }),
    hasGrokboxPreload: row => row.pid === host?.pid,
    persistAttestation: async (value, beforePublish) => {
      if (publication === "before") ownership.abort();
      else {
        const rename = syncFs.renameSync;
        const spy = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
          const selected = publication === "attestation-inflight" ? String(to).endsWith("/attestation.json")
            : String(to).endsWith("/state/adopt-op.json") && JSON.parse(syncFs.readFileSync(from, "utf8")).phase === "attested";
          if (selected) ownership.abort();
          rename(from, to);
          if (selected) inFlightPublished = true;
        });
        restore = () => spy.mockRestore();
      }
      await writeAttestation(root, value, beforePublish);
    },
  }); } finally { restore?.(); }
  expect(result).toMatchObject({ ok: false, recoveryRequired: true, code: "guardian-ownership-ended", diagnostic: { phase: publication === "journal-inflight" ? "attested" : "commit-attestation" } });
  if (publication === "before") expect(await readFile(join(root, "attestation.json"), "utf8")).toBe(previous);
  else {
    expect(inFlightPublished).toBe(true);
    expect(result?.committedAttestation?.operationId).toBe("original");
    expect(JSON.parse(await readFile(join(root, "state", "adoption-owner.json"), "utf8"))).toMatchObject({ operationId: "original", state: "unresolved" });
  }
  expect(tree.alive(host!.pid)).toBe(true); // Handoff ended cleanup authority; never signal a now-adopted Host.
  expect(JSON.parse(await readFile(join(root, "state", "adopt-op.json"), "utf8"))).toMatchObject({ operationId: "original", phase: "recovery-required", failure: { phase: publication === "journal-inflight" ? "attested" : "commit-attestation" } });
});

test("an inner identity-lease failure reaches the kernel receipt without becoming commit-failed", async () => {
  const { acquireOperationLease, operationLockPath } = await import("../src/internal/io/operation-lease.node.ts");
  const { commitObservedAdopt } = await import("../src/internal/roots/controller-program.node.ts");
  const root = await mkdtemp(join(tmpdir(), "grokbox-controller-inner-refusal-")), runRoot = join(root, "run");
  const held = await acquireOperationLease(operationLockPath(runRoot), "other");
  if (!held.ok) throw Error("fixture lease unavailable");
  try {
    const layer = liveControlResourcesLayer({ inspect: () => ({ ok: true, reason: null, strategy: "transient" }),
      adopt: async () => (await commitObservedAdopt({ operationId: "original", ephemeralRoot: runRoot,
        observe: () => { throw Error("must not observe past held lease"); }, modeldReady: async () => false }))! });
    const result = await Effect.runPromise(runControllerOperation({ intent: "apply", confirmed: true,
      operationId: "original", boxRoot: root, strategy: "transient" }).pipe(Effect.provide(layer)));
    expect(result).toMatchObject({ outcome: "recovery-required", reason: "lock-conflict", signaled: false,
      spawned: false, guardian: false, diagnostic: { code: "lock-conflict", phase: "preflight" } });
    expect(readControllerOperation(root, "original")).toMatchObject({ state: "unknown", prefix: { diagnostic: result.diagnostic } });
  } finally { await held.lock.release(); }
});

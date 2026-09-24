import { expect, test, spyOn } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionAuthority } from "@grokbox/runtime-kernel/ports";
import { modeldStorePorts } from "../src/internal/io/store.node.ts";
import { observeAttestation, writeAttestation } from "../src/internal/io/authority.node.ts";
import { writeAdoptOpState } from "../src/internal/process/transient-adopt.ts";
import { writeAdoptionOwner, adoptionOwnerPath, adoptionEvidencePath } from "../src/internal/process/adopt-evidence.ts";
import { bindCompiledHost } from "../src/internal/host/host-binding.ts";
import { liveAdmissionAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import * as observation from "../src/internal/io/observation.node.ts";

async function fixture(complete = true) {
  const root = await mkdtemp(join(tmpdir(), "controller-authority-")), runRoot = join(root, "run");
  const host = { pid: 31337, start: 100, uid: process.getuid!(), exe: "/fixture/node", cmdline: ["node", "/fixture/host-main.cjs"], ppid: 1, ancestry: [1] };
  const compile = { profileId: "fixture", profileSha256: "a".repeat(64), sourceSha256: "b".repeat(64), transformedSha256: "c".repeat(64) };
  const attestation = { coverage: "attested" as const, mode: "route" as const, modeld: true as const, diskSha: compile.sourceSha256, pid: host.pid, start: host.start, identity: host,
    at: new Date().toISOString(), launchMode: "transient-adopt" as const, operationId: "original", profileId: compile.profileId, transformedSha: compile.transformedSha256, compile };
  const journal = { launchMode: "transient-adopt" as const, phase: "attested" as const, operationId: "original", compile, tempSupervisor: null,
    adoptingSupervisor: { ...host, pid: 31336, start: 99 }, host };
  await writeFile(join(root, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }));
  await writeAttestation(runRoot, attestation);
  if (complete) { await writeAdoptOpState(runRoot, journal); await writeAdoptionOwner(runRoot, "original", "complete"); }
  await mkdir(join(root, "state"));
  await writeFile(join(root, "state", "controller-operations.json"), JSON.stringify(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`older-${i}`, { state: "unknown", fingerprint: `older-${i}` }]))));
  const binding = bindCompiledHost(host, "original", compile);
  const request = { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hostEpoch: { compile: binding.generationId, source: binding.sourceSha,
    hostIdentity: binding.identitySha, profile: compile.profileSha256, bridgeDigest: "d".repeat(64), wireVersion: "8" }, serviceEpoch: { incarnationId: "fixture-service" }, turnId: "fixture-turn", stepId: "fixture-step",
    operationId: "fixture-context", sessionId: "fixture-session", rootId: "fixture-root", rootRevision: "fixture-revision",
    selection: { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", modelId: "fixture/model", selectionRevision: "fixture-selection" },
    snapshot: { version: 1 as const, profileId: compile.profileId, abiIdentity: "fixture-abi", systemMessages: [], messages: [], tools: [], options: {}, snapshotDigest: "e".repeat(64) } };
  return { root, runRoot, host, journal, attestation, request, read: () => modeldStorePorts(root, runRoot).authority() };
}

test("completed generation admits through current/currentContext; unrelated historical unknowns are preserved", async () => {
  const f = await fixture(), before = await readFile(join(f.root, "state", "controller-operations.json"));
  expect((await f.read()).state).toBe("committed");
  const outcomes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const authority = yield* AdmissionAuthority;
    return [yield* authority.current(f.request), yield* authority.currentContext!(f.request)];
  }).pipe(Effect.provide(liveAdmissionAuthorityLayer(f.root, f.runRoot, ownedOwnershipReader(f.host.pid))))));
  expect(outcomes.map(row => row.admitted)).toEqual([true, true]);
  expect(await readFile(join(f.root, "state", "controller-operations.json"))).toEqual(before);
});

for (const launchMode of ["direct-launch", undefined] as const) test(`route with ${launchMode ?? "absent launch mode"} and no completion evidence denies store/current/currentContext`, async () => {
  const f = await fixture(false), before = await readFile(join(f.root, "state", "controller-operations.json"));
  await writeAttestation(f.runRoot, { ...f.attestation, launchMode });
  // JSON serialization omits the undefined variant; neither fixture has an owner or journal.
  expect(await observation.observeText(adoptionOwnerPath(f.runRoot))).toEqual({ state: "missing" });
  expect(await observation.observeText(join(f.runRoot, "state", "adopt-op.json"))).toEqual({ state: "missing" });
  expect(await f.read()).toEqual({ state: "unavailable" });
  const read = ownedOwnershipReader(f.host.pid); let reads = 0;
  const outcomes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const authority = yield* AdmissionAuthority;
    return [yield* authority.current(f.request), yield* authority.currentContext!(f.request)];
  }).pipe(Effect.provide(liveAdmissionAuthorityLayer(f.root, f.runRoot, (ids, signal) => { reads++; return read(ids, signal); })))));
  expect(outcomes).toEqual([{ admitted: false, reason: "authority_not_committed" }, { admitted: false, reason: "authority_not_committed" }]);
  expect(reads).toBe(0);
  expect(await readFile(join(f.root, "state", "controller-operations.json"))).toEqual(before);
});

test("direct identity coverage remains observable without adoption completion and grants no route authority", async () => {
  const f = await fixture(false);
  const identity = { coverage: "attested" as const, mode: "identity" as const, modeld: false as const, diskSha: f.attestation.diskSha,
    pid: f.host.pid, start: f.host.start, identity: f.host, at: f.attestation.at, windowMs: 12, launchMode: "direct-launch" as const };
  await writeAttestation(f.runRoot, identity);
  expect(await observeAttestation(f.runRoot)).toEqual({ state: "present", value: identity });
  expect(await f.read()).toEqual({ state: "unavailable" });
});

test("unresolved claim denies both mandatory consumers before any native ownership read despite a matching issued pair", async () => {
  const f = await fixture(); await writeAdoptionOwner(f.runRoot, "original", "unresolved"); let reads = 0;
  const outcomes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const authority = yield* AdmissionAuthority;
    return [yield* authority.current(f.request), yield* authority.currentContext!(f.request)];
  }).pipe(Effect.provide(liveAdmissionAuthorityLayer(f.root, f.runRoot, async () => { reads++; throw Error("must not read native ownership"); })))));
  expect(outcomes).toEqual([{ admitted: false, reason: "authority_not_committed" }, { admitted: false, reason: "authority_not_committed" }]); expect(reads).toBe(0);
});

for (const fault of ["missing", "invalid", "oversized", "symlink", "wrong-operation", "wrong-generation", "missing-archive"] as const) test(`authority rejects ${fault} completion evidence`, async () => {
  const f = await fixture(), ownerPath = adoptionOwnerPath(f.runRoot);
  if (fault === "missing" || fault === "symlink") await rename(ownerPath, `${ownerPath}.preserved`);
  if (fault === "symlink") await symlink(`${ownerPath}.preserved`, ownerPath);
  if (fault === "invalid") await writeFile(ownerPath, '{"state":"complete"}');
  if (fault === "oversized") await writeFile(ownerPath, "x".repeat(128 * 1024 + 1));
  if (fault === "wrong-operation") { const row = JSON.parse(await readFile(ownerPath, "utf8")); row.operationId = "other"; await writeFile(ownerPath, JSON.stringify(row)); }
  if (fault === "missing-archive") await rename(adoptionEvidencePath(f.runRoot, "original", "journal"), join(f.runRoot, "original-journal-preserved"));
  if (fault === "wrong-generation") {
    const identity = { ...f.host, start: f.host.start + 1 };
    await writeAttestation(f.runRoot, { ...f.attestation, start: identity.start, identity });
    await writeAdoptOpState(f.runRoot, { ...f.journal, host: identity });
  }
  expect((await f.read()).state).not.toBe("committed");
});

test("completion changes between authority snapshots cannot combine with the earlier generation", async () => {
  const f = await fixture(), read = observation.observeJson; let ownerReads = 0;
  const spy = spyOn(observation, "observeJson").mockImplementation(async <T>(path: string, parse: (value: unknown) => T) => {
    const result = await read(path, parse);
    if (path === adoptionOwnerPath(f.runRoot) && ++ownerReads === 1) await writeAdoptionOwner(f.runRoot, "original", "unresolved");
    return result;
  });
  try { expect((await f.read()).state).toBe("pending"); expect(ownerReads).toBe(2); }
  finally { spy.mockRestore(); }
});

test("ownership callback cannot cross an adoption completion change", async () => {
  const f = await fixture(), read = ownedOwnershipReader(f.host.pid);
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    return yield* (yield* AdmissionAuthority).current(f.request);
  }).pipe(Effect.provide(liveAdmissionAuthorityLayer(f.root, f.runRoot, async (ids, signal) => {
    await writeAdoptionOwner(f.runRoot, "original", "unresolved"); return read(ids, signal);
  })))));
  expect(result).toMatchObject({ admitted: false, reason: "host_generation_changed" });
});

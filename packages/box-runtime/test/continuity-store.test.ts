import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openContinuityRecoveryStore, runContinuityReferenceChange, measureContinuityStorage, maintainObservationStorage, openMonitorStore, openContinuityObservationBridge } from "../src/runtime.ts";
import { continuityStorePolicy, recoveryManifest, type ContinuityEffectIntent, type ContinuityStorePolicy, type RecoveryPublication } from "@grokbox/runtime-kernel/continuity";
import { continuitySourceKey, type ReferenceChange, type ContinuitySource, type ContinuityEvent } from "@grokbox/runtime-kernel/observation";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import type { ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";
import { CONT_AGENT, CONT_POLICY, CONT_SCOPE, materialFixture } from "./fixtures/continuity-material.ts";

async function fixture(policy?: Partial<ContinuityStorePolicy>, hooks: ContinuityStoreHooks = {}) {
  const base = await mkdtemp(join(tmpdir(), "continuity-store-")), root = join(base, "durable");
  await mkdir(root, { mode: 0o700 });
  const input = { durableRoot: root, scopeId: CONT_SCOPE, ...(policy ? { policy } : {}) };
  const store = openContinuityRecoveryStore(input, hooks);
  return { base, root, input, store, hooks, file: join(root, "continuity", "state.sqlite"),
    objects: join(root, "continuity", "objects"), staging: join(root, "continuity", "staging"),
    reopen: () => openContinuityRecoveryStore(input), close: () => rm(base, { recursive: true, force: true }) };
}
function effectIntent(snapshotId: string | null = null): ContinuityEffectIntent {
  return { operationId: randomUUID(), agentId: CONT_AGENT, kind: "initialize", inputDigest: "d".repeat(64), policyRevision: CONT_POLICY, snapshotId };
}
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const utf8 = (v: Uint8Array) => new TextDecoder().decode(v);
const protect = (reference: ReferenceChange["reference"]): ReferenceChange => ({ reference, action: "protect", requestId: randomUUID(), claimId: randomUUID() });

// No private native state, current config, model calls or production mutation.
test("construction and GET never initialize; explicit private initialization is idempotent", async () => {
  const f = await fixture(); try {
    expect(await readdir(f.root)).toEqual([]);
    await expect(f.store.status()).rejects.toThrow("continuity_not_initialized");
    expect(await readdir(f.root)).toEqual([]);
    expect(await f.store.initialize()).toEqual({ initialized: true, created: true });
    expect(await f.store.initialize()).toEqual({ initialized: true, created: false });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect((await stat(f.objects)).mode & 0o777).toBe(0o700);
    expect(await readdir(f.root)).toEqual(["continuity"]);
    expect(await f.store.status()).toMatchObject({ nativeImportProven: false, executionAuthorized: false, safetyRetirement: "not_qualified" });
  } finally { await f.close(); }
});

test("valid bytes and complete declared graph survive reopening; a fixed native slot is not a version", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const first = materialFixture("first", 100), second = materialFixture("second", 200);
    const a = await f.store.publish(first), b = await f.store.publish(second);
    expect(a.state).toBe("published"); expect(b.reference.revision).not.toBe(a.reference.revision);
    expect(first.manifest.root).toBe(second.manifest.root);
    const reopened = f.reopen();
    const old = await reopened.readSnapshot(first.requestId), current = await reopened.readSnapshot(second.requestId);
    expect([...old.content.values()].map(utf8)).toContain("USER_FACT:first");
    expect([...current.content.values()].map(utf8)).toContain("USER_FACT:second");
    expect(old.nativeImportProven).toBe(false);
    expect(await f.store.publish(first)).toMatchObject({ duplicate: true, state: "published", reference: a.reference });
    expect(await f.store.status()).toMatchObject({ publications: [{ state: "published", count: 2 }] });
    const mutated = { ...first, manifest: { ...first.manifest, source: { ...first.manifest.source, transcriptThrough: 8 } } };
    await expect(f.store.publish(mutated)).rejects.toThrow("continuity_conflict");
  } finally { await f.close(); }
});

test("manifest validation rejects missing dependencies, cycles, wrong hashes, roles and unbounded fields before any reservation", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const base = materialFixture();
    const bad: RecoveryPublication[] = [
      { ...base, manifest: { ...base.manifest, parts: base.manifest.parts.map(p => p.id === "root-slot" ? { ...p, dependencies: ["absent"] } : p) } },
      { ...base, manifest: { ...base.manifest, parts: base.manifest.parts.map(p => p.id === "message" ? { ...p, dependencies: ["root-slot"] } : p) } },
      { ...base, manifest: { ...base.manifest, root: "absent" } },
      { ...base, manifest: { ...base.manifest, prompt: "must not be in manifest" } as never },
      { ...base, content: new Map([...base.content].map(([h, b]) => [h, new Uint8Array(b.length)])) },
    ];
    for (const item of bad) await expect(f.store.publish(item)).rejects.toThrow("continuity_");
    expect((await f.store.status()).publications).toEqual([]); expect(await readdir(f.objects)).toEqual([]);
    expect(() => recoveryManifest({ ...base.manifest, parts: [...base.manifest.parts, base.manifest.parts[0]] }, continuityStorePolicy())).toThrow();
  } finally { await f.close(); }
});

test("caller mutations after async reservation cannot change the published input", async () => {
  const gate = barrier(), entered = barrier(); const f = await fixture(undefined, { afterReservation: async () => { entered.release(); await gate.promise; } });
  try {
    await f.store.initialize(); const input = materialFixture("frozen");
    const work = f.store.publish(input); await entered.promise;
    for (const bytes of input.content.values()) bytes.fill(0);
    input.manifest.source.contextRevision = "changed-later";
    gate.release(); await work;
    expect([...(await f.store.readSnapshot(input.requestId)).content.values()].map(utf8)).toContain("USER_FACT:frozen");
  } finally { gate.release(); await f.close(); }
});

test("reservation failure remains explicit; retry does not silently publish and abandon releases only its own staging", async () => {
  const f = await fixture(undefined, { afterReservation: async () => { throw new Error("synthetic interruption"); } });
  try {
    await f.store.initialize(); const input = materialFixture();
    await expect(f.store.publish(input)).rejects.toThrow();
    expect(await f.reopen().publication(input.requestId)).toMatchObject({ state: "reserved" });
    expect(await f.reopen().publish(input)).toMatchObject({ state: "reserved", duplicate: true });
    await expect(f.store.readSnapshot(input.requestId)).rejects.toThrow("continuity_not_found");
    expect(await f.store.reconcilePublication(input.requestId, "verify")).toMatchObject({ state: "reserved" });
    expect(await f.store.reconcilePublication(input.requestId, "abandon")).toMatchObject({ state: "abandoned" });
    expect(await f.store.status()).toMatchObject({ reservedBytes: 0 });
    expect(await f.reopen().publish(input)).toMatchObject({ state: "abandoned", duplicate: true });
  } finally { await f.close(); }
});

test("partial object writes stay unpublished; explicit abandonment accounts orphan content before GC", async () => {
  const f = await fixture(undefined, { afterObject: async index => { if (index === 0) throw Error("stop after one"); } });
  try {
    await f.store.initialize(); const input = materialFixture();
    await expect(f.store.publish(input)).rejects.toThrow();
    expect(await readdir(f.objects)).toHaveLength(1);
    expect(await f.store.reconcilePublication(input.requestId, "verify")).toMatchObject({ state: "reserved" });
    expect(await f.store.reconcilePublication(input.requestId, "abandon")).toMatchObject({ state: "abandoned" });
    expect((await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 })).reclaimedBytes).toBeGreaterThan(0);
    expect(await readdir(f.objects)).toHaveLength(0);
  } finally { await f.close(); }
});

test("complete bytes before metadata commit can be reconciled once without reading the source again", async () => {
  const f = await fixture(undefined, { beforeCommit: async label => { if (label === "publish-material") throw Error("before commit"); } });
  try {
    await f.store.initialize(); const input = materialFixture("complete-but-not-published");
    await expect(f.store.publish(input)).rejects.toThrow();
    expect(await f.store.publication(input.requestId)).toMatchObject({ state: "reserved" });
    const reopened = f.reopen();
    expect(await reopened.reconcilePublication(input.requestId, "verify")).toMatchObject({ state: "published" });
    expect(await reopened.reconcilePublication(input.requestId, "verify")).toMatchObject({ state: "published", duplicate: true });
    expect([...(await reopened.readSnapshot(input.requestId)).content.values()].map(utf8)).toContain("USER_FACT:complete-but-not-published");
  } finally { await f.close(); }
});

test("lost publish acknowledgement reports unknown; fresh read proves the original publication, not a second one", async () => {
  const f = await fixture(undefined, { afterCommit: async label => { if (label === "publish-material") throw Error("ack lost"); } });
  try {
    await f.store.initialize(); const input = materialFixture();
    await expect(f.store.publish(input)).rejects.toThrow("continuity_commit_unknown");
    const reopened = f.reopen(); expect(await reopened.publication(input.requestId)).toMatchObject({ state: "published" });
    expect(await reopened.publish(input)).toMatchObject({ duplicate: true });
    expect((await reopened.status()).publications).toEqual([{ state: "published", count: 1 }]);
  } finally { await f.close(); }
});

test("two current snapshots, last native point and active claims survive retention; released old snapshots do not resurrect", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const a = materialFixture("native-a", 100), b = materialFixture("summary-b", 200, "semantic_resume"), c = materialFixture("summary-c", 300, "semantic_resume");
    const ref = (await f.store.publish(a)).reference; await f.store.publish(b); await f.store.publish(c);
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(a.requestId)).state).toBe("published");
    const claim = protect(ref), claim2 = protect(ref);
    expect(await runContinuityReferenceChange({ owners: f.store.owners, change: claim })).toMatchObject({ receipt: { state: "protected" } });
    await runContinuityReferenceChange({ owners: f.store.owners, change: claim2 });
    await f.store.publish(materialFixture("new-native", 400)); await f.store.publish(materialFixture("latest", 500));
    await f.store.owners.recovery.changeReference({ ...claim, action: "release", requestId: randomUUID() });
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(a.requestId)).state).toBe("published");
    expect(await f.store.owners.recovery.changeReference(claim)).toMatchObject({ state: "conflict" });
    await f.store.owners.recovery.changeReference({ ...claim2, action: "release", requestId: randomUUID() });
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect(await f.store.publication(a.requestId)).toMatchObject({ state: "retired" });
    expect(await f.store.publish(a)).toMatchObject({ state: "retired", duplicate: true });
    await expect(f.store.readSnapshot(a.requestId)).rejects.toThrow("continuity_not_found");
  } finally { await f.close(); }
});

test("protect and GC share a real SQLite write boundary across independent store instances", async () => {
  const f = await fixture(); const entered = barrier(), release = barrier();
  try {
    await f.store.initialize(); const old = materialFixture("old", 100), ref = (await f.store.publish(old)).reference;
    await f.store.publish(materialFixture("middle", 200)); await f.store.publish(materialFixture("last", 300));
    const owner = openContinuityRecoveryStore(f.input, { beforeCommit: async label => { if (label === "reference-change") { entered.release(); await release.promise; } } });
    const protectedPromise = owner.owners.recovery.changeReference(protect(ref)); await entered.promise;
    const gc = f.reopen().owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    await sleep(20); release.release(); await protectedPromise; await gc;
    expect((await f.store.readSnapshot(old.requestId)).state).toBe("published");
  } finally { release.release(); await f.close(); }
});

test("metadata retirement commits before unlink, including a crash between its two phases", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const old = materialFixture("old", 100); await f.store.publish(old);
    await f.store.publish(materialFixture("middle", 200)); const latest = materialFixture("last", 300); await f.store.publish(latest);
    const interrupted = openContinuityRecoveryStore(f.input, { afterCommit: async label => { if (label === "retire-snapshots") throw Error("stop before unlink"); } });
    await expect(interrupted.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 })).rejects.toThrow("continuity_commit_unknown");
    expect((await f.store.publication(old.requestId)).state).toBe("retired");
    const brokenCleanup = openContinuityRecoveryStore(f.input, { beforeCommit: async label => { if (label === "reclaim-objects") throw Error("after unlink before SQL"); } });
    await expect(brokenCleanup.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 })).rejects.toThrow();
    expect((await f.store.readSnapshot(latest.requestId)).state).toBe("published");
    await f.reopen().owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(latest.requestId)).state).toBe("published");
  } finally { await f.close(); }
});

test("durable effect intent binds content, is claimed once, and unknown retains recovery references", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const old = materialFixture("source", 100); await f.store.publish(old);
    const intent = effectIntent(old.requestId), prepared = await f.store.prepareEffect(intent), effectId = randomUUID();
    expect(prepared).toMatchObject({ state: "prepared", dispatch: false, executionAuthorized: false });
    await expect(f.store.prepareEffect({ ...intent, inputDigest: "e".repeat(64) })).rejects.toThrow("continuity_conflict");
    const claims = await Promise.all(Array.from({ length: 6 }, () => f.reopen().claimEffect(intent.operationId, effectId, CONT_POLICY)));
    expect(claims.filter(r => r.dispatch)).toHaveLength(1);
    expect(await f.reopen().operation(intent.operationId)).toMatchObject({ state: "effect_unknown", dispatch: false });
    await f.store.publish(materialFixture("later1", 200)); await f.store.publish(materialFixture("later2", 300));
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.readSnapshot(old.requestId)).state).toBe("published");
    expect(await f.store.owners.safety.maintain({ nowMs: Date.now(), maxItems: 64 })).toMatchObject({ state: "blocked", blockedBy: ["effect_unknown"] });
    await expect(f.store.claimEffect(intent.operationId, randomUUID(), CONT_POLICY)).rejects.toThrow("continuity_conflict");
    await f.store.settleEffect(intent.operationId, effectId, "succeeded", "c".repeat(64));
    expect(await f.reopen().claimEffect(intent.operationId, effectId, CONT_POLICY)).toMatchObject({ dispatch: false, state: "succeeded" });
    await f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    expect((await f.store.publication(old.requestId)).state).toBe("retired");
  } finally { await f.close(); }
});

test("lost claim acknowledgement never grants another dispatch, even when no effect was actually sent", async () => {
  const f = await fixture(undefined, { afterCommit: async label => { if (label === "claim-effect") throw Error("lost reply"); } });
  try {
    await f.store.initialize(); const intent = effectIntent(), effectId = randomUUID(); await f.store.prepareEffect(intent);
    await expect(f.store.claimEffect(intent.operationId, effectId, CONT_POLICY)).rejects.toThrow("continuity_commit_unknown");
    expect(await f.reopen().claimEffect(intent.operationId, effectId, CONT_POLICY)).toMatchObject({ dispatch: false, state: "effect_unknown" });
    await f.store.settleEffect(intent.operationId, effectId, "not_executed", "f".repeat(64));
    expect(await f.reopen().claimEffect(intent.operationId, effectId, CONT_POLICY)).toMatchObject({ dispatch: false, state: "not_executed" });
    await expect(f.store.settleEffect(intent.operationId, effectId, "succeeded", "f".repeat(64))).rejects.toThrow("continuity_conflict");
  } finally { await f.close(); }
});

test("finite metadata capacity blocks new dispatch intent without deleting unknown records or old material", async () => {
  const f = await fixture({ maxMetadataBytes: 128 * 1024 }); try {
    await f.store.initialize(); const input = materialFixture(); await f.store.publish(input);
    const unknown = effectIntent(input.requestId), effectId = randomUUID(); await f.store.prepareEffect(unknown); await f.store.claimEffect(unknown.operationId, effectId, CONT_POLICY);
    let refused = false;
    for (let i = 0; i < 600; i++) {
      try { await f.store.prepareEffect(effectIntent()); } catch (e) { expect(String(e)).toContain("continuity_capacity"); refused = true; break; }
    }
    expect(refused).toBe(true);
    expect(await f.reopen().operation(unknown.operationId)).toMatchObject({ state: "effect_unknown" });
    expect((await f.store.readSnapshot(input.requestId)).state).toBe("published");
  } finally { await f.close(); }
});

test("object reservation budget declines a new snapshot without replacing the last reliable point", async () => {
  const f = await fixture({ maxObjectBytes: 140, maxSnapshotBytes: 70, maxPartBytes: 70 }); try {
    await f.store.initialize(); const old = materialFixture("a", 100); await f.store.publish(old);
    await expect(f.store.publish(materialFixture("b", 200))).rejects.toThrow("continuity_capacity");
    expect((await f.reopen().readSnapshot(old.requestId)).state).toBe("published");
    expect((await f.store.status()).reservedBytes).toBe(0);
  } finally { await f.close(); }
});

test("scope binding, private directory checks, symlink and corrupted object checks fail closed", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const input = materialFixture(); await f.store.publish(input);
    const wrong = openContinuityRecoveryStore({ ...f.input, scopeId: "f".repeat(64) });
    await expect(wrong.status()).rejects.toThrow("continuity_scope_mismatch");
    await chmod(f.objects, 0o755); await expect(f.store.readSnapshot(input.requestId)).rejects.toThrow("continuity_unsafe_path"); await chmod(f.objects, 0o700);
    const [h, bytes] = [...input.content][0]!, path = join(f.objects, `${h}.blob`), outside = join(f.base, "outside");
    await writeFile(outside, bytes, { mode: 0o600 }); await unlink(path); await symlink(outside, path);
    await expect(f.store.readSnapshot(input.requestId)).rejects.toThrow("continuity_unsafe_path");
    await unlink(path); await writeFile(path, new Uint8Array(bytes.length), { mode: 0o600 });
    await expect(f.store.readSnapshot(input.requestId)).rejects.toThrow("continuity_integrity_failure");
  } finally { await f.close(); }
});

test("read-only measurement changes no files, and lifecycle callbacks use the actual owners", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const input = materialFixture(); await f.store.publish(input);
    const before = await readFile(f.file), names = await readdir(f.objects);
    const measurement = await measureContinuityStorage(f.store.owners);
    expect(measurement.coverage).toBe("complete"); expect(measurement.knownAllocatedBytes).toBeGreaterThan(0);
    expect(measurement.addedToDiagnosticFootprint).toBe(false); expect(measurement.deletionAuthorized).toBe(false);
    expect(await readFile(f.file)).toEqual(before); expect(await readdir(f.objects)).toEqual(names);
    const abort = new AbortController(); abort.abort();
    await expect(f.store.publish(materialFixture(), abort.signal)).rejects.toThrow("continuity_cancelled");
    expect(await readFile(f.file)).toEqual(before);
  } finally { await f.close(); }
});

test("a damaged newest point cannot cause GC to discard the last readable older fallback", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const old = materialFixture("fallback", 100), latest = materialFixture("newest", 300);
    await f.store.publish(old); await f.store.publish(materialFixture("middle", 200)); await f.store.publish(latest);
    const rootPart = latest.manifest.parts.find(p => p.id === "root-slot")!;
    await writeFile(join(f.objects, `${rootPart.hash}.blob`), new Uint8Array(rootPart.bytes), { mode: 0o600 });
    await expect(f.store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 })).rejects.toThrow("continuity_integrity_failure");
    expect((await f.store.readSnapshot(old.requestId)).state).toBe("published");
    const prepared = effectIntent(latest.requestId);
    await expect(f.store.prepareEffect(prepared)).rejects.toThrow("continuity_integrity_failure");
  } finally { await f.close(); }
});

test("cancellation waits for an already-writing transaction; the committed result remains independently readable", async () => {
  const entered = barrier(), release = barrier();
  const f = await fixture(undefined, { beforeCommit: async label => { if (label === "publish-material") { entered.release(); await release.promise; } } });
  try {
    await f.store.initialize(); const input = materialFixture(), abort = new AbortController(); let finished = false;
    const pending = f.store.publish(input, abort.signal).then(() => { finished = true; }, () => { finished = true; });
    await entered.promise; abort.abort(); await sleep(20); expect(finished).toBe(false);
    release.release(); await pending;
    expect(finished).toBe(true); expect((await f.reopen().readSnapshot(input.requestId)).state).toBe("published");
    const before = await readFile(f.file); await sleep(15); expect(await readFile(f.file)).toEqual(before);
  } finally { release.release(); await f.close(); }
});

test("real recovery owner plugs into J1: diagnostic expiry does not delete its material or unknown effect", async () => {
  const f = await fixture(); try {
    await f.store.initialize(); const input = materialFixture(), publication = await f.store.publish(input), intent = effectIntent(input.requestId);
    await f.store.prepareEffect(intent); await f.store.claimEffect(intent.operationId, randomUUID(), CONT_POLICY);
    const DAY = 86400000, at = Date.now() - 2 * DAY, config = { ...defaultConfig(), storage: { diagnostics: { detailDays: 1, summaryDays: 3 } } };
    await writeFile(join(f.root, "config.json"), JSON.stringify(config), { mode: 0o600 }); const run = join(f.base, "run"); await mkdir(run, { mode: 0o700 });
    const monitor = openMonitorStore(f.root, { retentionMs: DAY, summaryMs: 3 * DAY }); await monitor.initialize(); const epoch = randomUUID(); await monitor.begin(epoch, at, [CONT_AGENT]);
    const source: ContinuitySource = { scopeId: CONT_SCOPE, source: "recovery", generation: "real-cont-owner" };
    const bridge = openContinuityObservationBridge({ durableRoot: f.root, source });
    const event: ContinuityEvent = { name: "continuity_observation", schemaVersion: 1, ...source, sourceInstanceId: continuitySourceKey(source), at: new Date(at).toISOString(),
      eventId: randomUUID(), sourceSequence: 0, agentId: CONT_AGENT, occurrenceId: randomUUID(), operationId: intent.operationId, kind: "recovery_degraded",
      coverage: { state: "observed", fromAtMs: at - 1, throughAtMs: at, gapCodes: [] }, inboundCount: null, evidenceRefs: [publication.reference] };
    await bridge.publish({ collectorEpoch: epoch, expectedCursor: null, nextCursor: "one", atMs: at, events: [event] });
    const incident = (await bridge.receipts([event.eventId])).incidents[0]!;
    const cycle = await maintainObservationStorage({ durableRoot: f.root, runRoot: run, continuityOwners: f.store.owners });
    expect(cycle.continuity?.map(r => r.state)).toEqual(["observed", "observed"]);
    expect(await monitor.incidentEvidence(incident.incidentId, 1)).toMatchObject({ retention: { tier: "summary" } });
    expect((await f.store.readSnapshot(input.requestId)).state).toBe("published");
    expect(await f.store.operation(intent.operationId)).toMatchObject({ state: "effect_unknown", dispatch: false });
  } finally { await f.close(); }
});

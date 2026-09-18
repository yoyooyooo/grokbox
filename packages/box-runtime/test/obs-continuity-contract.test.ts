import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, configurationRevisions, validateConfig } from "@grokbox/runtime-kernel/config";
import { continuitySourceKey, projectContinuityEvent, assessIncident, type ContinuitySource, type ContinuityEvent, type ContinuityStorageOwner, type ReferenceChange } from "@grokbox/runtime-kernel/observation";
import { openContinuityObservationBridge, runContinuityReferenceChange, maintainObservationStorage, measureContinuityStorage, observeRuntimeStorage, openMonitorStore } from "../src/runtime.ts";
import { modeldStorageMaintenance } from "../src/internal/roots/storage-lifetime.runtime.ts";
import { appendNdjsonLine } from "../src/internal/host/terminal-journal.node.ts";
import { inspectJournalSegments } from "../src/internal/host/journal-segments.node.ts";
import { ownedContinuityStorage } from "./fixtures/owned-continuity-storage.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DAY = 86400000;
const SOURCE: ContinuitySource = { scopeId: "c".repeat(64), source: "ownership", generation: "owned-source-generation" };
const makeEvent = (atMs: number, sequence = 0, overrides: Partial<ContinuityEvent> = {}): ContinuityEvent => ({
  name: "continuity_observation", schemaVersion: 1, at: new Date(atMs).toISOString(), ...SOURCE,
  sourceInstanceId: continuitySourceKey(SOURCE), eventId: randomUUID(), sourceSequence: sequence, agentId: AGENT,
  occurrenceId: randomUUID(), kind: "ownership_lost", operationId: randomUUID(), dutyId: randomUUID(),
  coverage: { state: "observed", fromAtMs: atMs - 1, throughAtMs: atMs, gapCodes: [] }, inboundCount: null, evidenceRefs: [], ...overrides,
});
async function fixture(atMs = Date.now()) {
  const base = await mkdtemp(join(tmpdir(), "obs-continuity-")), root = join(base, "durable"), run = join(base, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const config = validateConfig({ ...defaultConfig(), storage: { diagnostics: { detailDays: 1, summaryDays: 3 } } });
  await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const store = openMonitorStore(root, { retentionMs: DAY, summaryMs: 3 * DAY });
  await store.initialize(); const epoch = randomUUID(); await store.begin(epoch, atMs, [AGENT]);
  const owned = await ownedContinuityStorage(join(base, "private-recovery-owner"));
  const bridge = openContinuityObservationBridge({ durableRoot: root, source: SOURCE });
  const publish = (events: ContinuityEvent[], expectedCursor: string | null, nextCursor: string, collectorEpoch = epoch, now = atMs) => bridge.publish({ collectorEpoch, events, expectedCursor, nextCursor, atMs: now });
  return { base, root, run, config, store, epoch, owned, bridge, publish, atMs, close: () => rm(base, { recursive: true, force: true }) };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// This is a shared-boundary fixture, not a CONT importer, replacement controller
// or native delivery qualification. All effects below use owned local resources.
test("typed event rejects private fields, wrong source identities and gap-as-zero input", () => {
  const event = makeEvent(Date.now()); expect(projectContinuityEvent(event)).toEqual(event);
  for (const patch of [{ prompt: "PRIVATE" }, { schemaVersion: 2 }, { sourceInstanceId: "a".repeat(64) },
    { evidenceRefs: [{ owner: "continuity.recovery", ref: "/private/path", revision: "r1" }] },
    { kind: "inbound_window", source: "inbound", sourceInstanceId: continuitySourceKey({ ...SOURCE, source: "inbound" }), inboundCount: 0,
      coverage: { ...event.coverage, state: "gap", gapCodes: ["incomplete_page"] } }]) expect(projectContinuityEvent({ ...event, ...patch })).toBeNull();
  const assessment = assessIncident("continuity_attention", [{ ref: "fact", value: event }]);
  expect(assessment).toMatchObject({ disposition: "notify", category: "continuity_impact" });
});

test("same event survives restart and unknown local export without creating a second work item", async () => {
  const f = await fixture(); try {
    const event = makeEvent(f.atMs);
    expect(await f.publish([event], null, "one")).toMatchObject({ state: "accepted", committed: true, transport: "unavailable", crossStoreAtomic: false });
    const receipts = await f.bridge.receipts([event.eventId]);
    expect(receipts.incidents).toHaveLength(1);
    const receipt = receipts.incidents[0]!;
    expect(receipt).toMatchObject({ outboxState: "ready", evidenceRevision: 1, transport: "unavailable", automaticRetry: false });
    const events = (await f.store.events()).entries;
    const decisions = events.filter(e => e.kind === "notification_decided").map(e => e.notification);
    await f.store.recordNotificationExport(f.epoch, decisions, false, f.atMs + 1);
    await f.store.finish(f.epoch, f.atMs + 2); const nextEpoch = randomUUID(); await f.store.begin(nextEpoch, f.atMs + 3, [AGENT]);
    const reopened = openContinuityObservationBridge({ durableRoot: f.root, source: SOURCE });
    expect(await reopened.publish({ collectorEpoch: nextEpoch, events: [event], expectedCursor: null, nextCursor: "one", atMs: f.atMs + 3 })).toMatchObject({ state: "duplicate", committed: true });
    expect((await f.store.notificationWork())).toHaveLength(1);
    expect((await reopened.receipts([event.eventId])).incidents[0]).toMatchObject({ workId: receipt.workId, evidenceRevision: 1, outboxState: "unknown", automaticRetry: false });
    expect((await f.owned.readState()).operations["existing-operation"]).toBe("commit_unknown");
    expect(f.owned.calls().effects).toBe(0);
  } finally { await f.close(); }
});

test("notification off preserves evidence/config/model domains and does not close the ownership expectation", async () => {
  const f = await fixture(); try {
    const changed = validateConfig({ ...f.config, ops: { enabled: false, notifications: { mode: "off" } } });
    const configBytes = JSON.stringify(changed); await writeFile(join(f.root, "config.json"), configBytes, { mode: 0o600 });
    const revisions = configurationRevisions(changed), first = makeEvent(f.atMs);
    expect(await f.publish([first], null, "one")).toMatchObject({ committed: true, notifications: "off" });
    const receipt = (await f.bridge.receipts([first.eventId])).incidents[0]!;
    expect(receipt).toMatchObject({ evidenceRevision: 1, workId: null, outboxState: "not_prepared" });
    const before = (await f.store.incidents())[0]!;
    const still = makeEvent(f.atMs + 1, 1, { kind: "ownership_observed", occurrenceId: first.occurrenceId });
    await f.publish([still], "one", "two", f.epoch, f.atMs + 1);
    expect((await f.store.incidents())[0]!.status).toBe(before.status);
    expect(await f.store.notificationWork()).toHaveLength(0);
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(configBytes);
    expect(configurationRevisions(changed).storage).toBe(revisions.storage);
    expect(f.owned.calls()).toEqual({ gcCalls: 0, mutations: 0, effects: 0 });
  } finally { await f.close(); }
});

test("inbound gaps and sequence gaps remain explicit and cannot prove a quiet deletion period", async () => {
  const f = await fixture(); try {
    const source = { ...SOURCE, source: "inbound" as const }, bridge = openContinuityObservationBridge({ durableRoot: f.root, source });
    const event = makeEvent(f.atMs, 3, { ...source, sourceInstanceId: continuitySourceKey(source), kind: "inbound_window", inboundCount: null,
      coverage: { state: "unsupported", fromAtMs: f.atMs - 100, throughAtMs: f.atMs, gapCodes: ["unsupported_schema"] } });
    expect(await bridge.publish({ collectorEpoch: f.epoch, events: [event], expectedCursor: null, nextCursor: "gap", atMs: f.atMs })).toMatchObject({ state: "partial", committed: true, quietPeriodProven: false });
    const receipt = (await bridge.receipts([event.eventId])).incidents[0]!;
    const evidence = await f.store.incidentEvidence(receipt.incidentId, 1);
    expect(evidence).toMatchObject({ sourceWindow: { state: "partial", gapCodes: ["unsupported_schema"] } });
    expect(await bridge.cursor()).toMatchObject({ value: { gap: "unsupported_schema", quietPeriodProven: false }, quietPeriodProven: false });
    const future = makeEvent(f.atMs + 1, 5, { ...source, sourceInstanceId: continuitySourceKey(source), kind: "inbound_window", inboundCount: 0 });
    expect(await bridge.publish({ collectorEpoch: f.epoch, events: [future], expectedCursor: "gap", nextCursor: "later", atMs: f.atMs + 1 })).toMatchObject({ state: "partial", sourceCoverage: { knownMissingEvents: 4 }, quietPeriodProven: false });
  } finally { await f.close(); }
});

test("rollback and lost commit acknowledgement reuse the same event/cursor rather than creating another incident", async () => {
  const f = await fixture(); try {
    const event = makeEvent(f.atMs), batch = { epoch: f.epoch, sourceKey: continuitySourceKey(SOURCE), expectedCursor: null, nextCursor: "one", events: [event], atMs: f.atMs };
    await expect(openMonitorStore(f.root, { beforePublish: () => { throw Error("owned-before-commit"); } }).ingestEvidence(batch)).rejects.toBeDefined();
    expect(await f.store.evidenceCursor(batch.sourceKey)).toBeNull(); expect(await f.store.incidents()).toHaveLength(0);
    await expect(openMonitorStore(f.root, { afterRename: () => { throw Error("owned-after-commit"); } }).ingestEvidence(batch)).rejects.toBeDefined();
    expect((await f.store.evidenceCursor(batch.sourceKey))?.cursor).toBe("one");
    expect(await f.publish([event], null, "one")).toMatchObject({ state: "duplicate" });
    expect(await f.store.incidents()).toHaveLength(1); expect(await f.store.notificationWork()).toHaveLength(1);
    expect((await f.owned.readState()).operations["existing-operation"]).toBe("commit_unknown");
  } finally { await f.close(); }
});

test("diagnostic expiry and journal rotation do not retire a pinned recovery closure or unknown operation", async () => {
  const f = await fixture(Date.now() - 2 * DAY); try {
    const reference = await f.owned.add("last", true), candidate = await f.owned.add("protected");
    const change: ReferenceChange = { action: "protect", requestId: randomUUID(), claimId: randomUUID(), reference: candidate };
    expect(await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change })).toMatchObject({ state: "observed", receipt: { state: "protected" } });
    const before = await f.owned.readBundle("protected"), event = makeEvent(f.atMs, 0, { evidenceRefs: [reference, candidate] });
    await f.publish([event], null, "one"); const incident = (await f.bridge.receipts([event.eventId])).incidents[0]!.incidentId;
    for (let i = 0; i < 70; i++) await appendNdjsonLine(f.run, JSON.stringify({ name: "disk_sha_observed", at: new Date().toISOString(), sha: "a".repeat(64), count: i }), "host", {
      policy: { segmentBytes: 2048, maxBytes: 8192, maxAgeMs: 86400000 }, nowMs: Date.now() });
    expect((await inspectJournalSegments(f.run)).retiredSegments).toBeGreaterThan(0);
    await maintainObservationStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter } });
    expect(await f.store.incidentEvidence(incident, 1)).toMatchObject({ state: "expired", retention: { tier: "summary" } });
    expect(await f.owned.readBundle("protected")).toEqual(before);
    expect((await f.owned.readState()).operations["existing-operation"]).toBe("commit_unknown");
    expect(f.owned.calls().effects).toBe(0);
  } finally { await f.close(); }
});

test("reference publication and release serialize with owner GC, and release cannot erase another claim", async () => {
  const f = await fixture(); try {
    const reference = await f.owned.add("candidate"), entered = gate(), release = gate();
    const change: ReferenceChange = { action: "protect", requestId: randomUUID(), claimId: randomUUID(), reference };
    f.owned.protectBarrier(async () => { entered.release(); await release.promise; });
    const protection = runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change }); await entered.promise;
    const collection = maintainObservationStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter } });
    release.release(); await protection; await collection; expect(await f.owned.readBundle("candidate")).toHaveLength(3);
    f.owned.protectBarrier(); const other = { ...change, requestId: randomUUID(), claimId: randomUUID() };
    await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change: other });
    await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change: { ...change, action: "release", requestId: randomUUID() } });
    await maintainObservationStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter } });
    expect(await f.owned.readBundle("candidate")).toHaveLength(3);
    expect(await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change })).toMatchObject({ state: "observed", receipt: { state: "protected" } });
  } finally { await f.close(); }
});

test("capacity declines new protection/effect but preserves the last reliable point; one failed owner does not hide another", async () => {
  const f = await fixture(); try {
    await f.owned.add("last", true); const reference = await f.owned.add("new");
    const before = await f.owned.readBundle("last"); f.owned.setBudget(0); f.owned.setSafetyCapacity(false);
    expect(await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change: { action: "protect", claimId: randomUUID(), requestId: randomUUID(), reference } })).toMatchObject({ receipt: { state: "blocked", blockedBy: ["capacity"] } });
    expect(await f.owned.startEffect("new-effect")).toMatchObject({ state: "blocked", effects: 0 });
    const bad: ContinuityStorageOwner = { owner: "continuity.safety", measure: async () => { throw Error("PRIVATE_OWNER_ERROR"); },
      changeReference: async () => { throw Error("not called"); }, maintain: async () => { throw Error("PRIVATE_GC_ERROR"); } };
    const result = await maintainObservationStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter, safety: bad } });
    expect(result.continuity?.map(r => r.state)).toEqual(["observed", "unavailable"]);
    expect(await f.owned.readBundle("last")).toEqual(before); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const status = await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter, safety: bad } });
    expect(status.continuityStorage.owners.map(r => r.state)).toEqual(["measured", "unavailable"]);
    expect(status.installationBudgetEnforced).toBe(false);
  } finally { await f.close(); }
});

test("missing owners stay unmeasured and shared physical allocations are counted once without modifying owner files", async () => {
  const f = await fixture(); try {
    await f.owned.add("last", true); const before = await readFile(f.owned.file);
    const empty = await measureContinuityStorage(); expect(empty.knownAllocatedBytes).toBeNull(); expect(empty.owners.map(r => [r.state, r.measurement])).toEqual([["unmeasured", null], ["unmeasured", null]]);
    const sample = await f.owned.adapter.measure();
    const recovery = { ...f.owned.adapter, measure: async () => sample };
    const safety: ContinuityStorageOwner = { ...f.owned.adapter, owner: "continuity.safety", measure: async () => ({ ...sample, owner: "continuity.safety" }) };
    const measured = await measureContinuityStorage({ recovery, safety });
    expect(measured.knownAllocatedBytes).toBe(sample.allocations.reduce((n, a) => n + a.allocatedBytes, 0));
    expect(measured.addedToDiagnosticFootprint).toBe(false); expect(measured.deletionAuthorized).toBe(false);
    expect(await readFile(f.owned.file)).toEqual(before); expect(f.owned.calls().gcCalls).toBe(0);
  } finally { await f.close(); }
});

test("a supervised maintenance stop waits for the actual owner mutation and leaves no detached writer", async () => {
  const f = await fixture(); const entered = gate(), release = gate(); let stopped = false, running = false;
  try {
    await f.owned.add("last", true);
    f.owned.gcBarrier(async () => { running = true; entered.release(); await release.promise; running = false; });
    const fiber = Effect.runFork(modeldStorageMaintenance({ durableRoot: f.root, runRoot: f.run, serviceEpoch: randomUUID(), continuityOwners: { recovery: f.owned.adapter } }, {
      recorder: async () => ({ record: async () => {}, stop: async () => { expect(running).toBe(false); stopped = true; } }),
    }));
    await entered.promise;
    const shutdown = Effect.runPromise(Fiber.interrupt(fiber)); await pause(20); expect(stopped).toBe(false);
    release.release(); await shutdown; expect(stopped).toBe(true);
    const before = await readFile(f.owned.file); await pause(15); expect(await readFile(f.owned.file)).toEqual(before);
  } finally { release.release(); await f.close(); }
});

test("identity conflict is observable without overwriting fixed evidence or manufacturing another notification", async () => {
  const f = await fixture(); try {
    const event = makeEvent(f.atMs); await f.publish([event], null, "one");
    const id = (await f.bridge.receipts([event.eventId])).incidents[0]!.incidentId;
    const before = await f.store.incidentEvidence(id, 1);
    expect(await f.publish([{ ...event, dutyId: randomUUID() }], "one", "two")).toMatchObject({ state: "conflict", committed: true, conflicts: 1 });
    expect(await f.store.incidentEvidence(id, 1)).toEqual(before);
    expect(await f.store.notificationWork()).toHaveLength(1);
    expect(await f.bridge.cursor()).toMatchObject({ value: { conflicts: 1, quietPeriodProven: false } });
  } finally { await f.close(); }
});

test("public evidence drops recovery references while preserving coverage and operation relationships", async () => {
  const f = await fixture(); try {
    const ref = { owner: "continuity.recovery" as const, ref: "PRIVATE_RECOVERY_REF_SENTINEL", revision: "r1" };
    const event = makeEvent(f.atMs, 0, { evidenceRefs: [ref] }); await f.publish([event], null, "one");
    const id = (await f.bridge.receipts([event.eventId])).incidents[0]!.incidentId;
    const publicView = await f.store.incidentEvidence(id, 1, "public-summary");
    const text = JSON.stringify(publicView);
    expect(text).not.toContain(ref.ref); expect(text).not.toContain(event.agentId); expect(text).not.toContain(event.operationId!);
    expect(text).toContain("continuity_observation"); expect(text).toContain("ownership_lost");
    expect(publicView).toMatchObject({ state: "available", replayAuthorized: false });
    expect(await f.store.notificationNotice((await f.store.notificationWork())[0]!.id as string)).toMatchObject({ behavior: "notify_then_end", automaticIssue: false });
  } finally { await f.close(); }
});

test("GC winning before a new claim cannot yield a false protection receipt; malformed owner receipts remain unknown", async () => {
  const f = await fixture(); try {
    const ref = await f.owned.add("unclaimed");
    await maintainObservationStorage({ durableRoot: f.root, runRoot: f.run, continuityOwners: { recovery: f.owned.adapter } });
    const change: ReferenceChange = { action: "protect", requestId: randomUUID(), claimId: randomUUID(), reference: ref };
    expect(await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change })).toMatchObject({ state: "observed", receipt: { state: "conflict" } });
    const malformed = { ...f.owned.adapter, changeReference: async () => ({ requestId: "wrong" }) as never };
    expect(await runContinuityReferenceChange({ owners: { recovery: malformed }, change })).toMatchObject({ state: "unknown", effect: "reconcile_with_owner" });
    expect(await runContinuityReferenceChange({ owners: {}, change })).toMatchObject({ state: "unavailable", effect: "not_attempted" });
    const signal = new AbortController(); signal.abort(); const before = f.owned.calls().mutations;
    expect(await runContinuityReferenceChange({ owners: { recovery: f.owned.adapter }, change, signal: signal.signal })).toMatchObject({ effect: "not_attempted" });
    expect(f.owned.calls().mutations).toBe(before);
  } finally { await f.close(); }
});

test("unsupported/missing collector leaves source replay responsibility with CONT and does not create stores", async () => {
  const f = await fixture(); try {
    const absent = join(f.base, "missing"), bridge = openContinuityObservationBridge({ durableRoot: absent, source: SOURCE });
    expect(await bridge.cursor()).toMatchObject({ state: "unavailable", value: null });
    expect(await bridge.publish({ collectorEpoch: f.epoch, expectedCursor: null, nextCursor: "one", atMs: f.atMs, events: [{ ...makeEvent(f.atMs), schemaVersion: 2 } as never] })).toMatchObject({ state: "unsupported", committed: false });
    expect(await readdir(f.base)).not.toContain("missing");
    expect(await bridge.publish({ collectorEpoch: f.epoch, expectedCursor: null, nextCursor: "one", atMs: f.atMs, events: [makeEvent(f.atMs)] })).toMatchObject({ state: "unavailable", committed: false });
    expect(await readdir(f.base)).not.toContain("missing");
  } finally { await f.close(); }
});

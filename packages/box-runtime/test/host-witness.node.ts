import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostWitnessFixture } from "../../../apps/web/test/host-witness-fixture.ts";
import { publishConfigFile } from "../src/runtime.ts";
import { readHostRuntimeJournal, retainHostRuntimeEvidence } from "../src/internal/io/provenance.node.ts";
import { observeHostWitness } from "../src/internal/io/host-witness.node.ts";
import { inspectPid } from "../src/internal/host/self-identity.node.ts";
import { bindHostCompactHook } from "../src/internal/host/compact.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { projectHostWitnessSnapshot, projectHostWitnessObservation, type HostWitnessNote, type HostWitnessObservation } from "@grokbox/runtime-kernel/host-health";
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10000): Promise<T> { let last: unknown; const end = Date.now() + ms; do { try { const v = await read(); if (ok(v)) return v; last = v; } catch(e) { last = String(e); } await delay(20); } while(Date.now() < end); throw Error(`witness_deadline:${JSON.stringify(last)}`); }
type Fixture = Awaited<ReturnType<typeof hostWitnessFixture>>;
const observation = async (f: Fixture) => (await f.client().hostHealth()).data.witness;
const current = (f: Fixture) => until(() => observation(f), o => o?.state === "current");
const rows = async (f: Fixture) => (await f.observations.incidents()).filter(r => r.rule === "host_patch_health");

// The read crosses actual management HTTP -> native HTTP -> transformed status
// schema/wrapper -> bundled production witness. No fixture returns attached=true.
test("fresh native challenge inspects exact registered references with no ownership, Bot or model read", async () => {
  const f = await hostWitnessFixture("https://witness.example.test");
  try {
    const o = (await current(f))!, s = o.snapshot!;
    assert.ok(projectHostWitnessSnapshot(s)); assert.equal(s.compilation.observationId, f.process.result.compilationObservation.observationId);
    assert.deepEqual(s.capabilities.filter(r => r.required).map(r => [r.id, r.handles, r.missingSlices]), [["session", "present", []], ["ownership", "present", []]]);
    assert.equal(s.events.length, 0); assert.equal(s.opportunityCoverage, "not-observed"); assert.equal(s.qualified, false);
    assert.equal(f.state.nativeCalls, 0); assert.equal((await f.control("stats")).nativeReads, 0);
    await until(() => f.client().hostHealth(), v => v.data.latest?.analysis !== "pending" && v.data.runtimeIntake === "committed");
    // The current in-memory sample and another lane's committed intake are
    // not proof that BOTH first observations have reached provenance. Fence
    // this no-heartbeat-growth assertion on their actual retained identities.
    const history = await until(() => readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"), journal =>
      !!journal && journal.receipts.some(r => r.event.name === "host_runtime_health" && r.event.observation.state === "current"
        && r.event.observation.receipt?.observationId === s.compilation.observationId)
      && journal.receipts.some(r => r.event.name === "host_capability_health" && r.event.observation.state === "current"
        && r.event.observation.snapshot?.compilation.observationId === s.compilation.observationId));
    await delay(180); assert.equal((await readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"))!.nextSequence, history!.nextSequence);
    assert.ok((await current(f))!.snapshot!.sequence > s.sequence);
    for (const secret of [f.root, "synthetic-witness-native", "createSession(", "PRIVATE"]) assert.ok(!JSON.stringify(o).includes(secret));
  } finally { await f.close(); }
});

test("a compilation intake cannot mark a newly sampled but not-yet-retained witness as committed", async () => {
  const f = await hostWitnessFixture("https://witness-shared-intake.example.test");
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let paused = false, ready = false, observedIntake: string | undefined;
  const marker = join(f.ports.runtime!.runRoot!, "state/preload-marker.json");
  try {
    await current(f); const original = await readFile(marker, "utf8");
    await unlink(marker); await until(() => f.client().hostHealth(), v => v.data.runtime?.state === "not-observed" && v.data.witness?.state === "not-observed" && v.data.runtimeIntake === "committed");
    f.ports.runtime!.afterRetain = async () => {
      if (!paused && (await f.client().hostHealth()).data.runtime?.state === "current") { paused = true; await held; }
    };
    f.ports.afterWitnessRetain = async () => {
      if (ready) observedIntake = (await f.client().hostHealth()).data.runtimeIntake;
    };
    await writeFile(marker, original, { mode: 0o600 });
    await until(async () => paused, value => value);
    await until(() => f.client().hostHealth(), v => v.data.witness?.state === "current" && v.data.runtimeIntake === "not-observed");
    ready = true; release();
    await until(async () => observedIntake, value => value !== undefined);
    assert.equal(observedIntake, "not-observed");
    await until(() => f.client().hostHealth(), v => v.data.runtimeIntake === "committed");
  } finally { release(); delete f.ports.runtime!.afterRetain; delete f.ports.afterWitnessRetain; await f.close(); }
});

test("replaced handler becomes one persistent attachment condition; missing/read failure cannot resolve it, restoring the actual reference can", async () => {
  const f = await hostWitnessFixture("https://witness-replaced.example.test");
  try {
    await current(f); await until(() => f.client().hostHealth(), v => v.data.latest?.analysis !== "pending" && v.data.runtimeIntake === "committed");
    const before = new Set((await rows(f)).map(r => r.id));
    await f.control("replace"); await until(() => observation(f), o => o?.snapshot?.capabilities[0]?.handles === "changed");
    const fault = (await until(() => rows(f), r => r.some(v => !before.has(v.id) && v.status === "open"))).find(r => !before.has(r.id))!;
    const count = (await f.observations.notificationWork()).length;
    f.probeState.decorate = r => ({ ...r, value: null }); await until(() => observation(f), o => o?.state === "invalid");
    assert.equal((await rows(f)).find(r => r.id === fault.id)!.status, "open");
    await until(() => rows(f), r => r.some(v => v.id !== fault.id && !before.has(v.id) && v.status === "open"));
    f.probeState.decorate = undefined; await f.control("restore");
    await until(() => rows(f), r => r.find(v => v.id === fault.id)?.status === "resolved");
    await delay(100); assert.equal((await f.observations.notificationWork()).length, count + 1); // Separate detector outage, not another attachment occurrence.
    assert.equal(f.process.child.exitCode, null);
  } finally { await f.close(); }
});

test("a getter replacing a tracked handler is observed without evaluating that getter", async () => {
  const f = await hostWitnessFixture("https://witness-getter.example.test");
  try { await current(f); await f.control("getter"); await until(() => observation(f), o => o?.snapshot?.capabilities[0]?.handles === "changed"); assert.equal((await f.control("stats")).getterReads, 0); await f.control("restore"); await current(f); }
  finally { await f.close(); }
});

test("real transformed session calls leave finite boundary evidence, not a fabricated Provider or whole-path success", async () => {
  const f = await hostWitnessFixture("https://witness-exercise.example.test");
  try {
    await current(f); await f.control("exercise");
    const one = (await until(() => observation(f), o => o?.snapshot?.events.length === 2))!.snapshot!;
    assert.deepEqual(one.events.map(e => e.stage), ["session-enter", "native-selected"]);
    assert.ok(one.events.every(e => e.capability === "session")); assert.equal(one.opportunityCoverage, "not-observed");
    await f.control("exercise", { count: 40 });
    const more = (await until(() => observation(f), o => o?.snapshot?.eventsDropped === 50))!.snapshot!;
    assert.equal(more.events.length, 32); assert.equal(more.events.at(-1)!.sequence, 82);
    assert.ok(!more.events.some(e => e.stage === "terminal-consumed"));
    await f.restart(); await until(() => observation(f), o => o?.snapshot?.eventsDropped === 50);
    assert.equal(f.state.nativeCalls, 0); assert.equal((await f.control("stats")).nativeReads, 0);
  } finally { await f.close(); }
});

for (const [name, patch] of [
  ["wrong nonce", (s: any) => ({ ...s, challenge: randomUUID() })],
  ["old sequence", (s: any) => ({ ...s, sequence: 1 })],
  ["foreign compilation", (s: any) => ({ ...s, compilation: { ...s.compilation, observationId: randomUUID() } })],
  ["private field", (s: any) => ({ ...s, privateSource: "private" })],
  ["missing capability", (s: any) => ({ ...s, capabilities: s.capabilities.slice(1) })],
  ["withdrawn required capability", (s: any) => ({ ...s, capabilities: s.capabilities.map((r: any) => ({ ...r, required: false, handles: "not-required", missingSlices: [] })) })],
] as const) test(`${name} cannot become a same-generation witness`, async () => {
  const f = await hostWitnessFixture("https://witness-invalid.example.test");
  try { await until(() => observation(f), o => (o?.snapshot?.sequence ?? 0) > 2); f.probeState.decorate = r => ({ ...r, value: patch(r.value) }); await until(() => observation(f), o => o?.state === "invalid"); await delay(80); assert.equal((await observation(f))!.state, "invalid"); assert.equal((await observation(f))!.snapshot, null); }
  finally { await f.close(); }
});

test("disk drift does not revoke the still-loaded generation, while a response from a different native PID is refused", async () => {
  const f = await hostWitnessFixture("https://witness-generation.example.test");
  try { const original = (await current(f))!.snapshot!.compilation;
    const source = await readFile(f.paths.source, "utf8"); await writeFile(f.paths.source, source + "\n// next disk version\n");
    await until(() => f.client().hostHealth(), v => v.data.latest?.applicability === "mismatch");
    assert.equal((await current(f))!.snapshot!.compilation.sourceSha, original.sourceSha);
    f.probeState.decorate = r => ({ ...r, pid: r.pid + 1 }); await until(() => observation(f), o => o?.state === "invalid");
    f.probeState.decorate = undefined; await current(f); assert.equal(f.process.child.exitCode, null);
  } finally { await f.close(); }
});

test("Server shutdown cancels the actual pending native metadata read and never signals the Host", async () => {
  const f = await hostWitnessFixture("https://witness-cancel.example.test");
  try { await current(f); const count = f.probeState.calls; await f.control("delay", { ms: 5000 }); await until(async () => f.probeState.calls, n => n > count);
    const began = Date.now(); await f.server.close(); assert.ok(Date.now() - began < 4000); assert.ok(f.probeState.aborted > 0);
    assert.equal(f.process.child.exitCode, null);
    const history = await readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"); await delay(100);
    assert.deepEqual(await readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"), history);
  } finally { await f.close(); }
});

test("explicit disabled intent stops metadata reads and does not masquerade as repaired attachment", async () => {
  const f = await hostWitnessFixture("https://witness-disabled.example.test");
  try { await current(f); await f.control("replace"); await until(() => observation(f), o => o?.snapshot?.capabilities[0]?.handles === "changed");
    const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8")); config.runtime.desiredMode = "disabled"; await publishConfigFile(join(f.root, "config.json"), config);
    await until(() => f.client().hostHealth(), v => v.data.state === "disabled"); const count = f.probeState.calls;
    await delay(120); assert.equal(f.probeState.calls, count); assert.equal((await f.client().hostHealth()).data.witness, null);
  } finally { await f.close(); }
});

test("diagnostic callback failures preserve native selection, compact preflight result and idempotent disposal", async () => {
  const native = { preserved: true }, bad = () => { throw Error("synthetic observer failure"); };
  assert.equal(bindHostSessionHook({ mode: "identity", durableRoot: "/unused", runRoot: "/unused", witness: bad })({ originalSession: native }), native);
  const notes: HostWitnessNote[] = [], result = { unchanged: true }, root = {};
  const capture = { orchestrator: { handleSummarization: async () => {} }, ctx: {}, stateHandler: {}, rootPromptExecutor: root,
    invocationId: randomUUID(), turnId: randomUUID(), agentId: randomUUID(), stepClosed: () => false };
  const hook = bindHostCompactHook({ context: () => ({ preflight: async () => result, recover: async () => result }), witness: n => { notes.push(n); bad(); } });
  const lease = hook(capture)!;
  assert.equal(await lease.preflight!(), result); lease[Symbol.dispose](); lease[Symbol.dispose]();
  assert.deepEqual(notes.map(n => n.stage), ["lease-open", "preflight-settled", "lease-close"]);
  assert.ok(notes.every(n => n.agentId === capture.agentId && n.stepId === capture.invocationId));
});

test("restarting the management consumer preserves one attachment occurrence and original retained event identities", async () => {
  const f = await hostWitnessFixture("https://witness-restart.example.test");
  try {
    await current(f); await f.control("replace"); await until(() => observation(f), o => o?.snapshot?.capabilities[0]?.handles === "changed");
    await until(() => rows(f), r => r.some(row => row.status === "open"));
    await until(() => f.client().hostHealth(), v => v.data.witness?.snapshot?.capabilities[0]?.handles === "changed" && v.data.runtimeIntake === "committed");
    await f.server.close();
    const ids = (await rows(f)).map(r => r.id).sort(), before = (await readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"))!;
    await f.restart(); await until(() => f.client().hostHealth(), v => v.data.witness?.state === "current" && v.data.runtimeIntake === "committed");
    await f.server.close();
    assert.deepEqual((await rows(f)).map(r => r.id).sort(), ids);
    const after = (await readHostRuntimeJournal(f.root, "11111111-1111-4111-8111-111111111111"))!;
    for(const row of before.receipts) assert.ok(after.receipts.some(r => r.event.eventId === row.event.eventId));
  } finally { await f.close(); }
});

test("a stale launch is rejected before read, and an invalid reply after a launch change is not a fault of its successor", async () => {
  const f = await hostWitnessFixture("https://witness-stale-launch.example.test");
  try {
    await current(f);
    const compilation = (await f.client().hostHealth()).data.runtime!;
    const identity = inspectPid(f.process.child.pid!)!;
    const base = { root: f.root, runRoot: f.ports.runtime!.runRoot!, target: f.paths.source, compilation };
    let reads = 0, inspections = 0;
    const read = async () => { reads++; return { value: null, pid: identity.pid }; };
    assert.equal((await observeHostWitness({ ...base, read, inspect: { inspect: () => null } }, new AbortController().signal)).state, "different-generation");
    assert.equal(reads, 0);
    const observation = await observeHostWitness({ ...base, read, inspect: { inspect: () => ++inspections === 1 ? identity : { ...identity, start: identity.start + 1 } } }, new AbortController().signal);
    assert.equal(observation.state, "different-generation"); assert.equal(reads, 1);
  } finally { await f.close(); }
});

test("a missing retained runtime journal cannot silently restart its stable source sequence", async () => {
  const f = await hostWitnessFixture("https://witness-lost-journal.example.test");
  try {
    await current(f); await f.server.close();
    const installation = "11111111-1111-4111-8111-111111111111";
    const journal = (await readHostRuntimeJournal(f.root, installation))!;
    await unlink(join(f.root, "host-bundles", "runtime-health", "receipts.json"));
    await assert.rejects(readHostRuntimeJournal(f.root, installation));
    await assert.rejects(retainHostRuntimeEvidence(f.root, installation, { ...journal.receipts.at(-1)!.event, sourceSequence: 0 }));
  } finally { await f.close(); }
});

test("event rings cannot hide an interior gap, fabricate an outcome or erase the dropped suffix count", async () => {
  const f = await hostWitnessFixture("https://witness-ring.example.test");
  try {
    await current(f); await f.control("exercise");
    const s = (await until(() => observation(f), o => o?.snapshot?.events.length === 2))!.snapshot!;
    assert.equal(projectHostWitnessSnapshot({ ...s, events: [s.events[1]] }), null);
    assert.equal(projectHostWitnessSnapshot({ ...s, eventsDropped: 1 }), null);
    assert.equal(projectHostWitnessSnapshot({ ...s, events: s.events.map(e => ({ ...e, outcome: "threw" })) }), null);
    await f.control("exercise", { count: 40 });
    const ring = (await until(() => observation(f), o => o?.snapshot?.eventsDropped === 50))!.snapshot!;
    assert.ok(projectHostWitnessSnapshot(ring));
    assert.equal(projectHostWitnessSnapshot({ ...ring, eventsDropped: 0 }), null);
    assert.equal(projectHostWitnessSnapshot({ ...ring, events: ring.events.slice(1) }), null);
  } finally { await f.close(); }
});

test("public witness projection rejects accessors and treats missing opportunity coverage as unknown, not bypassed", async () => {
  const raw: HostWitnessObservation = { state: "not-observed", reason: "not-requested", observedAtMs: Date.now(), snapshot: null, qualified: false };
  assert.ok(projectHostWitnessObservation(raw));
  assert.equal(projectHostWitnessObservation({ ...raw, state: "current" }), null);
  let reads = 0; Object.defineProperty(raw, "snapshot", { get() { reads++; return null; } }); assert.equal(projectHostWitnessObservation(raw), null); assert.equal(reads, 0);
});

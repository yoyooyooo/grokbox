import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, protectionReferenceIdentity } from "@grokbox/client";
import { openContinuityRecoveryStore } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "@grokbox/server";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { contextOperationRef, type ContextChange, type ContextOperation } from "@grokbox/client";
import { contextFixture, C_SOURCE, C_TARGET, C_SCOPE, C_INSTALL, C_OWNER, C_OTHER, C_READER, C_WRITER } from "../../../apps/web/test/context-fixture.ts";
const origin = "https://context.example.test";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const ref = (r: ContextChange) => contextOperationRef(C_INSTALL, C_SCOPE, r.requestId);
const next = (r: ContextChange, action: "resume" | "reconcile") => ({ requestId: r.requestId, botRef: r.botRef, scopeId: r.scopeId, confirmed: true as const, action });
async function until(check: () => Promise<boolean>, timeout = 4000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw Error("context_fixture_deadline"); await sleep(20); } }
const rejected = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: any) => e?.code === code);
async function captured(f: Awaited<ReturnType<typeof contextFixture>>) { const r = await f.declaration("capture"); return { r, value: (await f.client().changeContext(r)).data }; }
async function initialized(f: Awaited<ReturnType<typeof contextFixture>>) { const c = await captured(f), r = await f.declaration("initialize", C_TARGET, c.value.captureRef!); return { r, value: (await f.client().changeContext(r)).data }; }

test("current context and absent operation are bounded read-only views, never source repair or CONT initialization", async () => {
  const f = await contextFixture(origin);
  try {
    const before = await readdir(f.root), source = await readFile(join(f.root, `${C_SOURCE}.sqlite`));
    const view = (await f.client().context(C_SOURCE)).data; assert.equal(view.botRef, `bot:${C_INSTALL}:${C_SOURCE}`); assert.equal(view.hasCheckpoint, true);
    assert.equal(view.currentOwnershipProven, false); assert.equal(view.contentIncluded, false);
    await rejected(f.client().contextOperation(contextOperationRef(C_INSTALL, C_SCOPE, randomUUID())), "not_found");
    assert.deepEqual(await readdir(f.root), before); assert.deepEqual(await readFile(join(f.root, `${C_SOURCE}.sqlite`)), source);
    assert.ok(!JSON.stringify(view).includes("PRIVATE_")); f.state.badHead = true; await assert.rejects(f.client().context(C_SOURCE));
  } finally { await f.close(); }
});

test("capture uses the native checkpoint worker and immutable recovery owner, then original replay remains offline", async () => {
  const f = await contextFixture(origin);
  try {
    const { r, value } = await captured(f); assert.equal(value.state, "captured"); assert.ok(value.captureRef); assert.equal(value.application, "not-recorded");
    const count = f.state.calls.length; f.state.failNative = true;
    assert.deepEqual((await f.client().changeContext(r)).data, value); assert.deepEqual((await f.client().contextOperation(ref(r))).data, value); assert.equal(f.state.calls.length, count);
    await rejected(f.client(C_OTHER).contextOperation(ref(r)), "not_found");
    await rejected(f.client().changeContext({ ...r, expectedRevision: "f".repeat(64) }), "idempotency_conflict");
    await f.restart(); assert.deepEqual((await f.client().contextOperation(ref(r))).data, value);
  } finally { await f.close(); }
});

test("native initialize imports saved Memory/history into an unused target, explicit release starts no task and B2 survives replay", async () => {
  const f = await contextFixture(origin);
  try {
    const { r, value } = await initialized(f); assert.equal(value.state, "prepared"); assert.equal(value.application, "succeeded"); assert.equal(value.activation, "not-requested");
    assert.deepEqual(f.target.memories, f.source.memories); assert.equal(f.target.entries[0].continuitySource.historical, true);
    const active = { requestId: r.requestId, botRef: C_TARGET, scopeId: C_SCOPE, action: "activate" as const, expectedRevision: (await f.client().context(C_TARGET)).data.revision, confirmed: true as const };
    const released = (await f.client().continueContext(active)).data; assert.equal(released.state, "released"); assert.equal(released.startedTask, false);
    const end = f.owner.enter(C_TARGET);
    try { await f.owner.checkpoint(C_TARGET, async () => { f.target.workerStore.setBlob(new TextEncoder().encode("slot"), new TextEncoder().encode("B2_AFTER_RELEASE")); await f.target.store.resetFromDb(); }); } finally { end(); }
    const calls = f.state.calls.length; assert.deepEqual((await f.client().continueContext(active)).data, released);
    assert.deepEqual((await f.client().changeContext(r)).data, released); assert.equal(f.state.calls.length, calls);
    assert.equal(new TextDecoder().decode(f.target.store.getConversationStateStructure().toBinary()), "B2_AFTER_RELEASE");
    assert.ok(!f.state.calls.some(c => /sendPrompt|birth|startup/.test(c)));
  } finally { await f.close(); }
});

test("reset and restore save the target backup, retain Memory and require independent activation", async () => {
  const f = await contextFixture(origin);
  try {
    const c = await captured(f), memory = structuredClone(f.source.memories), r = await f.declaration("reset");
    const reset = (await f.client().changeContext(r)).data; assert.equal(reset.state, "prepared"); assert.ok(reset.backupRef); assert.ok(reset.candidateRef);
    assert.equal(f.source.store.getConversationStateStructure().messages.length, 0); assert.deepEqual(f.source.memories, memory);
    await f.client().continueContext({ requestId: r.requestId, botRef: C_SOURCE, scopeId: C_SCOPE, confirmed: true, action: "activate", expectedRevision: (await f.client().context(C_SOURCE)).data.revision });
    const restore = await f.declaration("restore", C_SOURCE, c.value.captureRef!);
    const result = (await f.client().changeContext(restore)).data; assert.equal(result.state, "prepared"); assert.ok(result.backupRef); assert.deepEqual(f.source.memories, memory);
    assert.equal(new TextDecoder().decode(f.source.store.getConversationStateStructure().toBinary()), "PRIVATE_NATIVE_ROOT");
  } finally { await f.close(); }
});

test("lost native application reply is reconciled from the exact original marker without a second application", async () => {
  const f = await contextFixture(origin);
  try {
    const c = await captured(f), r = await f.declaration("initialize", C_TARGET, c.value.captureRef!); f.state.loseAfter = "initialize";
    await rejected(f.client().changeContext(r), "operation_unknown"); const unknown = (await f.client().contextOperation(ref(r))).data;
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.application, "effect-unknown");
    const before = f.state.calls.filter(c => c === "initialize").length; await f.restart();
    const fixed = (await f.client().continueContext(next(r, "reconcile"))).data; assert.equal(fixed.state, "prepared"); assert.equal(fixed.application, "succeeded");
    assert.equal(f.state.calls.filter(c => c === "initialize").length, before); assert.equal(before, 1);
  } finally { await f.close(); }
});

test("lost release is retried only through its idempotent original native release, never by resetting the target", async () => {
  const f = await contextFixture(origin);
  try {
    const { r } = await initialized(f);
    const q = { requestId: r.requestId, botRef: C_TARGET, scopeId: C_SCOPE, action: "activate" as const, expectedRevision: (await f.client().context(C_TARGET)).data.revision, confirmed: true as const };
    f.state.loseAfter = "activate"; await rejected(f.client().continueContext(q), "operation_unknown");
    assert.equal((await f.client().contextOperation(ref(r))).data.activation, "unknown");
    const before = f.state.calls.filter(c => c === "initialize").length; await f.restart();
    assert.equal((await f.client().continueContext(q)).data.state, "released"); assert.equal(f.state.calls.filter(c => c === "initialize").length, before);
    await rejected(f.client().continueContext({ ...q, expectedRevision: "f".repeat(64) }), "idempotency_conflict");
  } finally { await f.close(); }
});

test("stale revisions, absent original requests and missing permissions never initialize or mutate a source", async () => {
  const f = await contextFixture(origin);
  try {
    const r = await f.declaration("reset"), before = f.state.calls.length;
    await rejected(f.client(C_READER).changeContext(r), "permission_denied"); assert.equal(f.state.calls.length, before);
    await rejected(f.client().continueContext(next(r, "resume")), "not_found");
    await rejected(f.client().changeContext({ ...r, expectedRevision: "f".repeat(64) }), "source_changed");
    assert.ok(!(await readdir(f.root)).includes("continuity")); assert.ok(!f.state.calls.includes("initialize"));
    const writer = f.client(C_WRITER), r2 = await f.declaration("reset"); await writer.changeContext(r2);
    await rejected(writer.continueContext({ ...next(r2, "resume"), action: "activate", expectedRevision: (await writer.context(C_SOURCE)).data.revision }), "permission_denied");
  } finally { await f.close(); }
});

test("losing the durable reservation reply does not dispatch, while explicit resume retains the same declaration", async () => {
  const f = await contextFixture(origin);
  try {
    let fault = true; f.hooks!.afterCommit = async label => { if (label === "managed-context-prepare" && fault) { fault = false; throw Error("synthetic-lost-commit"); } };
    const r = await f.declaration("capture"); await rejected(f.client().changeContext(r), "operation_unknown");
    assert.ok(!f.state.calls.includes("capture")); assert.equal((await f.client().contextOperation(ref(r))).data.state, "admitted");
    assert.equal((await f.client().changeContext(r)).data.state, "admitted"); assert.ok(!f.state.calls.includes("capture"));
    assert.equal((await f.client().continueContext(next(r, "resume"))).data.state, "captured");
  } finally { await f.close(); }
});

test("a missing known CONT database is damage and never creates a fresh history", async () => {
  const f = await contextFixture(origin);
  try {
    const c = await captured(f); await f.server.close(); await unlink(join(f.root, "continuity/state.sqlite")); await f.restart();
    await rejected(f.client().contextOperation(ref(c.r)), "source_unavailable"); await rejected(f.client().changeContext({ ...c.r, requestId: randomUUID() }), "source_unavailable");
    assert.ok(!(await readdir(join(f.root, "continuity"))).includes("state.sqlite"));
  } finally { await f.close(); }
});

test("absent requested material is rejected before any target reservation", async () => {
  const f = await contextFixture(origin);
  try {
    const r = await f.declaration("initialize", C_TARGET, `snapshot:${C_INSTALL}:${C_SCOPE}:${randomUUID()}`);
    await assert.rejects(f.client().changeContext(r));
    assert.ok(!(await readdir(f.root)).includes("continuity"));
    const c = await captured(f), corrected = { ...r, snapshotRef: c.value.captureRef! } as ContextChange;
    assert.equal((await f.client().changeContext(corrected)).data.state, "prepared");
  } finally { await f.close(); }
});

test("safe cancellation retains its original tombstone and cannot cancel an unknown native application", async () => {
  const f = await contextFixture(origin);
  try {
    let once = true; f.hooks!.afterCommit = async label => { if (label === "managed-context-prepare" && once) { once = false; throw Error("lost-preparation-reply"); } };
    const r = await f.declaration("reset"); await rejected(f.client().changeContext(r), "operation_unknown");
    const cancel = { ...next(r, "resume"), action: "cancel" as const };
    const result = (await f.client().continueContext(cancel)).data; assert.equal(result.state, "cancelled"); assert.equal(result.application, "not-recorded");
    const calls = f.state.calls.length;
    assert.deepEqual((await f.client().continueContext(cancel)).data, result);
    assert.deepEqual((await f.client().continueContext(next(r, "resume"))).data, result);
    assert.deepEqual((await f.client().changeContext(r)).data, result); assert.equal(f.state.calls.length, calls);
    f.hooks!.afterCommit = undefined;
    const c = await captured(f), apply = await f.declaration("initialize", C_TARGET, c.value.captureRef!); f.state.loseAfter = "initialize";
    await rejected(f.client().changeContext(apply), "operation_unknown");
    const before = (await f.client().contextOperation(ref(apply))).data;
    await rejected(f.client().continueContext({ ...next(apply, "resume"), action: "cancel" }), "operation_unknown");
    assert.deepEqual((await f.client().contextOperation(ref(apply))).data, before);
    await rejected(f.client().changeContext({ ...apply, requestId: randomUUID(), expectedRevision: (await f.client().context(C_TARGET)).data.revision }), "revision_conflict");
    assert.equal(f.state.calls.filter(c => c === "initialize").length, 1);
  } finally { await f.close(); }
});

test("lost commit acknowledgement at the actual effect claim never grants a second native application", async () => {
  const f = await contextFixture(origin);
  try {
    const c = await captured(f), r = await f.declaration("initialize", C_TARGET, c.value.captureRef!); let once = true;
    f.hooks!.afterCommit = async label => { if (label === "claim-effect" && once) { once = false; throw Error("claim-ack-lost"); } };
    await rejected(f.client().changeContext(r), "operation_unknown");
    assert.equal(once, false); assert.equal(f.state.calls.filter(c => c === "initialize").length, 0);
    await f.restart(); await rejected(f.client().continueContext(next(r, "resume")), "operation_unknown");
    assert.equal(f.state.calls.filter(c => c === "initialize").length, 0);
    assert.equal((await f.client().contextOperation(ref(r))).data.application, "effect-unknown");
  } finally { await f.close(); }
});

test("client disconnection preserves the Server-owned operation and a competing process cannot drive it twice", async () => {
  const f = await contextFixture(origin); let other: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  try {
    const r = await f.declaration("capture"); let release!: () => void, entered = false;
    const gate = new Promise<void>(done => { release = done; });
    f.hooks!.beforeCommit = async label => { if (label === "managed-context-prepare") { entered = true; await gate; } };
    const controller = new AbortController(), pending = f.client().changeContext(r, controller.signal).catch(e => e);
    await until(async () => entered); controller.abort(); const lost = await pending; assert.equal(lost.code, "operation_unknown");
    other = await startManagementServer({ ...f.options, port: 0 });
    const second = new ManagementClient({ baseUrl: other.url, installationId: C_INSTALL, credential: async () => C_OWNER });
    assert.equal((await second.identity()).data.installationId, C_INSTALL);
    const competing = second.changeContext(r).catch(e => e); release();
    await competing; await until(async () => (await f.client().contextOperation(ref(r))).data.state === "captured");
    assert.equal(f.state.calls.filter(c => c === "capture").length, 1);
    assert.equal((await second.contextOperation(ref(r))).data.state, "captured");
  } finally { await other?.close(); await f.close(); }
});

test("revoked final authorization prevents native mutation and delayed head data is not returned to a revoked reader", async () => {
  const f = await contextFixture(origin);
  try {
    const r = await f.declaration("reset");
    f.hooks!.afterCommit = async label => { if (label === "managed-context-prepare") f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(c => c !== "context.write"); };
    await rejected(f.client().changeContext(r), "permission_denied"); assert.ok(!f.state.calls.includes("initialize"));
    assert.equal((await f.client().contextOperation(ref(r))).data.state, "admitted");
    f.hooks!.afterCommit = undefined;
    let release!: () => void, entered = false; const gate = new Promise<void>(done => { release = done; });
    const transport = f.options.native.continuityAccess;
    const wrapped = (signal: AbortSignal) => { const native = transport(signal); return { ...native, currentStateControl: async (...args: Parameters<typeof native.currentStateControl>) => {
      const reply = await native.currentStateControl(...args); entered = true; await gate; return reply;
    } }; };
    const other = await startManagementServer({ ...f.options, native: { ...f.native, continuityAccess: wrapped }, port: 0 });
    try {
      const client = new ManagementClient({ baseUrl: other.url, installationId: C_INSTALL, credential: async () => C_READER });
      const pending = client.context(C_SOURCE); void pending.catch(() => undefined); await until(async () => entered);
      f.state.grants[2]!.capabilities = f.state.grants[2]!.capabilities.filter(c => c !== "context.read"); release();
      await rejected(pending, "permission_denied");
    } finally { release?.(); await other.close(); }
  } finally { await f.close(); }
});

test("material pins precede capture and remain protected until the matching context release", async () => {
  const f = await contextFixture(origin);
  try {
    const r = await f.declaration("reset"), value = (await f.client().changeContext(r)).data;
    const store = openContinuityRecoveryStore({ durableRoot: f.root, scopeId: C_SCOPE });
    const backupId = protectionReferenceIdentity(value.backupRef!, C_INSTALL, "snapshot").id;
    const candidateId = protectionReferenceIdentity(value.candidateRef!, C_INSTALL, "snapshot").id;
    const material = await store.readSnapshot(backupId);
    // Retention uses the source capture time, not the time a copy was stored.
    const later = Date.now() + 1000;
    for (let i = 0; i < 6; i++) await store.publish({ requestId: randomUUID(), manifest: { ...material.manifest, source: { ...material.manifest.source, capturedAtMs: later + i } }, content: material.content });
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    assert.equal((await store.readSnapshot(backupId)).reference.ref, backupId); assert.equal((await store.readSnapshot(candidateId)).reference.ref, candidateId);
    await f.client().continueContext({ ...next(r, "resume"), action: "activate", expectedRevision: (await f.client().context(C_SOURCE)).data.revision });
    await store.owners.recovery.maintain({ nowMs: Date.now(), maxItems: 64 });
    await assert.rejects(store.readSnapshot(backupId)); await assert.rejects(store.readSnapshot(candidateId));
  } finally { await f.close(); }
});

test("packed CLI uses the same head, private capture, initialization, activation and original recovery endpoints", async () => {
  const f = await contextFixture(origin);
  async function cli(args: string[], expected = 0) {
    const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root,
      GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_CONTEXT_CREDENTIAL: C_OWNER }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000), [code, signal] = await once(child, "close"); clearTimeout(timer);
    assert.equal(signal, null); assert.equal(code, expected, out + err); assert.ok(!/PRIVATE_|synthetic-context-owner/.test(out + err)); return out ? JSON.parse(out) : null;
  }
  try {
    const head = (await cli(["bot", "context", "get", C_SOURCE])).data, id = randomUUID();
    const captured = (await cli(["bot", "snapshot", "create", "--bot", C_SOURCE, "--scope-id", C_SCOPE, "--request-id", id, "--expect-revision", head.revision, "--confirm"])).data;
    assert.equal(captured.state, "captured");
    const q = await f.declaration("initialize", C_TARGET, captured.captureRef);
    const prepared = (await cli(["bot", "context", "initialize", C_TARGET, "--scope-id", C_SCOPE, "--snapshot-ref", captured.captureRef, "--request-id", q.requestId, "--expect-revision", q.expectedRevision, "--confirm"])).data;
    assert.equal(prepared.state, "prepared");
    const now = (await cli(["bot", "context", "get", C_TARGET])).data;
    assert.equal((await cli(["bot", "activate", C_TARGET, "--scope-id", C_SCOPE, "--request-id", q.requestId, "--expect-revision", now.revision, "--confirm"])).data.state, "released");
    f.state.failNative = true; const calls = f.state.calls.length;
    assert.equal((await cli(["operation", "get", "--domain", "context", "--scope-id", C_SCOPE, "--request-id", q.requestId])).data.state, "released");
    assert.equal(f.state.calls.length, calls);
    const unavailable = await cli(["bot", "context", "get", C_SOURCE], 7); assert.equal(unavailable.error.code, "source_unavailable");
    await cli(["agents", "state", "show", C_SOURCE], 2);
  } finally { await f.close(); }
});

test("packed management SIGKILL after native apply preserves the original marker and never reinitializes the target", async () => {
  const f = await contextFixture(origin); let child: ReturnType<typeof spawn> | undefined;
  async function stop(signal: NodeJS.Signals) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close"), timer = setTimeout(() => child?.kill("SIGKILL"), 5000); child.kill(signal); await closed; clearTimeout(timer); child = undefined;
  }
  async function launch() {
    child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, "system", "service", "run", "server", "--root", f.root, "--native-discovery", join(f.root, "gateway.json"), "--port", "0"],
      { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b);
    await until(async () => out.includes("\n"), 8000); const started = JSON.parse(out.split("\n")[0]!); assert.equal(started.ok, true, err);
    return new ManagementClient({ baseUrl: started.data.url, installationId: C_INSTALL, credential: async () => C_OWNER });
  }
  try {
    const c = await captured(f), r = await f.declaration("initialize", C_TARGET, c.value.captureRef!); await f.server.close();
    const first = await launch(); f.state.stallAfter = "initialize"; const pending = first.changeContext(r).catch(() => undefined);
    await until(async () => f.state.stalled > 0); assert.deepEqual(f.target.memories, f.source.memories);
    await stop("SIGKILL"); await pending; f.state.stallAfter = ""; const second = await launch();
    assert.equal((await second.contextOperation(ref(r))).data.application, "effect-unknown");
    assert.equal((await second.continueContext(next(r, "reconcile"))).data.state, "prepared");
    assert.equal(f.state.calls.filter(c => c === "initialize").length, 1);
    await stop("SIGTERM"); const data = await readFile(join(f.root, "continuity/state.sqlite")); await sleep(100); assert.deepEqual(await readFile(join(f.root, "continuity/state.sqlite")), data);
  } finally { await stop("SIGKILL"); await f.close(); }
});

test("shutdown aborts a stalled native capture, joins durable settlement and never writes after close", async () => {
  const f = await contextFixture(origin);
  try {
    const r = await f.declaration("capture"); f.state.slowAction = "capture";
    const pending = f.client().changeContext(r).catch(() => undefined); await until(async () => f.state.stalled > 0);
    await f.server.close(); await pending; await until(async () => f.state.aborted > 0);
    const before = await readFile(join(f.root, "continuity/state.sqlite")); await sleep(100); assert.deepEqual(await readFile(join(f.root, "continuity/state.sqlite")), before);
    f.state.slowAction = ""; await f.restart(); assert.equal((await f.client().contextOperation(ref(r))).data.state, "unknown");
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { startManagementServer } from "../src/server.ts";
import { compactionFixture, deferred, C_INSTALL, C_BOT, C_SCOPE, C_READER, C_OTHER, C_OWNER } from "../../../apps/web/test/compaction-fixture.ts";
const origin = "https://compaction.example.test";
type Fixture = Awaited<ReturnType<typeof compactionFixture>>;
async function request(f: Fixture) { const p = (await f.client().compactionPreview(C_BOT)).data; return { requestId: randomUUID(), botRef: p.botRef, scopeId: p.scopeId, expectedRevision: p.revision, confirmed: true as const }; }
async function until<A>(read: () => Promise<A>, check: (v: A) => boolean) { const end = Date.now() + 8000; let last: unknown; do { const v = await read(); if (check(v)) return v; last = v; await new Promise(r => setTimeout(r, 20)); } while (Date.now() < end); throw Error(`compaction-deadline:${JSON.stringify(last)}`); }

test("preview is a fresh, bounded plan with no CONT initialization, source body, summary or mutation permission", async () => {
  const f = await compactionFixture(origin);
  try {
    const v = (await f.client(C_READER).compactionPreview(C_BOT)).data;
    assert.equal(v.nativeCapability, "ready"); assert.equal(v.rootSelection, "current-at-dispatch"); assert.equal(v.mayCallModel, true);
    assert.equal(v.scopeId, C_SCOPE); assert.ok(v.budget.inputTokens > 0); assert.equal(f.state.summaries, 0); assert.equal(f.state.checkpoints, 0);
    await assert.rejects(lstat(join(f.root, "continuity")), { code: "ENOENT" });
    const r = await request(f); await assert.rejects(f.client(C_READER).compact(r), { code: "permission_denied" });
    assert.equal(f.state.dispatches, 0); assert.equal(JSON.stringify(v).includes("PRIVATE_"), false);
  } finally { await f.close(); }
});

test("shared management executes original manual facade, Unix modeld and native checkpoint; replay/restart are history only", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f), before = f.current();
    const result = (await f.client().compact(r)).data;
    assert.equal(result.state, "completed"); assert.equal(result.result!.outcome, "committed"); assert.equal(result.result!.persisted, true);
    assert.ok(result.result!.beforeTokens > result.result!.afterTokens); assert.ok(result.result!.summaryRequests > 0);
    assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1); assert.equal(f.state.userInputs, 0);
    assert.deepEqual(f.current().at(-1), before.at(-1)); assert.ok(JSON.stringify(f.current()).includes("FACT_0=value0"));
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false); assert.equal(result.currentRoot, "not-observed");
    const counters = [f.state.summaries, f.state.checkpoints, f.state.dispatches], calls = f.state.calls.length;
    f.state.unavailable = true;
    assert.deepEqual((await f.client().compact(r)).data, result);
    assert.equal(f.state.calls.length, calls);
    await f.restart();
    assert.deepEqual((await f.client().compactionOperation(C_SCOPE, r.requestId)).data, result);
    assert.deepEqual([f.state.summaries, f.state.checkpoints, f.state.dispatches], counters);
    await assert.rejects(f.client(C_OTHER).compactionOperation(C_SCOPE, r.requestId), { code: "not_found" });
    await assert.rejects(f.client().compact({ ...r, expectedRevision: "f".repeat(64) }), { code: "idempotency_conflict" });
  } finally { await f.close(); }
});

test("manual no-op consumes the exact request and never acquires future work after ordinary input", async () => {
  const f = await compactionFixture(origin, { small: true });
  try {
    const r = await request(f), v = (await f.client().compact(r)).data;
    assert.equal(v.state, "completed"); assert.equal(v.result!.outcome, "unchanged"); assert.equal(v.result!.persisted, false);
    assert.equal(f.state.summaries, 0); assert.equal(f.state.checkpoints, 0);
    await f.ordinaryRun("Later real input", {});
    await f.restart(); assert.deepEqual((await f.client().compact(r)).data, v); assert.equal(f.state.dispatches, 1); assert.equal(f.state.userInputs, 1);
  } finally { await f.close(); }
});

test("lost native response recovers the original returned operation without dispatch, including after Server restart", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); f.state.loseReply = true;
    await assert.rejects(f.client().compact(r), { code: "operation_unknown" });
    assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "unknown");
    await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, scopeId: C_SCOPE, botRef: r.botRef, action: "cancel", confirmed: true }), { code: "revision_conflict" });
    await assert.rejects(f.client().compact({ ...r, requestId: randomUUID() }), { code: "revision_conflict" });
    await f.restart(); f.state.loseReply = false;
    const v = (await f.client().continueCompaction({ requestId: r.requestId, scopeId: C_SCOPE, botRef: r.botRef, action: "reconcile", confirmed: true })).data;
    assert.equal(v.state, "completed"); assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1);
  } finally { await f.close(); }
});

test("a modeld commit with absent native settlement remains unknown; resume cannot replay it or substitute another target", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); f.state.loseReply = true; await assert.rejects(f.client().compact(r), { code: "operation_unknown" }); f.state.historyUnavailable = true;
    const next = { requestId: r.requestId, scopeId: C_SCOPE, botRef: r.botRef, action: "resume" as const, confirmed: true as const };
    await assert.rejects(f.client().continueCompaction(next), { code: "operation_unknown" });
    await f.restart(); await assert.rejects(f.client().continueCompaction(next), { code: "operation_unknown" });
    assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "unknown");
    await assert.rejects(f.client().continueCompaction({ ...next, botRef: `bot:${C_INSTALL}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` }), { code: "idempotency_conflict" });
    assert.equal(f.state.dispatches, 1);
  } finally { await f.close(); }
});

test("changed preview policy/source, busy native state, foreign ownership and wrong installation refuse before dispatch", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f);
    await assert.rejects(f.client().compact({ ...r, expectedRevision: "0".repeat(64) }), { code: "revision_conflict" });
    f.state.busy = true; await assert.rejects(f.client().compact(r), { code: "revision_conflict" }); f.state.busy = false;
    f.state.foreign = true; await assert.rejects(f.client().compact(r), { code: "source_changed" }); f.state.foreign = false;
    assert.throws(() => f.client().compact({ ...r, botRef: `bot:22222222-2222-4222-8222-222222222222:${C_BOT}` }), { code: "wrong_installation" });
    assert.equal(f.state.dispatches, 0); await assert.rejects(lstat(join(f.root, "continuity")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("source scope changes never reinterpret a pending compaction or replace the original CONT database", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); f.state.loseReply = true; await assert.rejects(f.client().compact(r), { code: "operation_unknown" });
    const before = await readFile(join(f.root, "continuity", "state.sqlite")); f.state.scopeId = "b".repeat(64);
    await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, scopeId: C_SCOPE, botRef: r.botRef, action: "reconcile", confirmed: true }), { code: "source_changed" });
    assert.deepEqual(await readFile(join(f.root, "continuity", "state.sqlite")), before); assert.equal(f.state.dispatches, 1);
  } finally { await f.close(); }
});

test("client disconnect does not abort the accepted Server operation or turn queued ordinary input into a hidden prompt", async () => {
  const f = await compactionFixture(origin); f.state.waitSummary = deferred();
  try {
    const r = await request(f), abort = new AbortController();
    const pending = f.client().compact(r, abort.signal).then(v => v, e => e);
    await f.state.started.promise; abort.abort(); assert.equal((await pending).code, "operation_unknown");
    const normal = f.ordinaryRun("Actually new input", {}); await Promise.resolve(); assert.equal(f.state.userInputs, 0);
    f.state.waitSummary.resolve();
    await until(() => f.client().compactionOperation(C_SCOPE, r.requestId), v => v.data.state === "completed");
    await normal; assert.equal(f.state.userInputs, 1); assert.equal(f.state.dispatches, 1);
  } finally { await f.close(); }
});

test("a settled summary failure is retained without replay, but does not permanently block a new explicitly approved operation", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f), before = f.current(); f.state.summaryFailure = true;
    await assert.rejects(f.client().compact(r), { code: "compaction_failed" });
    const failed = (await f.client().compactionOperation(C_SCOPE, r.requestId)).data;
    assert.equal(failed.state, "failed"); assert.equal(failed.failureCode, "summary_unavailable"); assert.equal(failed.nativeSettlement, "returned");
    assert.equal(failed.result, null); assert.deepEqual(f.current(), before); assert.equal(f.state.checkpoints, 0);
    f.state.summaryFailure = false; await f.restart();
    await assert.rejects(f.client().compact(r), { code: "compaction_failed" }); assert.equal(f.state.dispatches, 1);
    const next = await request(f); assert.equal((await f.client().compact(next)).data.state, "completed"); assert.equal(f.state.dispatches, 2);
    assert.deepEqual((await f.client().compactionOperation(C_SCOPE, r.requestId)).data, failed);
  } finally { await f.close(); }
});

test("checkpoint acknowledgement loss is not a safe terminal failure and cannot be cleared by another UUID", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); f.state.checkpointUnknown = true;
    await assert.rejects(f.client().compact(r), { code: "operation_unknown" }); assert.equal(f.state.checkpoints, 1);
    const q = { requestId: r.requestId, scopeId: C_SCOPE, botRef: r.botRef, action: "reconcile" as const, confirmed: true as const };
    await f.restart(); await assert.rejects(f.client().continueCompaction(q), { code: "operation_unknown" });
    await assert.rejects(f.client().compact({ ...r, requestId: randomUUID() }), { code: "revision_conflict" });
    const pending = (await f.client().compactionOperation(C_SCOPE, r.requestId)).data;
    assert.equal(pending.state, "unknown"); assert.equal(pending.failureCode, null); assert.equal(f.state.dispatches, 1);
  } finally { await f.close(); }
});

for (const resume of [false, true]) test(`lost preparation can ${resume ? "resume only the original plan" : "cancel without native work"}`, async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); let once = true;
    f.hooks.afterCommit = async label => { if (label === "managed-compaction-prepare" && once) { once = false; throw Error("prepare-ack-lost"); } };
    await assert.rejects(f.client().compact(r), { code: "operation_unknown" });
    assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "admitted"); assert.equal(f.state.dispatches, 0);
    const original = { requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, confirmed: true as const, action: resume ? "resume" as const : "cancel" as const };
    const done = (await f.client().continueCompaction(original)).data;
    assert.equal(done.state, resume ? "completed" : "cancelled"); assert.equal(f.state.dispatches, resume ? 1 : 0);
    assert.deepEqual((await f.client().compact(r)).data, done); assert.equal(f.state.dispatches, resume ? 1 : 0);
  } finally { await f.close(); }
});

for (const phase of ["managed-compaction-claim", "managed-compaction-settle"] as const) test(`the actual ${phase} commit boundary never repeats its native dispatch`, async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f); let once = true;
    f.hooks.afterCommit = async label => { if (label === phase && once) { once = false; throw Error("local-ack-lost"); } };
    if (phase === "managed-compaction-claim") {
      await assert.rejects(f.client().compact(r), { code: "operation_unknown" });
      await f.restart(); await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, confirmed: true, action: "resume" }), { code: "operation_unknown" });
      assert.equal(f.state.dispatches, 0); assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "unknown");
    } else {
      assert.equal((await f.client().compact(r)).data.state, "completed"); await f.restart();
      assert.equal((await f.client().compact(r)).data.state, "completed"); assert.equal(f.state.dispatches, 1);
    }
    assert.equal(once, false);
  } finally { await f.close(); }
});

test("revocation after reservation prevents dispatch and retains cancellable preparation, never promotes another permission", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f);
    f.hooks.afterCommit = async label => { if (label === "managed-compaction-prepare") f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(c => c !== "context.compact"); };
    await assert.rejects(f.client().compact(r), { code: "permission_denied" }); assert.equal(f.state.dispatches, 0);
    assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "admitted");
    assert.ok(f.state.grants[0]!.capabilities.includes("context.write"));
    await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "resume", confirmed: true }), { code: "permission_denied" });
    f.hooks.afterCommit = undefined; f.state.grants[0]!.capabilities = [...CAPABILITIES];
    assert.equal((await f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "cancel", confirmed: true })).data.state, "cancelled");
  } finally { await f.close(); }
});

test("revocation at the durable dispatch claim cannot authorize even the first native call", async () => {
  const f = await compactionFixture(origin);
  try {
    const r = await request(f);
    f.hooks.afterCommit = async label => { if (label === "managed-compaction-claim") f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(c => c !== "context.compact"); };
    await assert.rejects(f.client().compact(r), { code: "operation_unknown" });
    assert.equal(f.state.dispatches, 0); assert.equal(f.state.summaries, 0);
    assert.equal((await f.client().compactionOperation(C_SCOPE, r.requestId)).data.state, "unknown");
    f.state.grants[0]!.capabilities = [...CAPABILITIES]; f.hooks.afterCommit = undefined;
    await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "resume", confirmed: true }), { code: "operation_unknown" });
    assert.equal(f.state.dispatches, 0);
  } finally { await f.close(); }
});

test("Server shutdown does not mistake modeld publication for native shell completion or allow late CONT writes", async () => {
  const f = await compactionFixture(origin); f.state.waitCleanup = deferred();
  try {
    const r = await request(f), pending = f.client().compact(r).catch(e => e);
    await until(async () => f.state.checkpoints, n => n === 1); await f.server.close(); await pending;
    const path = join(f.root, "continuity", "state.sqlite"), before = await readFile(path);
    await f.restart();
    await assert.rejects(f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "reconcile", confirmed: true }), { code: "operation_unknown" });
    f.state.waitCleanup.resolve();
    await until(async () => (await f.control.call({ action: "status", agentId: C_BOT, operationId: (await import("@grokbox/box-runtime/runtime")).compactionControlId(C_INSTALL, "owner", r.requestId) }) as any).data.operationSettlement, value => value === "returned");
    assert.deepEqual(await readFile(path), before);
    assert.equal((await f.client().continueCompaction({ requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "reconcile", confirmed: true })).data.state, "completed");
    assert.equal(f.state.dispatches, 1);
  } finally { await f.close(); }
});

test("packed CLI previews, submits and reads the original compaction without the retired native client", async () => {
  const f = await compactionFixture(origin);
  async function cli(args: string[], expected = 0) {
    const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, COMPACTION_MANAGEMENT_TOKEN: C_OWNER }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { const [code, signal] = await once(child, "close"); assert.equal(signal, null); assert.equal(code, expected, out + err); }
    finally { clearTimeout(timer); }
    assert.ok(!/PRIVATE_|synthetic-compaction-owner/.test(out + err)); return JSON.parse(out || err);
  }
  try {
    const p = (await cli(["bot", "context", "compact", C_BOT, "--preview"])).data, id = randomUUID();
    assert.equal(f.state.summaries, 0);
    const r = (await cli(["bot", "context", "compact", C_BOT, "--scope-id", p.scopeId, "--expect-revision", p.revision, "--request-id", id, "--confirm"])).data;
    assert.equal(r.state, "completed"); assert.equal(f.state.dispatches, 1);
    f.state.unavailable = true; const calls = f.state.calls.length;
    assert.deepEqual((await cli(["operation", "get", "--domain", "compaction", "--scope-id", C_SCOPE, "--request-id", id])).data, r);
    assert.equal(f.state.calls.length, calls);
    assert.equal((await cli(["agents", "compact", C_BOT, "--operation-id", "retired", "--confirm"], 2)).error.code, "invalid_usage");
  } finally { await f.close(); }
});

test("packed Server SIGKILL during native cleanup preserves unknown; only that original shell's settlement resolves it", async () => {
  const f = await compactionFixture(origin); let child: ReturnType<typeof spawn> | undefined;
  async function stop(signal: NodeJS.Signals) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const original = child, closed = once(original, "close"), timer = setTimeout(() => original.kill("SIGKILL"), 5000);
    original.kill(signal); try { await closed; } finally { clearTimeout(timer); child = undefined; }
  }
  async function launch() {
    child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, "system", "service", "run", "server", "--root", f.root, "--native-discovery", join(f.root, "gateway.json"), "--port", "0"],
      { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b);
    await until(async () => out, value => value.includes("\n"));
    const started = JSON.parse(out.split("\n")[0]!); assert.equal(started.ok, true, err);
    return new ManagementClient({ baseUrl: started.data.url, installationId: C_INSTALL, credential: async () => C_OWNER });
  }
  try {
    const r = await request(f); await f.server.close(); f.state.waitCleanup = deferred();
    const first = await launch(), pending = first.compact(r).catch(() => undefined);
    await until(async () => f.state.checkpoints, value => value === 1); await stop("SIGKILL"); await pending;
    const second = await launch(), continuation = { requestId: r.requestId, botRef: r.botRef, scopeId: C_SCOPE, action: "reconcile" as const, confirmed: true as const };
    assert.equal((await second.compactionOperation(C_SCOPE, r.requestId)).data.state, "unknown");
    await assert.rejects(second.continueCompaction(continuation), { code: "operation_unknown" });
    f.state.waitCleanup.resolve();
    await until(async () => { try { return (await second.continueCompaction(continuation)).data.state; } catch { return "unknown"; } }, state => state === "completed");
    assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1); assert.equal(f.state.userInputs, 0);
    await stop("SIGTERM"); const before = await readFile(join(f.root, "continuity/state.sqlite")); await new Promise(r => setTimeout(r, 80)); assert.deepEqual(await readFile(join(f.root, "continuity/state.sqlite")), before);
  } finally { await stop("SIGKILL"); await f.close(); }
});

test("competing management instances cannot dispatch the same original operation twice", async () => {
  const f = await compactionFixture(origin); let second: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  f.state.waitSummary = deferred();
  try {
    const r = await request(f), pending = f.client().compact(r); void pending.catch(() => undefined); await f.state.started.promise;
    second = await startManagementServer({ ...f.serverOptions, port: 0 });
    const client = new ManagementClient({ baseUrl: second.url, installationId: C_INSTALL, credential: async () => C_OWNER });
    assert.equal((await client.identity()).data.installationId, C_INSTALL);
    await assert.rejects(client.compact(r), { code: "operation_unknown" });
    f.state.waitSummary.resolve(); assert.equal((await pending).data.state, "completed"); assert.equal(f.state.dispatches, 1);
    assert.equal((await client.compactionOperation(C_SCOPE, r.requestId)).data.state, "completed");
  } finally { f.state.waitSummary.resolve(); await second?.close(); await f.close(); }
});

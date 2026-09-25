import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Effect } from "effect";
import { ManagementClient, type LifecycleIntent } from "@grokbox/client";
import { continuityWorkflowPrograms } from "../../box-runtime/src/internal/io/continuity-workflows.node.ts";
import { managedWorkflowId } from "../src/lifecycle.ts";
import { startManagementServer } from "../src/server.ts";
import { createNativeBotLifecycle, createNativeBotHandover, createNativeBotProtection, openBotLifecycle, type NativeContinuityContext } from "@grokbox/box-runtime/runtime";
import { continuityProtection } from "@grokbox/runtime-kernel/continuity";
import { lifecycleFixture, lifecycleIntent, L_SOURCE, L_INSTALL, L_SCOPE, L_OWNER, L_READER, L_OTHER, L_LIMITED } from "../../../apps/web/test/lifecycle-fixture.ts";
const origin = "https://lifecycle.example.test";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: any) => e?.code === code);
async function submit(f: Awaited<ReturnType<typeof lifecycleFixture>>, intent = lifecycleIntent(), token = L_OWNER) {
  const client = f.client(token), plan = (await client.previewLifecycle(intent)).data;
  const input = { ...intent, scopeId: plan.scopeId, planRevision: plan.planRevision, confirmed: true as const };
  return { input, plan, result: (await client.submitLifecycle(input)).data };
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  do { const value = await read(); if (ready(value)) return value; await delay(20); } while (Date.now() < end);
  throw Error("lifecycle-test-deadline");
}

test("preview and initial listing are read-only and omit private declarations", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const before = await readdir(f.root), intent = lifecycleIntent();
    assert.deepEqual((await f.client().lifecycles()).data.operations, []);
    const preview = (await f.client().previewLifecycle(intent)).data;
    assert.equal(preview.planPersisted, false); assert.equal(preview.nativeEffectsPerformed, false);
    assert.equal(preview.activate, false); assert.equal(preview.start, false); assert.equal(f.state.created, 0);
    assert.deepEqual(await readdir(f.root), before);
    for (const secret of [intent.instructions, "PRIVATE_SOURCE_DESCRIPTION", f.root, "synthetic-lifecycle-native"]) assert.ok(!JSON.stringify(preview).includes(secret));
    assert.ok(f.state.calls.includes("/api/grokboxCurrentStateControl"));
  } finally { await f.close(); }
});

for (const kind of ["clone", "replace", "spawn"] as const) test(`${kind} uses the original staged workflow and a historical replay never repeats effects`, async () => {
  const f = await lifecycleFixture(origin);
  try {
    const { input, plan, result } = await submit(f, lifecycleIntent(kind));
    assert.equal(result.state, kind === "clone" ? "ready" : kind === "replace" ? "active_with_handover" : "active");
    assert.equal(result.effectsUnknown, false); assert.equal(f.state.created, 1); assert.equal(result.privateInputsIncluded, false);
    assert.equal(f.state.started, kind === "spawn" ? 1 : 0); assert.equal(f.state.handedOver, kind === "replace" ? 1 : 0);
    assert.equal(result.currentTargetUsability, "not-observed"); assert.equal(result.sourceRetirement, "not-observed");
    const calls = f.state.calls.length; f.state.failNative = true;
    assert.deepEqual((await f.client().submitLifecycle(input)).data, result);
    if (kind !== "replace") {
      assert.deepEqual((await f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: plan.planRevision, confirmed: true })).data, result);
      assert.equal(f.state.calls.length, calls);
    } else {
      await rejects(f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: plan.planRevision, confirmed: true }), "source_unavailable");
      f.state.failNative = false;
      await f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: plan.planRevision, confirmed: true });
      assert.equal(f.state.handedOver, 2); assert.equal(f.state.initialized, 1);
    }
    assert.equal(f.state.created, 1);
    await f.restart(); assert.deepEqual((await f.client().lifecycle(result.operationRef)).data, result);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  } finally { await f.close(); }
});

test("changed input or stale preview cannot create a substitute workflow", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const intent = lifecycleIntent(), p = (await f.client().previewLifecycle(intent)).data;
    f.state.sourceName = "Changed source";
    await rejects(f.client().submitLifecycle({ ...intent, scopeId: L_SCOPE, planRevision: p.planRevision, confirmed: true }), "revision_conflict");
    assert.equal(f.state.created, 0); assert.deepEqual((await f.client().lifecycles()).data.operations, []);
    const done = await submit(f, intent);
    await rejects(f.client().submitLifecycle({ ...done.input, instructions: "Different declaration" }), "idempotency_conflict");
    await rejects(f.client().resumeLifecycle({ requestId: intent.requestId, scopeId: L_SCOPE, planRevision: "f".repeat(64), confirmed: true }), "idempotency_conflict");
    assert.equal(f.state.created, 1);
  } finally { await f.close(); }
});

test("unknown birth keeps the original request across restart and explicit resume never sends a second create", async () => {
  const f = await lifecycleFixture(origin);
  try {
    f.state.failBirth = true; const { input, result } = await submit(f);
    assert.equal(result.state, "blocked"); assert.equal(result.effectsUnknown, true); assert.equal(result.targetBotRef, null);
    assert.equal(f.state.created, 1); assert.ok(result.steps.some(s => s.step === "create" && s.state === "effect_unknown"));
    await f.restart(); f.state.failBirth = false;
    const resumed = (await f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: input.planRevision, confirmed: true })).data;
    assert.equal(resumed.effectsUnknown, true); assert.equal(f.state.created, 1);
    assert.equal((await f.client().lifecycles()).data.operations.length, 1);
  } finally { await f.close(); }
});

test("known target survives a later failure and explicit resume continues only the same safe stage", async () => {
  const f = await lifecycleFixture(origin);
  try {
    f.state.failLoad = true; const { input, result } = await submit(f);
    assert.equal(result.state, "blocked"); assert.ok(result.targetBotRef); assert.equal(f.state.created, 1);
    await f.restart(); f.state.failLoad = false;
    const resumed = (await f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: input.planRevision, confirmed: true })).data;
    assert.equal(resumed.state, "ready"); assert.equal(resumed.targetBotRef, result.targetBotRef); assert.equal(f.state.created, 1); assert.equal(f.state.initialized, 1);
  } finally { await f.close(); }
});

test("ready is a checkpoint before activation, not proof that all requested stages completed", async () => {
  const f = await lifecycleFixture(origin);
  try {
    f.state.failActivation = true; const { input } = await submit(f, lifecycleIntent("clone", { activate: true }));
    const db = continuityWorkflowPrograms({ durableRoot: f.root, scopeId: L_SCOPE });
    await Effect.runPromise(db.phase(managedWorkflowId(L_INSTALL, "owner", input.requestId), "ready"));
    f.state.failActivation = false;
    const resumed = (await f.client().resumeLifecycle({ requestId: input.requestId, scopeId: L_SCOPE, planRevision: input.planRevision, confirmed: true })).data;
    assert.equal(resumed.state, "active"); assert.equal(f.state.activated, 1); assert.equal(f.state.created, 1); assert.equal(f.state.initialized, 1);
  } finally { await f.close(); }
});

test("principal-scoped pagination never discloses another actor's inputs or consumes their page window", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const one = await submit(f), other = await submit(f, lifecycleIntent("clone", { requestId: one.input.requestId }), L_OTHER), two = await submit(f);
    assert.notEqual(other.result.targetBotRef, one.result.targetBotRef);
    await rejects(f.client(L_READER).lifecycle(one.result.operationRef), "not_found");
    const first = (await f.client().lifecycles({ limit: 1 })).data; assert.equal(first.operations.length, 1); assert.ok(first.nextCursor);
    const next = (await f.client().lifecycles({ limit: 1, cursor: first.nextCursor! })).data; assert.equal(next.operations.length, 1); assert.equal(next.nextCursor, null);
    assert.deepEqual([first.operations[0]!.requestId, next.operations[0]!.requestId].sort(), [one.input.requestId, two.input.requestId].sort());
    await rejects(f.client(L_OTHER).lifecycles({ cursor: first.nextCursor! }), "invalid_input");
    assert.deepEqual((await f.client(L_READER).lifecycles()).data.operations, []);
  } finally { await f.close(); }
});

test("startup and user-authored handover messages need separate capabilities, rechecked before each stage", async () => {
  const f = await lifecycleFixture(origin);
  try {
    await rejects(f.client(L_READER).previewLifecycle(lifecycleIntent()), "permission_denied");
    await rejects(f.client(L_LIMITED).previewLifecycle(lifecycleIntent("spawn")), "permission_denied");
    await rejects(f.client(L_LIMITED).previewLifecycle(lifecycleIntent("replace", { allowHandoverMessages: true })), "permission_denied");
    assert.equal(f.state.created, 0);
    await submit(f, lifecycleIntent(), L_LIMITED);
    f.state.revokeAfterBirth = true;
    const p = (await f.client(L_OTHER).previewLifecycle(lifecycleIntent())).data; assert.ok(p.planRevision);
    f.state.revokeAfterBirth = false;
    const intent = lifecycleIntent(), preview = (await f.client().previewLifecycle(intent)).data;
    f.state.revokeAfterBirth = true; f.state.created = 0;
    const blocked = (await f.client().submitLifecycle({ ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true })).data;
    assert.equal(blocked.state, "blocked"); assert.equal(f.state.created, 1); assert.ok(!blocked.steps.some(s => s.step === "load"));
  } finally { await f.close(); }
});

test("lost HTTP reply recovers by original identity without native reads or input resubmission", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const intent = lifecycleIntent(), preview = (await f.client().previewLifecycle(intent)).data;
    let posts = 0;
    const client = f.client(L_OWNER, (async (url, init) => { const response = await fetch(url, init); if (init?.method === "POST") { posts++; await response.arrayBuffer(); throw Error("synthetic-lost-response"); } return response; }) as typeof fetch);
    await rejects(client.submitLifecycle({ ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true }), "operation_unknown");
    f.state.failNative = true;
    const result = (await f.client().lifecycle(preview.operationRef)).data; assert.equal(result.state, "ready"); assert.equal(posts, 1); assert.equal(f.state.created, 1);
  } finally { await f.close(); }
});

test("HTTP disconnect does not cancel the admitted workflow and parallel identical submissions create once", async () => {
  const f = await lifecycleFixture(origin);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
  try {
    const intent = lifecycleIntent(), preview = (await f.client().previewLifecycle(intent)).data;
    f.state.holdCreate = async () => { entered(); await gate; };
    const input = { ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true as const };
    const controller = new AbortController(), pending = f.client().submitLifecycle(input, controller.signal); void pending.catch(() => undefined);
    await reached; controller.abort(); await rejects(pending, "operation_unknown");
    const second = await f.client().submitLifecycle(input); assert.ok(["progressing", "prepared"].includes(second.data.state));
    release(); const result = await until(() => f.client().lifecycle(preview.operationRef), v => v.data.state === "ready");
    assert.equal(result.data.effectsUnknown, false); assert.equal(f.state.created, 1);
  } finally { release(); await f.close(); }
});

test("independent management servers share one manual driver gate without blocking receipt reads or double-creating", async () => {
  const f = await lifecycleFixture(origin); let second: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
  try {
    const intent = lifecycleIntent(), preview = (await f.client().previewLifecycle(intent)).data;
    const another = lifecycleIntent(), nextPreview = (await f.client().previewLifecycle(another)).data;
    second = await startManagementServer({ ...f.options, port: 0 }, { hostHealth: { enabled: false }, lifecycle: { create: f.create } });
    const client = new ManagementClient({ baseUrl: second.url, installationId: L_INSTALL, credential: async () => L_OWNER });
    f.state.holdCreate = async () => { entered(); await gate; };
    const input = { ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true as const };
    const pending = f.client().submitLifecycle(input); void pending.catch(() => undefined); await reached;
    const seen = (await client.submitLifecycle(input)).data;
    assert.equal(seen.effectsUnknown, true); assert.equal(seen.requestId, intent.requestId);
    await rejects(client.submitLifecycle({ ...another, scopeId: L_SCOPE, planRevision: nextPreview.planRevision, confirmed: true }), "unavailable");
    await rejects(client.lifecycle(nextPreview.operationRef), "not_found");
    assert.equal((await client.identity()).data.installationId, L_INSTALL);
    release(); assert.equal((await pending).data.state, "ready"); assert.equal(f.state.created, 1);
    assert.equal((await client.lifecycle(preview.operationRef)).data.state, "ready");
  } finally { release(); await second?.close(); await f.close(); }
});

test("legacy and background native adapters cannot inherit a manual operation's principal authority", async () => {
  const f = await lifecycleFixture(origin);
  try {
    f.state.failLoad = true; const { input } = await submit(f);
    const db = continuityWorkflowPrograms({ durableRoot: f.root, scopeId: L_SCOPE });
    const request = await Effect.runPromise(db.request(managedWorkflowId(L_INSTALL, "owner", input.requestId)));
    const signal = new AbortController().signal;
    const context: NativeContinuityContext = { boxRuntimeRoot: f.root, env: {}, signal, gateway: () => f.native.continuityAccess(signal), ownershipRead: f.native.ownershipRead };
    const before = f.state.calls.length;
    const legacy = createNativeBotLifecycle(context, { timeoutMs: 1000 });
    await assert.rejects(legacy.native.authorize(request, "load"));
    assert.equal(await createNativeBotHandover(context, L_SCOPE, 1000).port.authorize(request), false);
    const background = createNativeBotProtection(context, L_SCOPE, async () => continuityProtection({ enabled: true }));
    await assert.rejects(background.lifecycle.authorize(request, "load"));
    const result = await openBotLifecycle({ durableRoot: f.root, scopeId: L_SCOPE, native: legacy.native }).advance(request);
    assert.equal(result.blocked, true); assert.equal(f.state.calls.length, before); assert.equal(f.state.created, 1);
  } finally { await f.close(); }
});

test("service shutdown cancels bounded native work, joins its final record and never writes after close", async () => {
  const f = await lifecycleFixture(origin); let entered!: () => void;
  const reached = new Promise<void>(r => { entered = r; });
  try {
    const intent = lifecycleIntent(), preview = (await f.client().previewLifecycle(intent)).data;
    f.state.holdCreate = signal => new Promise<void>((_resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    const pending = f.client().submitLifecycle({ ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true }); void pending.catch(() => undefined);
    await reached; await f.server.close(); await pending.catch(() => undefined);
    const path = join(f.root, "continuity/state.sqlite"), bytes = await readFile(path); await delay(80); assert.deepEqual(await readFile(path), bytes); assert.equal(f.state.created, 0);
    f.state.holdCreate = undefined; await f.restart();
    const result = (await f.client().lifecycle(preview.operationRef)).data; assert.equal(result.effectsUnknown, true);
    await f.client().resumeLifecycle({ requestId: intent.requestId, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true }); assert.equal(f.state.created, 0);
  } finally { await f.close(); }
});

test("lost safety database remains unavailable and cannot grant a fresh create under an old request", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const { input, result } = await submit(f);
    await f.server.close(); await unlink(join(f.root, "continuity/state.sqlite")); await f.restart();
    await rejects(f.client().lifecycle(result.operationRef), "source_unavailable");
    await rejects(f.client().submitLifecycle(input), "source_unavailable");
    assert.equal(f.state.created, 1); await assert.rejects(lstat(join(f.root, "continuity/state.sqlite")), (e: any) => e.code === "ENOENT");
  } finally { await f.close(); }
});

test("removed handover syntax fails in the current parser without reaching a management-owned workflow", async () => {
  const f = await lifecycleFixture(origin);
  try {
    const { input } = await submit(f, lifecycleIntent("replace"));
    const id = managedWorkflowId(L_INSTALL, "owner", input.requestId), calls = f.state.calls.length;
    const path = join(f.root, "continuity/state.sqlite"), bytes = await readFile(path);
    for (const action of ["status", "advance", "observe", "attest", "retire"]) {
      const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, "agents", "handover", action, "--operation-id", id, "--scope-id", L_SCOPE,
        ...(action === "status" ? [] : ["--confirm"]), ...(action === "attest" ? ["--item-id", randomUUID()] : []), ...(["attest", "retire"].includes(action) ? ["--evidence-hash", "f".repeat(64)] : [])],
        { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
      let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
      const [code, signal] = await once(child, "close"); assert.equal(signal, null); assert.equal(code, 2, output); assert.ok(output.includes("invalid_usage")); assert.ok(!output.includes("PRIVATE_"));
      assert.deepEqual(await readFile(path), bytes);
    }
    assert.equal(f.state.calls.length, calls);
  } finally { await f.close(); }
});

test("packed CLI previews, submits and reads the same scoped lifecycle through the management endpoint", async () => {
  const f = await lifecycleFixture(origin);
  async function cli(args: string[]) {
    const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root,
      GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_LIFECYCLE_CREDENTIAL: L_OWNER }, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b); const [code] = await once(child, "close");
    assert.equal(code, 0, out + err); assert.ok(!out.includes("PRIVATE_")); return JSON.parse(out).data;
  }
  try {
    const requestId = randomUUID(), file = join(f.root, "input.json"); await writeFile(file, JSON.stringify({ requestId, name: "CLI clone", instructions: "PRIVATE_CLI_INSTRUCTIONS" }), { mode: 0o600 });
    const plan = await cli(["bot", "clone", L_SOURCE, "--input", `@${file}`, "--preview"]);
    const result = await cli(["bot", "clone", L_SOURCE, "--input", `@${file}`, "--scope-id", L_SCOPE, "--expect-plan", plan.planRevision, "--confirm"]);
    assert.equal(result.state, "ready");
    assert.deepEqual(await cli(["operation", "get", "--domain", "lifecycle", "--scope-id", L_SCOPE, "--request-id", requestId]), result);
    assert.equal((await cli(["operation", "list", "--domain", "lifecycle"])).operations.length, 1);
    assert.deepEqual(await cli(["operation", "resume", result.operationRef, "--domain", "lifecycle", "--expect-plan", plan.planRevision, "--confirm"]), result);
    assert.equal(f.state.created, 1);
  } finally { await f.close(); }
});

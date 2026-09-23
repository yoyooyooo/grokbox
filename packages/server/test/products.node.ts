import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DAEMON_METHODS, DAEMON_CAPABILITIES } from "../../cli/src/daemon/protocol.ts";
import { LEAF_COMMANDS } from "../../cli/src/registry.ts";
import { join } from "node:path";
import { ManagementClient, normalizeProductIntent, productReference, productIdentity, type ProductIntent } from "@grokbox/client";
import { assertProductReceipt } from "@grokbox/runtime-kernel/continuity";
import { openAgentDuplication } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { productFixture, productCommand, productRow, P_INSTALL, P_A, P_B, P_GROUP, P_SCOPE, P_OWNER, P_OTHER, P_READER } from "./product-fixture.node.ts";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error?.code === code);
async function reviewed(f: Awaited<ReturnType<typeof productFixture>>, intent = productCommand()) {
  const plan = (await f.client().previewProduct(intent)).data;
  return { plan, command: { ...intent, scopeId: plan.scopeId, expectedRevision: plan.revision, confirmed: true as const, acceptNonAtomic: true as const } };
}
async function submit(f: Awaited<ReturnType<typeof productFixture>>, intent = productCommand()) {
  const checked = await reviewed(f, intent);
  return { ...checked, result: (await f.client().submitProduct(checked.command)).data };
}

test("strict intent grammar separates one native write and installation-scoped Bot/Group references", () => {
  const intent = productCommand("members", "group");
  assert.deepEqual(normalizeProductIntent(intent), intent);
  for (const changed of [ { ...intent, unexpected: true }, { ...intent, memberIds: [] }, { ...intent, memberIds: [P_A, P_A] },
    { ...intent, kind: "bot" }, { ...intent, harness: "box" }, { ...intent, profile: { title: "hidden extra write" } },
    { ...productCommand("create"), deferStart: true, harness: "temporal" }, { ...productCommand("update"), harness: "temporal" } ]) assert.throws(() => normalizeProductIntent(changed));
  const ref = productReference("group", P_INSTALL, P_GROUP);
  assert.equal(productIdentity(ref, "group", P_INSTALL), P_GROUP);
  assert.throws(() => productIdentity(ref, "bot", P_INSTALL));
  assert.throws(() => productIdentity(ref, "group", randomUUID()));
});

test("preview and scoped roster/ownership reads never create a safety database or native effects", async () => {
  const f = await productFixture();
  try {
    const before = await readdir(f.root), { plan } = await reviewed(f);
    assert.equal(plan.nativeEffectsPerformed, false); assert.equal(plan.atomicCompareAndSet, false); assert.equal(plan.nativeIdempotency, "not-guaranteed");
    assert.equal(plan.scopeId, P_SCOPE); assert.equal(f.state.writes, 0);
    assert.deepEqual(await readdir(f.root), before);
    await assert.rejects(lstat(join(f.root, "continuity")), (e: any) => e.code === "ENOENT");
    const groups = (await f.client().products({ kind: "group", target: productReference("group", P_INSTALL, P_GROUP) })).data;
    assert.deepEqual(groups.objects[0]!.memberIds, [P_A]); assert.equal(groups.objects[0]!.ref, productReference("group", P_INSTALL, P_GROUP));
    const ownership = (await f.client().productOwnership(P_A)).data;
    assert.equal(ownership.agents[0]!.state, "confirmed_box"); assert.equal(ownership.executionQualified, false);
    assert.ok(!JSON.stringify(plan).includes(f.state.token));
  } finally { await f.close(); }
});

test("native creation is single-dispatch with exact identity receipt, historical replay and restart", async () => {
  const f = await productFixture();
  try {
    const { command, result } = await submit(f);
    assert.equal(result.state, "complete"); assert.equal(result.result?.nativeReceipt, "returned"); assert.equal(result.result?.readBack, "matched");
    assert.ok(result.result?.targetId); assert.equal(result.result?.object?.profile.name, command.profile!.name);
    const call = f.state.calls.find(c => c.method === "createAgent")!;
    assert.equal(call.input.clientNonce, result.operationId); assert.equal(call.input.isIntroductionSuppressed, true); assert.equal(call.input.isKickstartRequested, false);
    const count = f.state.calls.length; f.state.failNative = true;
    assert.deepEqual((await f.client().submitProduct(command)).data, result); assert.equal(f.state.calls.length, count);
    await f.restart(); assert.deepEqual((await f.client().productOperation(command)).data, result);
    await rejects(f.client(P_OTHER).productOperation(command), "not_found");
    assert.equal(f.state.writes, 1); assert.equal(f.state.cleanupCalls, 0);
  } finally { await f.close(); }
});

for (const [action, kind] of [["update", "bot"], ["hidden", "bot"], ["notify", "bot"], ["create", "group"],
  ["update", "group"], ["members", "group"], ["delete", "group"]] as const) test(`${kind}/${action} owns exactly one native write and an independent readback`, async () => {
  const f = await productFixture();
  try {
    const { result, command } = await submit(f, productCommand(action, kind));
    assert.equal(result.state, "complete"); assert.equal(result.result?.nativeReceipt, "returned"); assert.equal(result.result?.readBack, "matched");
    assert.equal(f.state.writes, 1); assert.equal(f.state.cleanupCalls, 0);
    await f.client().submitProduct(command); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("stale profile/membership revision and changed intent cannot overwrite an unreviewed snapshot", async () => {
  const f = await productFixture();
  try {
    const first = await reviewed(f, productCommand("members", "group"));
    f.state.rows.get(P_GROUP)!.title = "Concurrent native edit";
    await rejects(f.client().submitProduct(first.command), "revision_conflict"); assert.equal(f.state.writes, 0);
    const done = await submit(f, productCommand("update"));
    await rejects(f.client().submitProduct({ ...done.command, profile: { name: "Reused UUID with another intent" } }), "revision_conflict");
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("incomplete native profiles and nested Group membership fail before a write instead of inventing empty fields", async () => {
  const f = await productFixture();
  try {
    await rejects(f.client().previewProduct(productCommand("members", "group", { memberIds: [P_GROUP] })), "not_found");
    assert.throws(() => productCommand("members", "group", { memberIds: Array.from({ length: 7 }, () => randomUUID()) }));
    delete f.state.rows.get(P_A)!.description;
    await rejects(f.client().previewProduct(productCommand("update", "bot", { profile: { title: "Do not erase instructions" } })), "source_incomplete");
    assert.equal(f.state.writes, 0); await assert.rejects(lstat(join(f.root, "continuity")), (error: any) => error.code === "ENOENT");
  } finally { await f.close(); }
});

test("explicit Temporal creation and native profile normalization do not reassert harness on later updates", async () => {
  const f = await productFixture();
  try {
    const created = await submit(f, productCommand("create", "bot", { harness: "temporal", deferStart: false, profile: { name: "  Temporal test  ", description: "  instructions  " } }));
    const write = f.state.calls.find(row => row.method === "createAgent")!;
    assert.equal(write.input.harness, "temporal"); assert.equal(write.input.name, "Temporal test");
    assert.equal(created.result.result?.readBack, "matched"); assert.ok(created.plan.effects.includes("native-startup-may-run"));
    await submit(f, productCommand("update", "bot", { profile: { title: "  Trimmed user title  " } }));
    const update = f.state.calls.find(row => row.method === "updateAgent")!;
    assert.equal(update.input.profile.title, "Trimmed user title"); assert.equal(Object.hasOwn(update.input, "harness"), false); assert.equal(Object.hasOwn(update.input.profile, "harness"), false);
  } finally { await f.close(); }
});

for (const status of [401, 500]) test(`native duplicate HTTP ${status} cannot refresh/replay a mint or infer an identity`, async () => {
  const f = await productFixture();
  try {
    f.state.failAfterWrite = true; f.state.failWriteStatus = status;
    const { command, result } = await submit(f, productCommand("duplicate"));
    assert.equal(result.state, "effect_unknown"); assert.equal(result.result, null);
    await f.client().submitProduct(command);
    assert.equal(f.state.calls.filter(row => row.method === "duplicateAgent").length, 1); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("native member filtering is an observed mismatch, never fabricated CAS success", async () => {
  const f = await productFixture();
  try {
    f.state.filterMembers = true;
    const { result } = await submit(f, productCommand("members", "group"));
    assert.equal(result.result?.nativeReceipt, "returned"); assert.equal(result.result?.readBack, "mismatch");
    assert.deepEqual(result.result?.object?.memberIds, [P_A]); assert.equal(result.result?.atomicCompareAndSet, false);
  } finally { await f.close(); }
});

test("permissions cover native ownership, costly startup, routine copying and deletion independently", async () => {
  const f = await productFixture();
  try {
    await rejects(f.client(P_READER).previewProduct(productCommand("update")), "permission_denied");
    f.state.owner = false;
    assert.equal((await f.client().productOwnership(P_A)).data.agents[0]!.viewerIsOwner, false);
    await rejects(f.client().previewProduct(productCommand("update")), "permission_denied"); f.state.owner = true;
    f.revoke("lifecycle.start"); await rejects(f.client().previewProduct(productCommand("create", "bot", { deferStart: false })), "permission_denied");
    f.revoke("routines.write"); await rejects(f.client().previewProduct(productCommand("duplicate")), "permission_denied");
    f.revoke("products.delete"); await rejects(f.client().previewProduct(productCommand("delete")), "permission_denied");
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("unknown native birth never uses roster differences or replay to mint another identity", async () => {
  const f = await productFixture();
  try {
    f.state.failAfterWrite = true; const { command, result } = await submit(f);
    assert.equal(result.state, "effect_unknown"); assert.equal(result.result, null); assert.equal(f.state.rows.size, 4);
    await f.restart(); f.state.failAfterWrite = false;
    assert.deepEqual((await f.client().submitProduct(command)).data, result);
    assert.equal((await f.client().reconcileProduct(command)).data.state, "effect_unknown");
    const next = await reviewed(f); await rejects(f.client().submitProduct(next.command), "idempotency_conflict");
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("duplicate retains the original CONT identity receipt and does not claim a full clone or relationship transfer", async () => {
  const f = await productFixture();
  try {
    const { result, command, plan } = await submit(f, productCommand("duplicate"));
    assert.equal(result.state, "complete"); assert.ok(result.result?.targetId); assert.notEqual(result.result?.targetId, P_A);
    assert.equal(result.result?.fullClone, false); assert.equal(result.result?.relationshipsTransferred, false);
    const original = await openAgentDuplication({ durableRoot: f.root, scopeId: P_SCOPE }).operation(result.operationId);
    assert.equal(original.result?.targetAgentId, result.result?.targetId); assert.equal(original.request.planRevision, plan.duplicateRevision);
    f.state.failNative = true; await f.client().submitProduct(command); await f.client().reconcileProduct(command);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("unknown duplicate cannot be reconciled by its fresh roster appearance", async () => {
  const f = await productFixture();
  try {
    f.state.failAfterWrite = true; const { command, result } = await submit(f, productCommand("duplicate"));
    assert.equal(result.state, "effect_unknown"); assert.equal(result.result, null);
    f.state.failAfterWrite = false;
    assert.equal((await f.client().reconcileProduct(command)).data.state, "effect_unknown");
    await f.client().submitProduct(command); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("a lost management reply is recovered through the original scoped read, never an automatic POST retry", async () => {
  const f = await productFixture();
  try {
    const { command } = await reviewed(f); let posts = 0;
    const client = f.client(P_OWNER, (async (url, init) => {
      const reply = await fetch(url, init);
      if (init?.method === "POST") { posts++; await reply.arrayBuffer(); throw Error("synthetic-lost-management-reply"); }
      return reply;
    }) as typeof fetch);
    await rejects(client.submitProduct(command), "operation_unknown"); f.state.failNative = true;
    assert.equal((await f.client().productOperation(command)).data.state, "complete");
    assert.equal(posts, 1); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("independent Server instances share the original driver gate and identical requests dispatch only once", async () => {
  const f = await productFixture(); let second: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
  try {
    const { command } = await reviewed(f);
    second = await startManagementServer({ ...f.options, port: 0 }, { products: f.hooks });
    const client = new ManagementClient({ baseUrl: second.url, installationId: P_INSTALL, credential: async () => P_OWNER });
    f.state.holdWrite = async () => { entered(); await gate; };
    const pending = f.client().submitProduct(command); void pending.catch(() => undefined); await reached;
    const observed = (await client.submitProduct(command)).data; assert.equal(observed.state, "effect_unknown");
    assert.equal(f.state.calls.filter(c => c.method === "createAgent").length, 1);
    release(); assert.equal((await pending).data.state, "complete"); assert.equal(f.state.writes, 1);
  } finally { release(); await second?.close(); await f.close(); }
});

test("credential rotation invalidates a preview even when Gateway pid/address/start remain unchanged", async () => {
  const f = await productFixture();
  try {
    const { command, plan } = await reviewed(f);
    await f.rotateToken(); await rejects(f.client().submitProduct(command), "revision_conflict");
    assert.equal(f.state.writes, 0); assert.ok(!JSON.stringify(plan).includes("synthetic-product-native"));
    assert.equal((await submit(f)).result.state, "complete");
  } finally { await f.close(); }
});

test("rotation after durable admission records a local non-dispatch and does not select another native writer", async () => {
  const f = await productFixture();
  try {
    const { command } = await reviewed(f);
    f.state.afterCommit = async label => { if (label === "native-product-admit") await f.rotateToken(); };
    const result = (await f.client().submitProduct(command)).data;
    assert.equal(result.state, "complete"); assert.equal(result.result?.nativeReceipt, "not-dispatched"); assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("admission rollback permits no native effect; uncertain admission stays retained instead of being rebuilt", async () => {
  const f = await productFixture();
  try {
    const { command } = await reviewed(f);
    f.state.beforeCommit = async label => { if (label === "native-product-admit") throw Error("synthetic-admission-rollback"); };
    await rejects(f.client().submitProduct(command), "source_unavailable"); assert.equal(f.state.writes, 0);
    f.state.beforeCommit = undefined;
    f.state.afterCommit = async label => { if (label === "native-product-admit") throw Error("synthetic-admission-ack-loss"); };
    await rejects(f.client().submitProduct(command), "operation_unknown");
    f.state.afterCommit = undefined;
    assert.equal((await f.client().submitProduct(command)).data.state, "effect_unknown"); assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("native identity is durable before independent readback, which may be unavailable", async () => {
  const f = await productFixture();
  try {
    f.state.failReadBack = true; const { result, command } = await submit(f);
    assert.equal(result.state, "complete"); assert.ok(result.result?.targetId); assert.equal(result.result?.readBack, "not-observed");
    f.state.failNative = true; assert.deepEqual((await f.client().productOperation(command)).data, result);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

for (const mode of ["success", "cleanup-fails", "native-cleanup", "native-unknown"] as const) test(`Bot deletion ${mode} has one cleanup owner and never repeats cleanup on replay`, async () => {
  const f = await productFixture();
  try {
    f.state.failCleanup = mode === "cleanup-fails"; f.state.nativeCleanup = mode === "native-cleanup"; f.state.failAfterWrite = mode === "native-unknown";
    const { command, result } = await submit(f, productCommand("delete"));
    assert.equal(f.state.cleanupCalls, mode === "success" || mode === "cleanup-fails" ? 1 : 0);
    if (mode === "native-unknown") { assert.equal(result.state, "effect_unknown"); assert.equal(result.result, null); }
    else { assert.equal(result.result?.readBack, "matched"); assert.equal(result.result?.cleanup, mode === "cleanup-fails" ? "unknown" : "complete"); }
    await f.client().submitProduct(command); assert.equal(f.state.writes, 1);
    assert.equal(f.state.cleanupCalls, mode === "success" || mode === "cleanup-fails" ? 1 : 0);
  } finally { await f.close(); }
});

test("relationship facets disclose independent failures and bounded peer-field coverage", async () => {
  const f = await productFixture();
  try {
    f.state.transcript = [{ id: "native-message-1", requestId: randomUUID(), fromAgent: { id: P_B }, toAgent: { id: P_A } }];
    f.state.routines = [{ deliberately: "incompatible native routine" }];
    const data = (await f.client().productRelations(P_A)).data;
    assert.equal(data.scopeId, P_SCOPE); assert.deepEqual(data.groups[0]!.memberIds, [P_A]);
    assert.deepEqual(data.transcript.peerIds, [P_B]); assert.equal(data.transcript.inbound[0]!.fromBotId, P_B);
    assert.equal(data.transcript.complete, false); assert.equal(data.routines.state, "unavailable"); assert.equal(data.externalTasksEnumerated, false);
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("managed user titles preserve existing trailers, and incomplete effect disclosures fail protocol validation", async () => {
  const f = await productFixture();
  try {
    f.state.rows.get(P_A)!.title = "Original | owner=box,m=example";
    const intent = productCommand("update", "bot", { profile: { title: "New user label" } });
    const { plan, result } = await submit(f, intent);
    assert.equal(plan.profileAfter?.title, "New user label | owner=box,m=example");
    assert.equal(result.result?.readBack, "matched");
    assert.equal(result.result?.object?.profile.title, plan.profileAfter?.title);
    const altered = f.client(P_OWNER, (async (url, init) => {
      const reply = await fetch(url, init); const body = await reply.json() as { data: { effects: string[] } };
      if (String(url).endsWith("/v1/product-previews")) body.data.effects = [];
      return new Response(JSON.stringify(body), { status: reply.status, headers: reply.headers });
    }) as typeof fetch);
    await rejects(altered.previewProduct(productCommand("duplicate")), "protocol_error");
  } finally { await f.close(); }
});

test("retired product CLI and daemon contracts expose no second general writer or seat cleanup entry", () => {
  const leaves = LEAF_COMMANDS.map(leaf => leaf.path.join(" "));
  for (const command of ["agents create", "agents update", "agents delete", "agents duplicate", "groups create", "groups update", "groups delete", "groups members add", "groups members remove", "groups members set"]) assert.ok(!leaves.includes(command));
  for (const method of ["createAgent", "createGroup", "duplicateAgent", "updateAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar", "deleteAgent"]) assert.ok(!(DAEMON_METHODS as readonly string[]).includes(method));
  assert.ok(!(DAEMON_CAPABILITIES as readonly string[]).includes("grok.roster.write"));
  for (const name of ["bot create", "bot delete", "bot duplicate", "group members set", "product operation get"]) assert.equal(LEAF_COMMANDS.find(leaf => leaf.path.join(" ") === name)?.protocol, "management");
});

test("packed CLI previews, submits and reads the original native operation, while retired syntax fails before any native call", async () => {
  const f = await productFixture();
  async function cli(args: string[], expected = 0) {
    const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_PRODUCT_CREDENTIAL: P_OWNER },
      stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
    let out = "", err = ""; child.stdout.on("data", bytes => out += bytes); child.stderr.on("data", bytes => err += bytes);
    const [code, signal] = await once(child, "close"); assert.equal(signal, null, out + err); assert.equal(code, expected, out + err);
    assert.ok(!out.includes("synthetic-product-native")); return JSON.parse(out || err);
  }
  try {
    const requestId = randomUUID(), file = join(f.root, "product-input.json");
    await writeFile(file, JSON.stringify({ requestId, profile: { name: "Packed CLI Bot" }, harness: "box", deferStart: true }), { mode: 0o600 });
    const plan = (await cli(["bot", "create", "--input", `@${file}`, "--preview"])).data;
    const submitArgs = ["bot", "create", "--input", `@${file}`, "--scope-id", plan.scopeId, "--expect-revision", plan.revision, "--accept-non-atomic", "--confirm"];
    const result = (await cli(submitArgs)).data; assert.equal(result.state, "complete"); assert.equal(result.result.readBack, "matched");
    assert.deepEqual((await cli(["product", "operation", "get", requestId, "--scope-id", P_SCOPE])).data, result);
    const calls = f.state.calls.length;
    assert.deepEqual((await cli(submitArgs)).data, result); assert.equal(f.state.calls.length, calls);
    for (const args of [["agents", "create"], ["agents", "duplicate", P_A], ["agents", "delete", P_A, "--yes"], ["groups", "members", "set", P_GROUP, "--member", P_A]]) {
      const refused = await cli(args, 2); assert.equal(refused.error.code, "invalid_usage");
    }
    assert.equal(f.state.calls.length, calls); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test("product pagination binds kind, native generation, account scope and relevant mutable fields", async () => {
  const f = await productFixture();
  try {
    for (let n = 0; n < 8; n++) { const id = randomUUID(); f.state.rows.set(id, productRow(id)); }
    const first = (await f.client().products({ kind: "bot", limit: 1 })).data; assert.ok(first.nextCursor);
    await rejects(f.client().products({ kind: "group", limit: 1, cursor: first.nextCursor! }), "cursor_gap");
    f.state.rows.get(P_A)!.name = "Changed fields";
    await rejects(f.client().products({ kind: "bot", limit: 1, cursor: first.nextCursor! }), "cursor_gap");
  } finally { await f.close(); }
});


for (const [action, kind] of [["create", "bot"], ["update", "bot"], ["delete", "bot"], ["duplicate", "bot"], ["members", "group"]] as const) {
  test(`final native observation cannot carry ${kind}/${action} past revoked management permission`, async () => {
    const f = await productFixture();
    try {
      const { command } = await reviewed(f, productCommand(action, kind));
      let revoked = false;
      f.state.afterCommit = async label => {
        if (label !== "native-product-admit") return;
        const row = f.state.rows.get(P_A)!, title = row.title;
        Object.defineProperty(row, "title", { enumerable: true, configurable: true,
          get() { revoked = true; f.revoke("products.write"); return title; } });
      };
      const result = (await f.client().submitProduct(command)).data;
      assert.equal(revoked, true); assert.equal(f.state.writes, 0);
      assert.equal(result.state, "complete"); assert.equal(result.result?.nativeReceipt, "not-dispatched");
      assert.equal(result.result?.readBack, "not-observed"); assert.equal(f.state.cleanupCalls, 0);
    } finally { await f.close(); }
  });
}

test("account changes inside a native roster cannot produce a mixed-scope preview", async () => {
  const f = await productFixture();
  try {
    const row = f.state.rows.get(P_A)!, name = row.name;
    Object.defineProperty(row, "name", { enumerable: true, configurable: true,
      get() { f.state.scopeId = "f".repeat(64); return name; } });
    await rejects(f.client().previewProduct(productCommand()), "source_changed");
    assert.equal(f.state.writes, 0);
    await assert.rejects(lstat(join(f.root, "continuity")), (e: any) => e.code === "ENOENT");
  } finally { await f.close(); }
});

test("correlated native receipts refuse contradictory dispatch, target, readback and cleanup facts", async () => {
  const f = await productFixture();
  try {
    const { result } = await submit(f);
    for (const patch of [
      { nativeReceipt: "not-dispatched" }, { targetId: null, object: null },
      { readBack: "not-observed" }, { cleanup: "complete" }, { object: null },
    ]) assert.throws(() => assertProductReceipt({ ...result, result: { ...result.result!, ...patch } } as any));
    const updated = (await submit(f, productCommand("update"))).result;
    assert.throws(() => assertProductReceipt({ ...updated, result: { ...updated.result!, targetId: P_B, object: null, readBack: "not-observed" } }));
    const copied = (await submit(f, productCommand("duplicate"))).result;
    assert.throws(() => assertProductReceipt({ ...copied, result: { ...copied.result!, targetId: P_A, object: null, readBack: "not-observed" } }));
    const deleted = (await submit(f, productCommand("delete"))).result;
    assert.throws(() => assertProductReceipt({ ...deleted, result: { ...deleted.result!, object: updated.result!.object } }));
  } finally { await f.close(); }
});


test("managed native creation does not paint a title or hide a second profile write", async () => {
  const f = await productFixture();
  try {
    const { result } = await submit(f);
    assert.equal(result.result?.object?.profile.title, "");
    assert.equal(f.state.calls.filter(c => c.method === "updateAgent").length, 0);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

for (const trailer of ["owner=box,m=old", "owner=box,m=current,e=high", "owner=temporal,custom=value"]) {
  test(`reviewed user title preserves ${trailer} without silently performing title sync`, async () => {
    const f = await productFixture();
    try {
      f.state.rows.get(P_A)!.title = `Coding | ${trailer}`;
      const { result } = await submit(f, productCommand("update", "bot", { profile: { title: "New user title" } }));
      assert.equal(result.result?.object?.profile.title, `New user title | ${trailer}`);
      assert.equal(result.result?.readBack, "matched");
      assert.equal(f.state.calls.filter(c => c.method === "updateAgent").length, 1);
    } finally { await f.close(); }
  });
}

test("a scope change during relationship reads refuses the mixed account observation", async () => {
  const f = await productFixture();
  try {
    const incoming = { id: "synthetic-incoming", fromAgent: { id: P_B }, toAgent: { id: P_A } };
    Object.defineProperty(incoming, "requestId", { enumerable: true, get() { f.state.scopeId = "f".repeat(64); return "synthetic-request"; } });
    f.state.transcript = [incoming];
    await rejects(f.client().productRelations(P_A), "source_changed");
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});


test("expired native ownership refuses duplication through the current management entry", async () => {
  const f = await productFixture();
  try {
    f.state.ownershipAgeMs = 6000;
    await rejects(f.client().previewProduct(productCommand("duplicate")), "source_unavailable");
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.calls.filter(c => c.method === "duplicateAgent").length, 0);
  } finally { await f.close(); }
});


test("native null avatar defaults survive roster and profile update without invented writes", async () => {
  const f = await productFixture();
  try {
    f.state.rows.get(P_A)!.avatarShape = null; f.state.rows.get(P_A)!.avatarColor = null;
    const view = (await f.client().products({ kind: "bot", target: P_A })).data.objects[0]!;
    assert.equal(view.profile.avatarShape, null); assert.equal(view.profile.avatarColor, null);
    const { plan, result } = await submit(f, productCommand("update", "bot", { profile: { title: "Only user title" } }));
    assert.equal(Object.hasOwn(plan.profileAfter!, "avatarShape"), false);
    assert.equal(Object.hasOwn(plan.profileAfter!, "avatarColor"), false);
    const write = f.state.calls.find(c => c.method === "updateAgent")!;
    assert.equal(Object.hasOwn(write.input.profile, "avatarShape"), false);
    assert.equal(result.result?.readBack, "matched"); assert.equal(result.result?.object?.profile.avatarShape, null);
  } finally { await f.close(); }
});

test("null native avatar defaults still permit an explicit reviewed avatar change", async () => {
  const f = await productFixture();
  try {
    f.state.rows.get(P_A)!.avatarShape = null; f.state.rows.get(P_A)!.avatarColor = null;
    const { result } = await submit(f, productCommand("update", "bot", { profile: { avatarShape: "circle", avatarColor: "purple" } }));
    assert.equal(result.result?.readBack, "matched"); assert.equal(result.result?.object?.profile.avatarShape, "circle");
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

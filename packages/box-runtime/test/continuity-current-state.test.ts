import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure, initializationDigest, type CaptureCurrentRequest, type InitializeCurrentRequest,
  type NativeCurrentStatePort, type NativeMaterial } from "@grokbox/runtime-kernel/continuity";
import { openContinuityCurrentState, openContinuityRecoveryStore, type CurrentStateInput } from "../src/runtime.ts";
import type { ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";
import { ownedCurrentState, CURRENT_POLICY, CURRENT_SCOPE, TARGET_AGENT, type CurrentStateHooks } from "./fixtures/owned-current-state.ts";

async function fixture(nativeHooks: CurrentStateHooks = {}, storeHooks: ContinuityStoreHooks = {}) {
  const base = await mkdtemp(join(tmpdir(), "continuity-current-")), root = join(base, "durable");
  await mkdir(root, { mode: 0o700 });
  const native = await ownedCurrentState(join(base, "owned-native"), nativeHooks); await native.seed();
  const storeInput = { durableRoot: root, scopeId: CURRENT_SCOPE };
  const store = openContinuityRecoveryStore(storeInput); await store.initialize();
  const input: CurrentStateInput = { ...storeInput, native: native.native, authorizeInitialization: native.authorize };
  const controller = () => openContinuityCurrentState(input, storeHooks);
  const captureRequest = async (): Promise<CaptureCurrentRequest> => ({ requestId: randomUUID(), expected: (await native.source()).head });
  const prepared = async () => {
    const request = await captureRequest(), captured = await controller().capture(request);
    if (captured.state !== "stored") throw Error("fixture publication did not finish");
    return { capture: request, request: await native.request(captured.publication), reference: captured.publication };
  };
  return { base, root, native, input, store, controller, captureRequest, prepared, close: () => rm(base, { recursive: true, force: true }) };
}
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

// These tests run the production program/store/codec against a deliberately
// synthetic native boundary. They do not qualify the installed official Host.
test("missing native capability refuses without modifying or initializing the native source", async () => {
  const f = await fixture(); try {
    f.input.native = undefined;
    await expect(f.controller().capture(await f.captureRequest())).rejects.toThrow("native_unavailable");
    expect(f.native.calls).toEqual([]);
    expect(await f.store.status()).toMatchObject({ publications: [] });
  } finally { await f.close(); }
});

test("capture keeps exact immutable material and re-entry reads the saved version without recapturing", async () => {
  const f = await fixture(); try {
    const request = await f.captureRequest(), sourceBefore = await readFile(f.native.sourceFile);
    const result = await f.controller().capture(request);
    expect(result).toMatchObject({ state: "stored", sourceRead: true });
    const saved = await f.store.readSnapshot(request.requestId);
    expect(saved.manifest.source.contextRevision).toBe(request.expected.contextRevision);
    expect(saved.nativeImportProven).toBe(false);
    expect(await readFile(f.native.sourceFile)).toEqual(sourceBefore);
    f.native.calls.length = 0; f.input.native = undefined;
    expect(await f.controller().capture(request)).toMatchObject({ state: "stored", sourceRead: false });
    expect(f.native.calls).toEqual([]);
    await expect(f.controller().capture({ ...request, expected: { ...request.expected, contextRevision: sha256Text("other") } })).rejects.toThrow("material_invalid");
  } finally { await f.close(); }
});

test("capture does not repair an absent root, and rejects an unqualified Host before acquiring", async () => {
  const f = await fixture(); try {
    const request = await f.captureRequest();
    await expect(f.controller().capture({ ...request, expected: { ...request.expected, hostSourceSha: "c".repeat(64) } })).rejects.toThrow("qualification_mismatch");
    expect(f.native.calls).toEqual([]);
    const source = await f.native.source(); source.head.rootHash = null; await f.native.writeSource(source);
    await expect(f.controller().capture(await f.captureRequest())).rejects.toThrow("material_invalid");
    expect(f.native.calls).toEqual(["capture.acquire", "capture.release"]);
    expect((await f.native.source()).head.rootHash).toBeNull();
  } finally { await f.close(); }
});

test("a writer revision change during capture prevents publication even with the same root slot/content", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    hooks.afterSourceRead = async () => { const s = await f.native.source(); s.head.contextRevision = sha256Text("changed-checkpoint"); await f.native.writeSource(s); };
    await expect(f.controller().capture(await f.captureRequest())).rejects.toThrow("source_changed");
    expect(await f.store.status()).toMatchObject({ publications: [] });
    expect(f.native.calls.at(-1)).toBe("capture.release");
  } finally { await f.close(); }
});

test("caller-owned source buffers are copied before a subsequent native read can mutate them", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    let material: NativeMaterial | undefined; hooks.afterSourceRead = async m => { material = m; };
    hooks.beforeSourceHead = async () => { if (material) for (const bytes of material.content.values()) bytes.fill(0); };
    const request = await f.captureRequest(); await f.controller().capture(request);
    const saved = await f.store.readSnapshot(request.requestId);
    const text = [...saved.content.values()].map(x => new TextDecoder().decode(x)).join("|");
    expect(text).toContain("EARLY_FACT_SENTINEL"); expect(text).not.toContain("\u0000");
  } finally { await f.close(); }
});

test("capture passes finite budgets to the native reader and rejects a reader that exceeds the declared bound", async () => {
  const f = await fixture(); try {
    const original = f.native.native.capture; let seen: unknown;
    f.input.policy = { maxParts: 2 };
    const port: NativeCurrentStatePort = { ...f.native.native, capture: async expected => {
      const lease = await original(expected);
      return { ...lease, readMaterial: async limits => { seen = limits; return lease.readMaterial(limits); } };
    } };
    f.input.native = port;
    await expect(f.controller().capture(await f.captureRequest())).rejects.toThrow("material_invalid");
    expect(seen).toEqual({ maxParts: 2, maxPartBytes: 8 * 1024 * 1024, maxSnapshotBytes: 16 * 1024 * 1024 });
    expect(await f.store.status()).toMatchObject({ publications: [] });
  } finally { await f.close(); }
});

test("capture reports cleanup uncertainty and publishes no apparently complete snapshot", async () => {
  const f = await fixture({ onRelease: async () => { throw Error("PRIVATE_RELEASE_DETAIL"); } }); try {
    await expect(f.controller().capture(await f.captureRequest())).rejects.toThrow("cleanup_unknown");
    expect(await f.store.status()).toMatchObject({ publications: [] });
  } finally { await f.close(); }
});

test("initialization uses the held native writer, reopens before success, preserves target Memory and emits no input", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared(); f.native.calls.length = 0;
    const before = await f.native.target(), result = await f.controller().initialize(request);
    expect(result).toMatchObject({ state: "prepared", current: "verified_prepared", effectDispatched: true, activated: false, humanMessageSent: false });
    expect(f.native.calls).toEqual(["target.acquire", "target.prepare", "target.commit", "target.reopen", "target.release:prepared"]);
    const after = await f.native.target(); expect(after.memory).toBe(before.memory);
    expect(after.head.agentId).toBe(TARGET_AGENT); expect(after.head.state).toBe("prepared");
    const envelope = JSON.stringify(await f.native.envelope("NEXT_INPUT_SENTINEL"));
    expect(envelope).toContain("EARLY_FACT_SENTINEL"); expect(envelope).toContain("CONFIRMED_WORK_SENTINEL");
    expect(envelope).toContain("NEXT_INPUT_SENTINEL"); expect(envelope).toContain(`TARGET_SYSTEM:${TARGET_AGENT}`);
    expect(envelope).not.toContain("OLD_SYSTEM_IDENTITY");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "succeeded", kind: "initialize", inputDigest: initializationDigest(request), executionAuthorized: false });
  } finally { await f.close(); }
});

test("re-entry after subsequent B2 work neither reimports B0 nor reads an old source", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared(); await f.controller().initialize(request); await f.native.advance();
    const before = await readFile(f.native.targetFile); f.native.calls.length = 0; f.input.native = undefined;
    expect(await f.controller().initialize(request)).toMatchObject({ state: "already_applied", effectDispatched: false, current: "not_checked" });
    expect(await readFile(f.native.targetFile)).toEqual(before); expect(f.native.calls).toEqual([]);
    expect(JSON.stringify(await f.native.envelope("next"))).toContain("NEW_B2_WORK_SENTINEL");
  } finally { await f.close(); }
});

test("unconfirmed ownership, old evidence, absent permission and policy mismatch never dispatch", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared();
    for (const mode of ["missing", "ownership", "age", "future", "policy", "generation"]) {
      f.input.authorizeInitialization = mode === "missing" ? undefined : async r => ({ ...await f.native.authorize(r),
        ...(mode === "ownership" ? { ownership: "unconfirmed" as const } : {}),
        ...(mode === "age" ? { observedAtMs: Date.now() - 10_000 } : {}),
        ...(mode === "future" ? { observedAtMs: Date.now() + 10_000 } : {}),
        ...(mode === "policy" ? { policyRevision: "d".repeat(64) } : {}),
        ...(mode === "generation" ? { hostGeneration: "other" } : {}) });
      await expect(f.controller().initialize(request)).rejects.toThrow("continuity_current_");
    }
    expect(f.native.calls.filter(c => c.startsWith("target."))).toEqual([]);
    await expect(f.store.operation(request.operationId)).rejects.toThrow("not_found");
  } finally { await f.close(); }
});

test("policy recheck after durable claim cannot reuse earlier authority or grant another dispatch", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared(); let reads = 0;
    f.input.authorizeInitialization = async r => ({ ...await f.native.authorize(r), allowed: ++reads < 3 });
    await expect(f.controller().initialize(request)).rejects.toThrow("policy_changed");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
    expect(f.native.calls).not.toContain("target.commit");
    f.input.authorizeInitialization = f.native.authorize;
    expect(await f.controller().initialize(request)).toMatchObject({ state: "unknown", effectDispatched: false });
    expect(f.native.calls.filter(c => c === "target.commit")).toHaveLength(0);
  } finally { await f.close(); }
});

test("a slow native head read cannot extend original authority freshness at the final dispatch", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); let authReads = 0, headReads = 0;
    f.input.authorizeInitialization = async r => ({ ...await f.native.authorize(r), observedAtMs: Date.now() - (++authReads === 3 ? 4900 : 0) });
    hooks.beforeTargetHead = async () => { if (++headReads === 4) await new Promise(r => setTimeout(r, 150)); };
    await expect(f.controller().initialize(request)).rejects.toThrow("ownership_unconfirmed");
    expect(f.native.calls).not.toContain("target.commit");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
  } finally { await f.close(); }
});

test("active or unresolved target, different scope and changed target revision are not initialized", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared();
    for (const expected of [{ ...request.expected, state: "active" as const }, { ...request.expected, effects: "unresolved" as const },
      { ...request.expected, scopeId: "d".repeat(64) }]) await expect(f.controller().initialize({ ...request, expected })).rejects.toThrow("continuity_current_");
    expect(f.native.calls.filter(c => c.startsWith("target."))).toHaveLength(0);
    const state = await f.native.target(); state.head.contextRevision = sha256Text("new-current"); await f.native.writeTarget(state);
    await expect(f.controller().initialize(request)).rejects.toThrow("source_changed");
    expect(f.native.calls).not.toContain("target.commit");
  } finally { await f.close(); }
});

test("target state drift during candidate preparation cannot overwrite that changed state", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared();
    hooks.afterPrepare = async () => { const s = await f.native.target(); s.head.contextRevision = sha256Text("concurrent-native-change"); await f.native.writeTarget(s); };
    await expect(f.controller().initialize(request)).rejects.toThrow("source_changed");
    expect(f.native.calls).not.toContain("target.commit"); expect(f.native.calls.at(-1)).toBe("target.release:blocked");
  } finally { await f.close(); }
});

test("native write acknowledgement loss is unknown until an explicit readback, not another import", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.afterCommit = async () => { throw Error("PRIVATE_NATIVE_TRANSPORT_ERROR"); };
    await expect(f.controller().initialize(request)).rejects.toThrow("commit_unknown");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
    const persisted = await readFile(f.native.targetFile); f.native.calls.length = 0;
    const freshNative = await ownedCurrentState(f.native.directory); f.input.native = freshNative.native;
    expect(await f.controller().reconcile(request)).toMatchObject({ state: "reconciled", current: "at_imported_revision", effectDispatched: false, activated: false });
    expect(freshNative.calls).toEqual(["target.observe"]); expect(await readFile(f.native.targetFile)).toEqual(persisted);
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "succeeded" });
  } finally { await f.close(); }
});

test("unknown initial apply can reconcile after legitimate B2 progress without rolling it back", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.afterCommit = async () => { throw Error("lost ack"); };
    await expect(f.controller().initialize(request)).rejects.toThrow("commit_unknown");
    await f.native.advance(); const bytes = await readFile(f.native.targetFile);
    expect(await f.controller().reconcile(request)).toMatchObject({ state: "reconciled", current: "advanced", effectDispatched: false });
    expect(await readFile(f.native.targetFile)).toEqual(bytes);
  } finally { await f.close(); }
});

test("absence after dispatch uncertainty is not a non-execution certificate", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.beforeCommit = async () => { throw Error("unknown-before-write"); };
    await expect(f.controller().initialize(request)).rejects.toThrow("commit_unknown");
    hooks.beforeCommit = undefined;
    expect(await f.controller().reconcile(request)).toMatchObject({ state: "unknown", effectDispatched: false });
    expect(await f.controller().initialize(request)).toMatchObject({ state: "unknown", effectDispatched: false });
    expect(f.native.calls.filter(c => c === "target.commit")).toHaveLength(1);
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
  } finally { await f.close(); }
});

test("native reopen and marker readback must both agree before a successful apply receipt", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.afterReopen = head => ({ ...head, rootHash: "d".repeat(64) });
    await expect(f.controller().initialize(request)).rejects.toThrow("commit_unknown");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
    expect(f.native.calls.at(-1)).toBe("target.release:blocked");
  } finally { await f.close(); }
});

test("an application marker for another input cannot settle the operation", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.afterCommit = async () => { throw Error("lost"); };
    await expect(f.controller().initialize(request)).rejects.toThrow();
    hooks.application = o => o.state === "applied" ? { ...o, marker: { ...o.marker, inputDigest: "e".repeat(64) } } : o;
    await expect(f.controller().reconcile(request)).rejects.toThrow("commit_unknown");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
  } finally { await f.close(); }
});

test("cleanup failure after valid native readback does not settle the ledger or claim ready", async () => {
  const hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(); hooks.onRelease = async () => { throw Error("PRIVATE_CLOSE"); };
    await expect(f.controller().initialize(request)).rejects.toThrow("cleanup_unknown");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
  } finally { await f.close(); }
});

test("lost management settlement ack returns the originally applied operation without re-executing it", async () => {
  const hooks: ContinuityStoreHooks = {}, f = await fixture({}, hooks); try {
    const { request } = await f.prepared(); hooks.afterCommit = async label => { if (label === "settle-effect") throw Error("lost-ledger-ack"); };
    await expect(f.controller().initialize(request)).rejects.toThrow("continuity_commit_unknown");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "succeeded" });
    expect(await f.controller().initialize(request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(f.native.calls.filter(c => c === "target.commit")).toHaveLength(1);
  } finally { await f.close(); }
});

test("same operation with another target/input/effect is refused even after original success", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared(); await f.controller().initialize(request);
    for (const mutation of [{ ...request, effectId: randomUUID() }, { ...request, policyRevision: "e".repeat(64) },
      { ...request, expected: { ...request.expected, agentId: randomUUID() } }]) {
      await expect(f.controller().initialize(mutation)).rejects.toThrow("operation_conflict");
    }
    expect(f.native.calls.filter(c => c === "target.commit")).toHaveLength(1);
  } finally { await f.close(); }
});

test("cancellation joins the in-flight native write, retains unknown and does not release a writing lease", async () => {
  const entered = gate(), finish = gate(), hooks: CurrentStateHooks = {}, f = await fixture(hooks); try {
    const { request } = await f.prepared(), abort = new AbortController(); let finished = false;
    hooks.beforeCommit = async () => { entered.release(); await finish.promise; };
    const work = f.controller().initialize(request, abort.signal).catch(() => { finished = true; });
    await entered.promise; abort.abort(); await new Promise(r => setTimeout(r, 20));
    expect(finished).toBe(false); expect(f.native.calls.some(c => c.startsWith("target.release"))).toBe(false);
    finish.release(); await work;
    expect(f.native.calls.at(-1)).toBe("target.release:blocked");
    expect(await f.store.operation(request.operationId)).toMatchObject({ state: "effect_unknown" });
    const before = await readFile(f.native.targetFile); await new Promise(r => setTimeout(r, 15));
    expect(await readFile(f.native.targetFile)).toEqual(before);
    expect(await f.controller().reconcile(request)).toMatchObject({ state: "reconciled", effectDispatched: false });
  } finally { finish.release(); await f.close(); }
});

test("a pre-aborted invocation has no native or ledger effects", async () => {
  const f = await fixture(); try {
    const { request } = await f.prepared(), abort = new AbortController(); abort.abort(); f.native.calls.length = 0;
    await expect(f.controller().initialize(request, abort.signal)).rejects.toThrow("cancelled");
    expect(f.native.calls).toEqual([]); await expect(f.store.operation(request.operationId)).rejects.toThrow("not_found");
  } finally { await f.close(); }
});

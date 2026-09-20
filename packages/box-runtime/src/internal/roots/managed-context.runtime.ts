import { Effect } from "effect";
import { join } from "node:path";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { ContinuityFailure, CurrentStateFailure, initializationDigest, nativeCurrentHead, isContinuityHash,
  readBotSupplement, summaryFromSupplement, continuityId, assertCapturedHead, type InitializeCurrentRequest, type NativeCurrentHead, type CurrentStateRpcRequest } from "@grokbox/runtime-kernel/continuity";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { contextManagementPrograms, type ManagedContextRecord } from "../io/context-management.node.ts";
import { continuityStorePrograms } from "../io/continuity-store.node.ts";
import { continuityCurrentStatePrograms } from "./continuity-state.runtime.ts";
import { createCurrentStateClient } from "../io/current-state-client.node.ts";
import { acquireAdvisoryGate } from "../io/advisory-gate.node.ts";
import { assertSafeDirectory } from "../io/config-layout.node.ts";
import type { NativeContinuityContext } from "../io/continuity-gateway.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

const nativeIo = <A>(run: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: run,
  catch: e => e instanceof CurrentStateFailure || e instanceof ContinuityFailure ? e : new CurrentStateFailure("native_unavailable") }));
/** Native capability only: the production current-state port retains capture,
 * prepare, commit, reopen, application-marker and hold-release semantics. */
export function createNativeContextControl(context: NativeContinuityContext, expected?: NativeCurrentHead) {
  const gateway = context.gateway();
  const call = async (request: CurrentStateRpcRequest) => {
    context.signal?.throwIfAborted(); return (await gateway.currentStateControl(request, 60000)).result;
  };
  let client = expected ? createCurrentStateClient({ call, qualification: { hostSourceSha: expected.hostSourceSha, nativeSchema: expected.nativeSchema } }) : undefined;
  async function head(agentId: string) {
    if (client) return client.head(agentId);
    const raw = await call({ version: 1, action: "head", agentId }) as any;
    if (raw?.ok !== true || !isContinuityHash(raw.data?.policyRevision)) throw new CurrentStateFailure("native_unavailable");
    const value = nativeCurrentHead(raw.data.head);
    if (value.agentId !== agentId) throw new CurrentStateFailure("source_changed");
    client = createCurrentStateClient({ call, qualification: { hostSourceSha: value.hostSourceSha, nativeSchema: value.nativeSchema } });
    return { head: value, policyRevision: raw.data.policyRevision as string };
  }
  return { head, get client() { if (!client) throw new CurrentStateFailure("native_unavailable"); return client; },
    permission: async (asked: InitializeCurrentRequest) => {
      const now = await head(asked.expected.agentId), proof = await gateway.getAgentOwnership([asked.expected.agentId], 10000);
      const snapshot = proof.result as any;
      return { allowed: now.head.scopeId === asked.expected.scopeId && now.policyRevision === asked.policyRevision,
        operationId: asked.operationId, agentId: asked.expected.agentId, scopeId: now.head.scopeId, policyRevision: now.policyRevision,
        hostGeneration: now.head.hostGeneration, ownership: decideManagedOwnership({ agentId: asked.expected.agentId, snapshot, nowMs: Date.now() }).ok ? "confirmed_box" as const : "unconfirmed" as const,
        observedAtMs: Date.parse(snapshot?.serverObservedAt ?? "") };
    } };
}
export type ContextNative = ReturnType<typeof createNativeContextControl>;
export type ManagedContextInput = { root: string; record: ManagedContextRecord; native?: ContextNative;
  authorize: (capability: "context.write" | "context.activate") => Promise<void>; hooks?: ContinuityStoreHooks };

/** One staged Effect program over the original CONT owners. Only explicit
 * resume retries safe preparation/readback; ordinary submission replay never
 * drives. Unknown native application is reconciled, never applied a second time. */
export function managedContextPrograms(input: ManagedContextInput) {
  const r = input.record, d = r.declaration, owner = contextManagementPrograms(input.root, d.scopeId, input.hooks);
  const store = continuityStorePrograms({ durableRoot: input.root, scopeId: d.scopeId }, input.hooks);
  const native = () => { if (!input.native) throw new CurrentStateFailure("native_unavailable"); return input.native; };
  const authorize = (cap: "context.write" | "context.activate") => Effect.uninterruptible(Effect.tryPromise({ try: () => input.authorize(cap), catch: e => e }));
  const program = () => continuityCurrentStatePrograms({ durableRoot: input.root, scopeId: d.scopeId, native: native().client.port,
    authorizeInitialization: async asked => { await input.authorize("context.write"); return native().permission(asked); } }, input.hooks);
  const absent = <A>(effect: Effect.Effect<A, ContinuityFailure>) => effect.pipe(Effect.catch(e => e.code === "not_found" ? Effect.succeed(null) : Effect.fail(e)));
  const inspectPublication = (id: string) => Effect.gen(function* () {
    const result = yield* store.reconcilePublication(id, "verify");
    if (result.state !== "published") throw new CurrentStateFailure("commit_unknown");
    return yield* store.readSnapshot(id);
  });
  const checkRequest = (request: InitializeCurrentRequest) => {
    if (request.operationId !== r.operationId || request.effectId !== continuityId(r.operationId, "apply") || canonicalJson(request.expected) !== canonicalJson(r.expected)
      || request.policyRevision !== r.policyRevision || request.snapshot.ref !== (d.action === "initialize" ? d.snapshotId : r.candidateId)
      || (d.action === "initialize" ? request.mode !== undefined : request.mode !== (d.action === "restore" ? "recover" : "reset") || request.backupSnapshot?.ref !== r.backupId))
      throw new CurrentStateFailure("operation_conflict");
    return request;
  };
  const checkpoint = (id: string) => Effect.gen(function* () {
    yield* authorize("context.write");
    const previous = yield* absent(store.publication(id));
    if (!previous) yield* program().capture({ requestId: id, expected: r.expected });
    const value = previous ? yield* inspectPublication(id) : yield* store.readSnapshot(id);
    assertCapturedHead(value, r.expected);
    return value;
  });
  const drive = () => Effect.gen(function* () {
    yield* authorize("context.write");
    if ((yield* owner.read(r.operationId))?.cancelled) throw new ContinuityFailure("conflict");
    yield* owner.phase(r.operationId, "effect_unknown");
    if (d.action === "capture") {
      yield* checkpoint(r.captureId);
      return yield* owner.phase(r.operationId, "complete");
    }
    let request = yield* absent(store.initializationRequest(r.operationId));
    if (!request) {
      const current = yield* nativeIo(() => native().head(d.agentId));
      if (canonicalJson(current.head) !== canonicalJson(r.expected) || current.policyRevision !== r.policyRevision) throw new CurrentStateFailure("source_changed");
      if (d.action === "initialize") {
        const snapshot = yield* store.readSnapshot(d.snapshotId!);
        request = { operationId: r.operationId, effectId: continuityId(r.operationId, "apply"),
          expected: r.expected, policyRevision: r.policyRevision, snapshot: snapshot.reference };
      } else {
        const backup = yield* checkpoint(r.backupId);
        let candidate = yield* absent(store.publication(r.candidateId));
        if (!candidate) {
          yield* authorize("context.write");
          const source = d.action === "restore" ? yield* store.readSnapshot(d.snapshotId!) : null;
          const supplement = source ? readBotSupplement(source) : null;
          const material = d.action === "reset" || source?.manifest.gaps.includes("unknown_effects")
            ? yield* nativeIo(() => native().client.compose(r.expected, { version: 1, purpose: d.action === "restore" ? "recover" : "reset",
              sourceId: d.agentId, sourceRevision: r.expected.contextRevision, instructions: "", summary: supplement ? summaryFromSupplement({ ...supplement, sourceId: d.agentId }) : "" }))
            : source;
          if (!material) throw new CurrentStateFailure("material_invalid");
          yield* store.publish({ requestId: r.candidateId, manifest: material.manifest, content: material.content });
        }
        const saved = yield* inspectPublication(r.candidateId);
        request = { operationId: r.operationId, effectId: continuityId(r.operationId, "apply"), expected: r.expected, policyRevision: r.policyRevision,
          snapshot: saved.reference, mode: d.action === "restore" ? "recover" : "reset", backupSnapshot: backup.reference };
      }
    }
    yield* authorize("context.write");
    const applied = yield* program().initialize(checkRequest(request));
    if (!["prepared", "already_applied", "reconciled"].includes(applied.state)) throw new CurrentStateFailure("commit_unknown");
    return yield* owner.phase(r.operationId, "complete");
  });
  const reconcile = () => Effect.gen(function* () {
    yield* authorize("context.write");
    if ((yield* owner.read(r.operationId))?.cancelled) return yield* owner.read(r.operationId);
    if (d.action === "capture") { assertCapturedHead(yield* inspectPublication(r.captureId), r.expected); return yield* owner.phase(r.operationId, "complete"); }
    const request = yield* absent(store.initializationRequest(r.operationId));
    if (!request) return yield* owner.read(r.operationId); // Readback never composes or applies missing work.
    checkRequest(request);
    if ((yield* store.operation(r.operationId)).state === "succeeded") return yield* owner.phase(r.operationId, "complete");
    const observed = yield* program().reconcile(request);
    return ["already_applied", "reconciled"].includes(observed.state) ? yield* owner.phase(r.operationId, "complete") : yield* owner.read(r.operationId);
  });
  const activate = (expectedRevision: string) => Effect.gen(function* () {
    yield* authorize("context.activate");
    const row = yield* owner.read(r.operationId);
    if (!row || row.cancelled || d.action === "capture") throw new ContinuityFailure("conflict");
    if (row.activation?.expectedRevision && row.activation.expectedRevision !== expectedRevision) throw new ContinuityFailure("conflict");
    if (row.activation?.state === "complete") return row;
    const request = checkRequest(yield* store.initializationRequest(r.operationId)), operation = yield* store.operation(r.operationId);
    if (operation.state !== "succeeded") throw new CurrentStateFailure("not_prepared");
    const current = yield* nativeIo(() => native().head(d.agentId));
    if (!row.activation && current.head.contextRevision !== expectedRevision) throw new CurrentStateFailure("source_changed");
    if (current.head.scopeId !== d.scopeId || current.policyRevision !== request.policyRevision) throw new CurrentStateFailure("policy_changed");
    yield* owner.activation(r.operationId, expectedRevision);
    yield* owner.activationPhase(r.operationId, "effect_unknown");
    yield* authorize("context.activate");
    // This original native primitive binds the immutable application marker.
    // Re-entry either proves its prior release or releases only its prepared
    // hold; it cannot reopen a later hold or reapply an old context after B2.
    const result = yield* nativeIo(() => native().client.activate({ ...request, inputDigest: initializationDigest(request) }, current.head));
    if (result?.state !== "released" || result.started !== false) throw new CurrentStateFailure("commit_unknown");
    return yield* owner.activationPhase(r.operationId, "complete");
  });
  const cancel = () => Effect.gen(function* () { yield* authorize("context.write"); return yield* owner.cancel(r.operationId); });
  return { drive, reconcile, activate, cancel };
}
export async function withManagedContextGate<A>(root: string, run: () => Promise<A>, signal: AbortSignal): Promise<A | null> {
  signal.throwIfAborted(); await assertSafeDirectory(root); await assertSafeDirectory(join(root, "state"), true);
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.uninterruptible(Effect.tryPromise({ try: () => acquireAdvisoryGate(join(root, "state", "manual-context.gate")), catch: e => e })),
    gate => gate ? Effect.uninterruptible(Effect.tryPromise({ try: run, catch: e => e })) : Effect.succeed(null),
    gate => gate ? Effect.promise(gate.release) : Effect.void), { signal });
}

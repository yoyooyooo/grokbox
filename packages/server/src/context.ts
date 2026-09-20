import { Effect } from "effect";
import { botIdFromRef, botRef, normalizeContextChange, normalizeContextContinuation, contextOperationRef, protectionReference,
  protectionReferenceIdentity, UUID, ManagementClientError, type ContextView, type ContextOperation, type Capability } from "@grokbox/client/contract";
import { ContinuityFailure, CurrentStateFailure } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { contextManagementPrograms, contextControlId, managedContextRecord, contextStorePresent, createNativeContextControl,
  managedContextPrograms, withManagedContextGate, openContinuityRecoveryStore, type ManagedContextDeclaration, type ManagedContextRow,
  type NativeContinuityContext } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type ContextDomain = { root: string; installationId: string; context?: (signal: AbortSignal) => NativeContinuityContext;
  authorize: (signal: AbortSignal, capability: Capability) => Promise<void>; hooks?: Parameters<typeof contextManagementPrograms>[2] };
const invalid = () => new HttpFailure(400, "invalid_input", "Use the original context request and exact Bot, account scope and revision.");
const missing = () => new HttpFailure(404, "not_found", "No context operation exists for this installation, principal and original request.");
function failure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof CurrentStateFailure || error instanceof ContinuityFailure) {
    if (["commit_unknown", "cleanup_unknown"].includes(error.code)) return new HttpFailure(409, "operation_unknown", "Inspect and reconcile the original context operation. No unknown native application has been repeated.");
    if (["scope_mismatch", "source_changed", "qualification_mismatch"].includes(error.code)) return new HttpFailure(409, "source_changed", "The context source or scope differs from the original operation; it has not been substituted.");
    if (["conflict", "operation_conflict", "policy_changed", "not_prepared"].includes(error.code)) return new HttpFailure(409, "revision_conflict", "The original context, policy or operation is not eligible for this change.");
    if (error.code === "not_found") return missing();
    if (error.code === "capacity") return new HttpFailure(507, "store_full", "The CONT owner cannot admit more protected data; unresolved history has not been removed.");
  }
  return new HttpFailure(503, "source_unavailable", "The qualified current-state capability or original CONT store is unavailable. No source was recreated or replaced.");
}
const io = <A>(read: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: read, catch: failure });
function owned<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.scoped(Effect.gen(function* () {
    const work = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const promise = run(signal); void promise.catch(() => undefined); return { controller, promise };
    }), value => Effect.promise(async () => { value.controller.abort(); await value.promise.catch(() => undefined); }));
    return yield* io(() => work.promise);
  }));
}
async function getRow(d: ContextDomain, p: Principal, scopeId: string, requestId: string) {
  if (!/^[a-f0-9]{64}$/.test(scopeId) || !UUID.test(requestId)) throw invalid();
  if (!await contextStorePresent(d.root, scopeId)) return null;
  const row = await Effect.runPromise(contextManagementPrograms(d.root, scopeId).read(contextControlId(d.installationId, p.id, requestId)));
  if (row && (row.record.declaration.installationId !== d.installationId || row.record.declaration.principalId !== p.id || row.record.declaration.requestId !== requestId)) throw missing();
  return row;
}
async function project(d: ContextDomain, row: ManagedContextRow): Promise<ContextOperation> {
  const r = row.record, q = r.declaration, store = openContinuityRecoveryStore({ durableRoot: d.root, scopeId: q.scopeId });
  const publication = async (id: string | null) => {
    if (!id) return null;
    try { const value = await store.publication(id); return ["published", "retired"].includes(value.state) ? protectionReference("snapshot", d.installationId, q.scopeId, id) : null; }
    catch (e) { if (e instanceof ContinuityFailure && e.code === "not_found") return null; throw e; }
  };
  let application: ContextOperation["application"] = "not-recorded";
  if (q.action !== "capture") {
    try {
      const op = await store.operation(r.operationId);
      if (op.agentId !== q.agentId || op.kind !== "initialize") throw new ContinuityFailure("integrity_failure");
      if (!['prepared', 'effect_unknown', 'succeeded', 'not_executed'].includes(op.state)) throw new ContinuityFailure("integrity_failure");
      application = op.state === "effect_unknown" ? "effect-unknown" : op.state === "not_executed" ? "not-executed" : op.state as "prepared" | "succeeded";
    } catch (e) { if (!(e instanceof ContinuityFailure && e.code === "not_found")) throw e; }
  }
  const captureRef = q.action === "capture" ? await publication(r.captureId) : null;
  const backupRef = ["reset", "restore"].includes(q.action) ? await publication(r.backupId) : null;
  const candidateRef = q.action === "initialize" ? await publication(q.snapshotId) : ["reset", "restore"].includes(q.action) ? await publication(r.candidateId) : null;
  const activation = row.activation?.state === "complete" ? "released" : row.activation?.state === "effect_unknown" ? "unknown" : row.activation?.state ?? "not-requested";
  const state = row.cancelled ? "cancelled" : activation === "released" ? "released" : activation === "unknown" ? "unknown" : row.state === "complete"
    ? q.action === "capture" ? captureRef ? "captured" : "unknown" : application === "succeeded" ? "prepared" : "unknown"
    : row.state === "prepared" ? "admitted" : "unknown";
  return { requestId: q.requestId, operationRef: contextOperationRef(d.installationId, q.scopeId, q.requestId), botRef: botRef(d.installationId, q.agentId),
    scopeId: q.scopeId, action: q.action, expectedRevision: q.expectedRevision, state, captureRef, backupRef, candidateRef, application, activation,
    activationExpectedRevision: row.activation?.expectedRevision ?? null, createdAtMs: row.createdAtMs, sourceBodyIncluded: false, startedTask: false, currentTargetUsability: "not-observed" };
}
export function contextApplication(d: ContextDomain, p: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const continuation = method === "POST" && url.pathname === "/v1/context-continuations";
    const capability = method === "GET" ? url.pathname.startsWith("/v1/context-operations/") ? "operations.read" : "context.read"
      : continuation && (input as any)?.action === "activate" ? "context.activate" : "context.write";
    yield* Effect.try({ try: () => { if (url.search) throw invalid(); requireCapability(p, capability); }, catch: failure });
    const head = /^\/v1\/contexts\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && head) return yield* io(async signal => {
      const id = botIdFromRef(decodeURIComponent(head[1]!), d.installationId);
      if (!d.context) throw new CurrentStateFailure("native_unavailable");
      const { head: value, policyRevision } = await createNativeContextControl(d.context(signal)).head(id);
      return { botRef: botRef(d.installationId, id), scopeId: value.scopeId, revision: value.contextRevision, policyRevision, hostSourceSha: value.hostSourceSha,
        nativeSchema: value.nativeSchema, hostGeneration: value.hostGeneration, state: value.state, effects: value.effects,
        hasCheckpoint: value.rootHash !== null, observedAtMs: Date.now(), contentIncluded: false, currentOwnershipProven: false } satisfies ContextView;
    });
    const lookup = /^\/v1\/context-operations\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "GET" && lookup) return yield* io(async () => { const row = await getRow(d, p, lookup[1]!, lookup[2]!); if (!row) throw missing(); return project(d, row); });
    if (method === "POST" && (url.pathname === "/v1/context-changes" || continuation)) {
      const command = yield* Effect.try({ try: () => continuation ? normalizeContextContinuation(input, d.installationId) : normalizeContextChange(input, d.installationId), catch: failure });
      return yield* owned(async signal => {
        const agentId = botIdFromRef(command.botRef, d.installationId), requestId = command.requestId;
        const declaration: ManagedContextDeclaration | null = continuation ? null : { installationId: d.installationId, principalId: p.id, requestId,
          agentId, scopeId: command.scopeId, action: command.action as ManagedContextDeclaration["action"], expectedRevision: "expectedRevision" in command ? command.expectedRevision : "",
          snapshotId: "snapshotRef" in command ? protectionReferenceIdentity(command.snapshotRef, d.installationId, "snapshot").id : null };
        const verify = (row: ManagedContextRow) => {
          if (row.record.declaration.agentId !== agentId || declaration && canonicalJson(row.record.declaration) !== canonicalJson(declaration))
            throw new HttpFailure(409, "idempotency_conflict", "This context request belongs to another immutable action, target, revision or material.");
          if (command.action === "activate" && row.activation && row.activation.expectedRevision !== command.expectedRevision)
            throw new HttpFailure(409, "idempotency_conflict", "This original activation is already bound to its first reviewed revision.");
        };
        const existing = await getRow(d, p, command.scopeId, requestId);
        if (existing) { verify(existing); if (!continuation || existing.cancelled || command.action === "activate" && existing.activation?.state === "complete") return project(d, existing); }
        else if (continuation) throw missing();
        await d.authorize(signal, capability);
        const result = await withManagedContextGate(d.root, async () => {
          let row = await getRow(d, p, command.scopeId, requestId);
          if (row) { verify(row); if (!continuation || row.cancelled) return project(d, row); }
          if (!row) {
            if (!d.context) throw new CurrentStateFailure("native_unavailable");
            const native = createNativeContextControl(d.context(signal)), initial = await native.head(agentId);
            if (initial.head.scopeId !== command.scopeId || initial.head.contextRevision !== declaration!.expectedRevision) throw new CurrentStateFailure("source_changed");
            if (declaration!.action !== "capture" && (!['empty', 'prepared'].includes(initial.head.state) || initial.head.effects !== "clear")) throw new CurrentStateFailure("not_prepared");
            if (["capture", "reset", "restore"].includes(declaration!.action) && initial.head.rootHash === null) throw new CurrentStateFailure("not_prepared");
            // Reject an absent/corrupt requested source before reserving a
            // target. A typo is not an uncertain native effect or a permanent lock.
            if (declaration!.snapshotId) await openContinuityRecoveryStore({ durableRoot: d.root, scopeId: command.scopeId }).readSnapshot(declaration!.snapshotId!);
            const record = managedContextRecord(declaration!, initial.head, initial.policyRevision), owner = contextManagementPrograms(d.root, command.scopeId, d.hooks);
            await d.authorize(signal, capability); signal.throwIfAborted();
            await Effect.runPromise(owner.initialize()); row = await Effect.runPromise(owner.reserve(record));
          }
          const record = row.record;
          const native = d.context ? createNativeContextControl(d.context(signal), record.expected) : undefined;
          const programs = managedContextPrograms({ root: d.root, record, native, hooks: d.hooks, authorize: cap => d.authorize(signal, cap) });
          try {
            await Effect.runPromise(command.action === "activate" ? programs.activate(command.expectedRevision) : command.action === "reconcile" ? programs.reconcile() : command.action === "cancel" ? programs.cancel() : programs.drive(), { signal });
          } catch (error) {
            // Once a durable dispatch boundary was entered, a missing reply is
            // an original-operation recovery problem, not a new-write invitation.
            const retained = await getRow(d, p, command.scopeId, requestId).catch(() => null);
            if (retained?.state === "effect_unknown" || retained?.activation?.state === "effect_unknown") return project(d, retained);
            throw error;
          }
          const after = await getRow(d, p, command.scopeId, requestId); if (!after) throw missing(); return project(d, after);
        }, signal);
        if (result) return result;
        const running = await getRow(d, p, command.scopeId, requestId);
        if (running) { verify(running); return project(d, running); }
        throw new HttpFailure(503, "unavailable", "Another context driver is active; this request has not been admitted. Inspect the original request before resubmitting.");
      });
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "This current-state management endpoint is not supported."));
  });
}

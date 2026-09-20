import { Effect } from "effect";
import { botRef, botIdFromRef, UUID, normalizeLifecycleIntent, normalizeLifecycleSubmission, normalizeLifecycleResume,
  lifecycleReference, protectionReferenceIdentity, protectionReference, LIFECYCLE_PHASES, LIFECYCLE_STEPS,
  ManagementClientError, type LifecycleIntent, type LifecyclePreview, type LifecycleOperation, type LifecycleList, type Capability } from "@grokbox/client/contract";
import { botWorkflowRequest, botWorkflowDigest, botProfile, continuityId, ContinuityFailure, CurrentStateFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { createNativeBotLifecycle, createNativeBotHandover, openBotLifecycle, readManagedLifecycle, listManagedLifecycles,
  withManagedLifecycleGate, botProfileRevision, type NativeContinuityContext } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type LifecycleDomain = {
  root: string; installationId: string; context?: (signal: AbortSignal) => NativeContinuityContext;
  authorize: (signal: AbortSignal, capability: Capability) => Promise<void>;
  create?: typeof createNativeBotLifecycle;
};
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const invalid = () => new HttpFailure(400, "invalid_input", "Use the exact original lifecycle scope, request and reviewed plan.");
const missing = () => new HttpFailure(404, "not_found", "No lifecycle operation is recorded for this installation, principal, scope and request.");
function failure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof CurrentStateFailure || error instanceof ContinuityFailure) {
    if (["scope_mismatch", "source_changed", "qualification_mismatch"].includes(error.code)) return new HttpFailure(409, "source_changed", "The original lifecycle source or scope changed; no replacement identity was inferred.");
    if (["conflict", "policy_changed"].includes(error.code)) return new HttpFailure(409, "revision_conflict", "The lifecycle source, policy or saved plan changed. Preserve the original operation before reviewing another action.");
    if (["commit_unknown", "cleanup_unknown"].includes(error.code)) return new HttpFailure(409, "operation_unknown", "Read the original lifecycle operation; an uncertain native effect has not been retried.");
    if (error.code === "capacity") return new HttpFailure(507, "store_full", "The lifecycle owner cannot admit more work without discarding protected history.");
    if (error.code === "not_found") return missing();
  }
  return new HttpFailure(503, "source_unavailable", "The native lifecycle capability or original recovery store is unavailable; no alternate writer was selected.");
}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
/** An admitted command outlives the HTTP connection, but not its Server Scope.
 * Abort the actual native transport and join durable settlement at shutdown. */
function owned<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.scoped(Effect.gen(function* () {
    const task = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const promise = run(signal); void promise.catch(() => undefined);
      return { controller, promise };
    }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
    return yield* io(() => task.promise);
  }));
}
export const managedWorkflowId = (installationId: string, principalId: string, requestId: string) => continuityId(installationId, canonicalJson(["manual-lifecycle-v1", principalId, requestId]));
function principalOwns(d: LifecycleDomain, p: Principal, request: BotWorkflowRequest, requestId: string) {
  const m = request.management;
  return m?.installationId === d.installationId && m.principalId === p.id && m.requestId === requestId
    && request.operationId === managedWorkflowId(d.installationId, p.id, requestId);
}
async function saved(d: LifecycleDomain, p: Principal, scopeId: string, requestId: string) {
  if (!hash(scopeId) || !UUID.test(requestId)) throw invalid();
  const item = await readManagedLifecycle(d.root, scopeId, managedWorkflowId(d.installationId, p.id, requestId));
  if (item && !principalOwns(d, p, item.request, requestId)) throw missing();
  return item;
}
function projection(d: LifecycleDomain, item: NonNullable<Awaited<ReturnType<typeof readManagedLifecycle>>>): LifecycleOperation {
  const { request: r, receipt } = item, m = r.management!;
  if (!LIFECYCLE_PHASES.includes(receipt.phase as never) || !Number.isSafeInteger(receipt.createdAtMs) || receipt.createdAtMs < 1
    || receipt.updatedAtMs < receipt.createdAtMs) throw new ContinuityFailure("integrity_failure");
  const steps = receipt.steps.map(s => {
    if (!LIFECYCLE_STEPS.includes(s.step as never) || !["effect_unknown", "complete"].includes(s.state)) throw new ContinuityFailure("integrity_failure");
    return { step: s.step as LifecycleOperation["steps"][number]["step"], state: s.state as "effect_unknown" | "complete" };
  });
  return { requestId: m.requestId, operationRef: lifecycleReference(d.installationId, r.scopeId, m.requestId), scopeId: r.scopeId, planRevision: botWorkflowDigest(r), kind: r.kind,
    sourceBotRef: r.sourceId ? botRef(d.installationId, r.sourceId) : null, targetBotRef: receipt.targetId ? botRef(d.installationId, receipt.targetId) : null,
    state: receipt.phase as LifecycleOperation["state"], steps, effectsUnknown: steps.some(s => s.state === "effect_unknown"),
    createdAtMs: receipt.createdAtMs, updatedAtMs: receipt.updatedAtMs, requestedActivation: r.activate, requestedStartup: r.start,
    handoverRef: r.kind === "replace" && steps.some(s => s.step === "handover") ? protectionReference("handover", d.installationId, r.scopeId, r.operationId) : null,
    currentTargetUsability: "not-observed", sourceRetirement: "not-observed", privateInputsIncluded: false };
}
function complete(item: NonNullable<Awaited<ReturnType<typeof readManagedLifecycle>>>) {
  const r = item.request, last = r.kind === "replace" && r.activate ? "handover" : r.start ? "startup" : r.activate ? "activate" : "initialize";
  return item.receipt.phase === "retired" || item.receipt.steps.some(step => step.step === last && step.state === "complete");
}
async function lookup(d: LifecycleDomain, p: Principal, scopeId: string, requestId: string) {
  const item = await saved(d, p, scopeId, requestId); if (!item) throw missing();
  return projection(d, item);
}
async function authorizeIntent(d: LifecycleDomain, p: Principal, r: Pick<LifecycleIntent, "start" | "allowHandoverMessages">, signal: AbortSignal) {
  const capabilities: Capability[] = ["lifecycle.write", ...(r.start ? ["lifecycle.start" as const] : []), ...(r.allowHandoverMessages ? ["lifecycle.messages" as const] : [])];
  for (const capability of capabilities) { requireCapability(p, capability); await d.authorize(signal, capability); }
  signal.throwIfAborted();
}
function adapter(d: LifecycleDomain, p: Principal, signal: AbortSignal) {
  if (!d.context) throw new HttpFailure(503, "source_unavailable", "No qualified native lifecycle adapter is connected.");
  const context = d.context(signal);
  const authorizePolicy = async (request: BotWorkflowRequest) => {
    if (!principalOwns(d, p, request, request.management?.requestId ?? "")) return false;
    await authorizeIntent(d, p, { start: request.start, allowHandoverMessages: request.handover?.allowUserMessages === true }, signal);
    return true;
  };
  // Keep native capability/scope/policy checks as well as fresh management
  // authorization. A new transport permission cannot overrule the native plan.
  return (d.create ?? createNativeBotLifecycle)(context, { timeoutMs: 180000, authorizeManagement: authorizePolicy,
    handover: request => createNativeBotHandover(context, request.scopeId, 30000, authorizePolicy).program.advance(request.operationId, 16, signal) });
}
async function plan(d: LifecycleDomain, p: Principal, intent: LifecycleIntent, native: ReturnType<typeof createNativeBotLifecycle>): Promise<BotWorkflowRequest> {
  const operationId = managedWorkflowId(d.installationId, p.id, intent.requestId), sourceId = intent.sourceBotRef ? botIdFromRef(intent.sourceBotRef, d.installationId) : null;
  const caps = await native.capabilities(sourceId ?? operationId);
  const original = sourceId ? await native.profile(sourceId) : null;
  const model = await native.selected(sourceId, intent.modelId, intent.effort);
  let snapshotId: string | null = null;
  if (intent.snapshotRef) {
    const ref = protectionReferenceIdentity(intent.snapshotRef, d.installationId, "snapshot");
    if (ref.scopeId !== caps.scopeId) throw new CurrentStateFailure("source_changed");
    snapshotId = ref.id;
  }
  return botWorkflowRequest({ version: 1, operationId, scopeId: caps.scopeId, kind: intent.kind, sourceId,
    profile: botProfile({ name: intent.name ?? `${original!.name} · ${intent.kind === "replace" ? "Successor" : "Clone"}`,
      description: intent.description ?? original?.description ?? "", title: original ? parseAgentTitle(original.title).user : "",
      avatarShape: original?.avatarShape ?? "", avatarColor: original?.avatarColor ?? "" }), ...model, instructions: intent.instructions, snapshotId,
    activate: intent.activate, start: intent.start, maxRunMs: intent.maxRunMs, policyRevision: caps.policyRevision,
    ...(original ? { sourceRevision: botProfileRevision(original) } : {}), ...(intent.kind === "replace" ? { handover: { allowUserMessages: intent.allowHandoverMessages } } : {}),
    management: { installationId: d.installationId, principalId: p.id, requestId: intent.requestId, intentDigest: sha256Text(canonicalJson(intent)) } });
}
function preview(d: LifecycleDomain, r: BotWorkflowRequest): LifecyclePreview {
  return { requestId: r.management!.requestId, operationRef: lifecycleReference(d.installationId, r.scopeId, r.management!.requestId), scopeId: r.scopeId,
    planRevision: botWorkflowDigest(r), kind: r.kind, sourceBotRef: r.sourceId ? botRef(d.installationId, r.sourceId) : null,
    targetName: r.profile.name, modelId: r.modelRef, instructionsSha256: sha256Text(r.instructions), activate: r.activate, start: r.start, maxRunMs: r.maxRunMs,
    materialPolicy: "best-effort-with-gaps", planPersisted: false, nativeEffectsPerformed: false, sourceDeleted: false };
}
function query(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw invalid();
}
export function lifecycleApplication(d: LifecycleDomain, p: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => { requireCapability(p, method === "GET" ? "operations.read" : "lifecycle.write"); query(url, method === "GET" && url.pathname === "/v1/lifecycle-operations" ? ["limit", "cursor"] : []); }, catch: failure });
    if (method === "GET" && url.pathname === "/v1/lifecycle-operations") return yield* io(async () => {
      const rawLimit = url.searchParams.get("limit") ?? "20";
      if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw invalid();
      let cursor: { scopeId: string; after: string } | undefined;
      const raw = url.searchParams.get("cursor");
      const caller = sha256Text(canonicalJson([d.installationId, p.id]));
      if (raw) {
        const parts = raw.split(".");
        if (parts.length !== 3 || !hash(parts[0]) || !UUID.test(parts[1]!) || parts[2] !== caller) throw invalid();
        cursor = { scopeId: parts[0]!, after: parts[1]! };
      }
      const page = await listManagedLifecycles(d.root, d.installationId, p.id, Number(rawLimit), cursor);
      const operations: LifecycleOperation[] = [];
      for (const r of page.requests) operations.push(await lookup(d, p, r.scopeId, r.management!.requestId));
      return { operations, scopeId: page.scopeId, nextCursor: page.nextCursor ? `${page.scopeId}.${page.nextCursor}.${caller}` : null, coverage: "retained-principal-workflows" } satisfies LifecycleList;
    });
    const match = /^\/v1\/lifecycle-operations\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "GET" && match) return yield* io(() => lookup(d, p, match[1]!, match[2]!));
    if (method === "POST" && url.pathname === "/v1/lifecycle-previews") {
      const intent = yield* Effect.try({ try: () => normalizeLifecycleIntent(input, d.installationId), catch: failure });
      return yield* owned(async signal => {
        await authorizeIntent(d, p, intent, signal);
        const result = preview(d, await plan(d, p, intent, adapter(d, p, signal)));
        await authorizeIntent(d, p, intent, signal);
        return result;
      });
    }
    if (method === "POST" && ["/v1/lifecycle-changes", "/v1/lifecycle-resumptions"].includes(url.pathname)) {
      const isResume = url.pathname === "/v1/lifecycle-resumptions";
      const command = yield* Effect.try({ try: () => isResume ? normalizeLifecycleResume(input) : normalizeLifecycleSubmission(input, d.installationId), catch: failure });
      return yield* owned(async signal => {
        const intent = isResume ? null : normalizeLifecycleIntent(Object.fromEntries(Object.entries(command).filter(([k]) => !["scopeId", "planRevision", "confirmed"].includes(k))), d.installationId);
        const verify = (item: NonNullable<Awaited<ReturnType<typeof saved>>>) => {
          if (botWorkflowDigest(item.request) !== command.planRevision || intent && item.request.management!.intentDigest !== sha256Text(canonicalJson(intent)))
            throw new HttpFailure(409, "idempotency_conflict", "This original request belongs to a different saved lifecycle declaration or plan.");
        };
        const prior = await saved(d, p, command.scopeId, command.requestId);
        if (prior) {
          verify(prior);
          // Submission replay only reads history. Explicit resume is a separate
          // action on the immutable original request, not replacement input.
          if (!isResume || complete(prior) && (prior.request.kind !== "replace" || prior.receipt.phase === "retired")) return projection(d, prior);
        } else if (isResume) throw missing();
        await authorizeIntent(d, p, intent ?? { start: prior!.request.start, allowHandoverMessages: prior!.request.handover?.allowUserMessages === true }, signal);
        const result = await withManagedLifecycleGate(d.root, async () => {
          const current = await saved(d, p, command.scopeId, command.requestId);
          if (current) {
            verify(current);
            if (!isResume || complete(current) && (current.request.kind !== "replace" || current.receipt.phase === "retired")) return projection(d, current);
          }
          const native = adapter(d, p, signal);
          const r = current?.request ?? await plan(d, p, intent!, native);
          if (current && complete(current) && r.kind === "replace" && current.receipt.targetId) {
            // A completed activation stage does not complete its relationship
            // duties. Explicit resume delegates to their original guarded owner,
            // never to capture/create/initialize again.
            const permission = await native.native.authorize(r, "handover");
            if (!permission.allowed || permission.scopeId !== r.scopeId || permission.policyRevision !== r.policyRevision) throw new CurrentStateFailure("policy_changed");
            await native.native.handover(r, current.receipt.targetId);
            return lookup(d, p, r.scopeId, command.requestId);
          }
          if (r.scopeId !== command.scopeId || botWorkflowDigest(r) !== command.planRevision) throw new HttpFailure(409, "revision_conflict", "The source, model or native policy changed after preview; no workflow was admitted.");
          await authorizeIntent(d, p, { start: r.start, allowHandoverMessages: r.handover?.allowUserMessages === true }, signal);
          const program = openBotLifecycle({ durableRoot: d.root, scopeId: r.scopeId, native: native.native });
          await program.advance(r, signal);
          return lookup(d, p, r.scopeId, command.requestId);
        }, signal);
        if (result) return result;
        const running = await saved(d, p, command.scopeId, command.requestId);
        if (running) { verify(running); return projection(d, running); }
        throw new HttpFailure(503, "unavailable", "Another admitted manual lifecycle owns the driver; this request has not been admitted. Inspect its original receipt before retrying.");
      });
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "This lifecycle endpoint is not supported."));
  });
}

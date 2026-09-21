import { Effect } from "effect";
import { botIdFromRef, botRef, normalizeCompactionChange, normalizeCompactionContinuation, compactionRevision, compactionOperationRef,
  ManagementClientError, UUID, type CompactionPreview, type CompactionOperation, type CompactionResult } from "@grokbox/client/contract";
import { parseContextReceipt, parseContextBudget, parseContextManualApproval, decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { compactionManagementPrograms, compactionControlId, contextStorePresent, withManagedContextGate,
  type ManagedCompactionRow, type ContinuityGateway } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import type { ContextDomain } from "./context.ts";

const invalid = () => new HttpFailure(400, "invalid_input", "Use the reviewed compaction revision, exact Bot/account and original request UUID.");
const missing = () => new HttpFailure(404, "not_found", "No compaction request is retained for this installation and principal.");
const unavailable = () => new HttpFailure(503, "source_unavailable", "The qualified native compaction owner or original retained history is unavailable.");
function failure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof ContinuityFailure) {
    if (error.code === "conflict") return new HttpFailure(409, "revision_conflict", "An unresolved context change cannot be replaced or cancelled after native dispatch.");
    if (error.code === "scope_mismatch") return new HttpFailure(409, "source_changed", "The retained account scope has changed; no history was recreated.");
    if (error.code === "capacity") return new HttpFailure(507, "store_full", "The original CONT owner cannot admit more requests; unknown history was not removed.");
    if (error.code === "commit_unknown") return new HttpFailure(409, "operation_unknown", "Query this original request before another write; local commit acknowledgment is unknown.");
  }
  return unavailable();
}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function owned<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.scoped(Effect.gen(function* () {
    const work = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const promise = run(signal); void promise.catch(() => undefined); return { controller, promise };
    }), v => Effect.promise(async () => { v.controller.abort(); await v.promise.catch(() => undefined); }));
    return yield* io(() => work.promise);
  }));
}
type CompactionGateway = ContinuityGateway & Required<Pick<ContinuityGateway, "maintenanceControl">>;
function gateway(d: ContextDomain, signal: AbortSignal): CompactionGateway {
  if (!d.context) throw unavailable(); const g = d.context(signal).gateway();
  if (typeof g.maintenanceControl !== "function") throw unavailable();
  return g as CompactionGateway;
}
async function scope(g: ContinuityGateway, agentId: string) {
  const proof = await g.getAgentOwnership([agentId], 10000), admitted = decideManagedOwnership({ agentId, snapshot: proof.result, nowMs: Date.now() });
  if (!admitted.ok) throw new HttpFailure(409, "source_changed", "Fresh owned Box evidence is required; a source gap is not compaction authority.");
  return admitted.evidence.scopeId;
}
async function nativeStatus(g: CompactionGateway, agentId: string, operationId?: string) {
  const reply = await g.maintenanceControl({ action: "status", agentId, ...(operationId ? { operationId } : {}) }, { timeoutMs: 15000, maxResponseBytes: 65536 });
  if (!object(reply.result) || reply.result.ok !== true || !object(reply.result.data) || reply.result.data.agentId !== agentId
    || reply.result.data.sessionId !== "" || reply.result.data.queriedOperationId !== (operationId ?? null) || reply.result.data.capabilityScope !== "loaded-default-box-session") throw unavailable();
  return reply.result.data;
}
async function preview(d: ContextDomain, agentId: string, g: CompactionGateway): Promise<CompactionPreview> {
  const scopeId = await scope(g, agentId), report = await nativeStatus(g, agentId), configured = report.configured;
  if (!object(configured) || configured.managed !== true || typeof configured.modelId !== "string" || !configured.modelId || configured.modelId.length > 256
    || !object(configured.policy) || !["ready", "busy", "blocked", "unavailable"].includes(report.nativeCapability)) throw unavailable();
  const budget = parseContextBudget(configured.budget), approval = parseContextManualApproval({ scopeId, hostGeneration: report.hostGeneration,
    selectionRevision: report.selectionRevision, policyRevision: configured.policy.revision });
  if (budget.policyRevision !== approval.policyRevision) throw unavailable();
  return { botRef: botRef(d.installationId, agentId), scopeId, revision: compactionRevision(agentId, approval), approval, modelId: configured.modelId, budget,
    nativeCapability: report.nativeCapability, observedAtMs: Date.now(), rootSelection: "current-at-dispatch", contentIncluded: false, mayCallModel: true, startsTask: false };
}
async function row(d: ContextDomain, p: Principal, scopeId: string, requestId: string) {
  if (!hash(scopeId) || !UUID.test(requestId)) throw invalid();
  if (!await contextStorePresent(d.root, scopeId)) return null;
  return Effect.runPromise(compactionManagementPrograms(d.root, scopeId).read(compactionControlId(d.installationId, p.id, requestId)));
}
function project(d: ContextDomain, r: ManagedCompactionRow): CompactionOperation {
  const q = r.declaration, receipt = r.result;
  const result: CompactionResult | null = receipt ? { outcome: receipt.outcome, receiptDigest: sha256Text(canonicalJson(receipt)),
    sourceRevisionDigest: sha256Text(receipt.sourceRootRevision), revisionDigest: sha256Text(receipt.rootRevision), policyRevision: receipt.policyRevision,
    beforeTokens: receipt.before.tokens, afterTokens: receipt.after.tokens, summaryRequests: receipt.summaryRequests, summaryInputTokens: receipt.summaryInputTokens,
    targetMet: receipt.targetMet, headroomMet: receipt.headroomMet, persisted: receipt.persisted } : null;
  return { requestId: q.requestId, operationRef: compactionOperationRef(d.installationId, q.scopeId, q.requestId), botRef: botRef(d.installationId, q.agentId),
    scopeId: q.scopeId, expectedRevision: q.expectedRevision, state: r.cancelled ? "cancelled" : result ? "completed" : r.failureCode ? "failed" : r.state === "prepared" ? "admitted" : "unknown",
    result, failureCode: r.failureCode, createdAtMs: r.createdAtMs, nativeSettlement: result || r.failureCode ? "returned" : r.state === "effect_unknown" ? "not-observed" : "not-dispatched",
    currentRoot: "not-observed", startedTask: false, contentIncluded: false };
}
async function settleObserved(d: ContextDomain, r: ManagedCompactionRow, report: Record<string, any>, signal: AbortSignal) {
  const owner = compactionManagementPrograms(d.root, r.declaration.scopeId, d.hooks), last = report.lastMaintenance;
  if (report.hostGeneration !== r.declaration.approval.hostGeneration) return r;
  // A modeld commit by itself does not prove the enclosing native shell
  // finished. The exact original job supplies its own completion boundary.
  await d.authorize(signal, "context.compact"); signal.throwIfAborted();
  if (report.operationSettlement === "returned" && object(last) && last.operationId === r.operationId && last.state === "committed"
    && last.hostEpoch?.compile === r.declaration.approval.hostGeneration && last.receipt) return Effect.runPromise(owner.settle(r.operationId, parseContextReceipt(last.receipt)));
  if (report.operationSettlement === "failed" && typeof report.operationFailure === "string") return Effect.runPromise(owner.fail(r.operationId, report.operationFailure));
  return r;
}
export function compactionApplication(d: ContextDomain, p: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const capability = method === "GET" ? url.pathname.startsWith("/v1/context-compaction-operations/") ? "operations.read" : "context.read" : "context.compact";
    yield* Effect.try({ try: () => { if (url.search) throw invalid(); requireCapability(p, capability); }, catch: failure });
    const head = /^\/v1\/context-compactions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && head) return yield* io(signal => preview(d, botIdFromRef(decodeURIComponent(head[1]!), d.installationId), gateway(d, signal)));
    const get = /^\/v1\/context-compaction-operations\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "GET" && get) return yield* io(async () => { const r = await row(d, p, get[1]!, get[2]!); if (!r) throw missing(); return project(d, r); });
    const continuation = url.pathname === "/v1/context-compaction-continuations";
    if (method === "POST" && (url.pathname === "/v1/context-compactions" || continuation)) {
      const command = yield* Effect.try({ try: () => continuation ? normalizeCompactionContinuation(input, d.installationId) : normalizeCompactionChange(input, d.installationId), catch: failure });
      return yield* owned(async signal => {
        const agentId = botIdFromRef(command.botRef, d.installationId), requestId = command.requestId, scopeId = command.scopeId;
        const verify = (r: ManagedCompactionRow) => { if (r.declaration.agentId !== agentId || "expectedRevision" in command && r.declaration.expectedRevision !== command.expectedRevision)
          throw new HttpFailure(409, "idempotency_conflict", "This request belongs to another Bot or immutable approved compaction plan."); };
        const before = await row(d, p, scopeId, requestId);
        if (before) { verify(before); if (!continuation || before.state === "complete") return project(d, before); }
        else if (continuation) throw missing();
        await d.authorize(signal, "context.compact");
        const result = await withManagedContextGate(d.root, async () => {
          let r = await row(d, p, scopeId, requestId);
          if (r) { verify(r); if (!continuation || r.state === "complete") return project(d, r); }
          const owner = compactionManagementPrograms(d.root, scopeId, d.hooks);
          if ("action" in command && command.action === "cancel") {
            await d.authorize(signal, "context.compact"); signal.throwIfAborted();
            return project(d, await Effect.runPromise(owner.cancel(r!.operationId)));
          }
          const g = gateway(d, signal);
          if (r?.state === "effect_unknown" || "action" in command && command.action === "reconcile") {
            if (r?.state === "prepared") return project(d, r);
            if (!r || await scope(g, agentId) !== scopeId) throw new HttpFailure(409, "source_changed", "Compaction account scope changed; no replacement native request was sent.");
            return project(d, await settleObserved(d, r, await nativeStatus(g, agentId, r.operationId), signal));
          }
          const current = await preview(d, agentId, g), expectedRevision = r?.declaration.expectedRevision ?? ("expectedRevision" in command ? command.expectedRevision : "");
          if (current.scopeId !== scopeId || current.revision !== expectedRevision) throw new HttpFailure(409, "revision_conflict", "Compaction source, model or cost policy changed. Review a fresh preview explicitly.");
          if (current.nativeCapability !== "ready") throw new HttpFailure(409, "revision_conflict", "The exact native default session is not idle and ready for compaction.");
          await d.authorize(signal, "context.compact"); signal.throwIfAborted();
          if (!r) { await Effect.runPromise(owner.initialize()); r = await Effect.runPromise(owner.reserve({ installationId: d.installationId, principalId: p.id, requestId, agentId, scopeId, expectedRevision, approval: current.approval })); }
          try {
            await d.authorize(signal, "context.compact"); signal.throwIfAborted();
            const claim = await Effect.runPromise(owner.claim(r.operationId)); r = claim.row;
            if (claim.dispatch) {
              // The durable claim can take time or cross an injected commit
              // boundary. It cannot carry stale permission into native dispatch.
              await d.authorize(signal, "context.compact"); signal.throwIfAborted();
              const reply = await g.maintenanceControl({ action: "compact", agentId, operationId: r.operationId, confirm: true, approval: canonicalJson(r.declaration.approval) },
                { timeoutMs: 165000, maxResponseBytes: 65536, write: true, singleAttempt: true });
              const value = reply.result;
              if (object(value) && value.ok === true && object(value.data) && value.data.operationId === r.operationId) r = await Effect.runPromise(owner.settle(r.operationId, parseContextReceipt(value.data.receipt)));
              else if (object(value) && value.ok === false && value.operationId === r.operationId && value.hostGeneration === r.declaration.approval.hostGeneration
                && value.nativeSettlement === "not-started" && object(value.error) && typeof value.error.code === "string") r = await Effect.runPromise(owner.fail(r.operationId, value.error.code));
              else r = await settleObserved(d, r, await nativeStatus(g, agentId, r.operationId), signal);
            }
          } catch (error) {
            // After durable dispatch admission, transport/COMMIT uncertainty is
            // retained, never retried and never converted to a new UUID.
            const retained = await row(d, p, scopeId, requestId); if (!retained) throw unavailable();
            if (retained.state === "prepared") throw error;
            r = retained;
          }
          return project(d, r);
        }, signal);
        if (result) return result;
        const running = await row(d, p, scopeId, requestId); if (running) { verify(running); return project(d, running); }
        throw new HttpFailure(503, "unavailable", "Another context driver is active; this request has not been admitted.");
      });
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "This compaction management endpoint does not exist."));
  });
}

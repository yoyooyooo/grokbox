import { Effect } from "effect";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import {
  ContinuityFailure, DuplicateReceiptUnstored, NativeProductError, productIntent, productSubmission, productResultMatches,
  type ProductIntent, type ProductSubmission, type ProductPlan, type ProductReceipt, type ProductResult,
} from "@grokbox/runtime-kernel/continuity";
import { productManagementPrograms, productOperationId } from "../io/product-management.node.ts";
import { readContinuityIdentity, type ContinuityStoreHooks } from "../io/continuity-database.node.ts";
import { ProductDispatchRefused, type NativeProductAccess, type ProductNativeReceipt } from "../io/native-product.node.ts";
import { liveDesktopIo, reapDeletedAgentSeat, type DesktopReapResult } from "../io/desktop.node.ts";
import { openAgentDuplication } from "./agent-duplicate.runtime.ts";
import { withManagedLifecycleGate } from "./managed-lifecycle.runtime.ts";

export type ProductManagement = {
  root: string; installationId: string; principalId: string;
  native: (signal: AbortSignal) => NativeProductAccess;
  authorize: (intent: ProductIntent, signal: AbortSignal) => Promise<void>;
};
export type ProductManagementHooks = {
  store?: ContinuityStoreHooks;
  cleanup?: (id: string, signal: AbortSignal) => Promise<DesktopReapResult>;
};
/** A native identity receipt exists but its management checkpoint failed. The
 * original IDs survive in the error; this is never authority to create again. */
export class ProductReceiptUnstored extends Error {
  constructor(readonly receipt: ProductNativeReceipt, readonly requestId: string, readonly scopeId: string) { super("native_product_receipt_unstored"); }
}
const sameRequest = (row: ProductReceipt, q: ProductSubmission) => {
  if (canonicalJson(row.intent) !== canonicalJson(productIntent(qIntent(q))) || row.planRevision !== q.expectedRevision) throw new NativeProductError("revision_conflict");
  return row;
};
const qIntent = ({ scopeId: _scope, expectedRevision: _revision, confirmed: _confirmed, acceptNonAtomic: _nonAtomic, ...intent }: ProductSubmission) => intent;
const baseResult = (targetId: string | null, returned: boolean, cleanup: ProductResult["cleanup"]): ProductResult => ({
  nativeReceipt: returned ? "returned" : "not-dispatched", targetId, readBack: "not-observed", object: null, cleanup,
  atomicCompareAndSet: false, relationshipsTransferred: false, fullClone: false,
});
const cleanupState = (result: DesktopReapResult): ProductResult["cleanup"] => result.outcome === "stopped" ? "complete"
  : result.outcome === "unavailable" ? "unavailable" : "not-applicable";
const cleanupDeleted = async (id: string, signal: AbortSignal) => {
  signal.throwIfAborted();
  const io = await liveDesktopIo();
  if (!io) return { display: null, outcome: "unavailable" } as const;
  signal.throwIfAborted();
  return reapDeletedAgentSeat(id, Date.now(), { ...io, stopWindow: display => io.stopWindow(display, signal) });
};

export async function readNativeProductOperation(d: Pick<ProductManagement, "root" | "installationId" | "principalId">, scopeId: string, requestId: string): Promise<ProductReceipt | null> {
  const identity = await readContinuityIdentity(d.root);
  if (!identity) return null;
  if (identity.scopeId !== scopeId) throw new NativeProductError("source_changed");
  const id = productOperationId(d.installationId, d.principalId, requestId);
  return Effect.runPromise(productManagementPrograms(d.root, scopeId).read(id));
}
export async function previewNativeProduct(d: ProductManagement, input: ProductIntent, signal: AbortSignal): Promise<ProductPlan> {
  const intent = productIntent(input);
  await d.authorize(intent, signal); signal.throwIfAborted();
  const plan = await d.native(signal).preview(intent);
  await d.authorize(intent, signal); signal.throwIfAborted();
  return plan;
}

/** Product admission shares the existing manual lifecycle gate and CONT safety
 * database. The gate is not a lock on official clients and never implies CAS.
 * Every admitted native effect runs once; replay reads the original row. */
export async function submitNativeProduct(d: ProductManagement, input: ProductSubmission, signal: AbortSignal, hooks: ProductManagementHooks = {}): Promise<ProductReceipt> {
  const request = productSubmission(input), intent = productIntent(qIntent(request));
  const before = await readNativeProductOperation(d, request.scopeId, request.requestId);
  if (before) return sameRequest(before, request);
  await d.authorize(intent, signal); signal.throwIfAborted();
  const result = await withManagedLifecycleGate(d.root, async () => {
    const prior = await readNativeProductOperation(d, request.scopeId, request.requestId);
    if (prior) return sameRequest(prior, request);
    const native = d.native(signal), plan = await native.preview(intent);
    if (plan.scopeId !== request.scopeId || plan.revision !== request.expectedRevision) throw new NativeProductError("revision_conflict");
    await d.authorize(intent, signal); signal.throwIfAborted();
    const store = productManagementPrograms(d.root, request.scopeId, hooks.store);
    const claim = await Effect.runPromise(store.admit({ installationId: d.installationId, principalId: d.principalId,
      scopeId: request.scopeId, planRevision: request.expectedRevision, intent }));
    if (!claim.dispatch) return sameRequest(claim.receipt, request);
    const operationId = claim.receipt.operationId;
    // Authorization lost after admission is a locally known non-dispatch. It
    // does not erase the first declaration or authorize a changed replay.
    try { await d.authorize(intent, signal); signal.throwIfAborted(); }
    catch { return Effect.runPromise(store.settle(operationId, baseResult(intent.targetId, false, "not-applicable"))); }
    let created: ProductNativeReceipt | null = null;
    if (intent.action === "duplicate") {
      const original = openAgentDuplication({ durableRoot: d.root, scopeId: request.scopeId, native: {
        ...native.duplicate,
        duplicate: async (q, current) => { await d.authorize(intent, signal); signal.throwIfAborted(); return native.duplicate.duplicate(q, current); },
      } });
      try {
        const outcome = await original.execute({ sourceAgentId: intent.targetId!, operationId,
          expectedPlanRevision: plan.duplicateRevision!, confirmed: true }, signal);
        if (outcome.result) created = { targetId: outcome.result.targetAgentId, desktop: null };
        else if (outcome.operation.state === "not_executed") return Effect.runPromise(store.settle(operationId, baseResult(null, false, "not-applicable")));
      } catch (error) {
        if (error instanceof DuplicateReceiptUnstored) created = { targetId: error.created.targetAgentId, desktop: null };
        else {
          // Only the original exact native identity receipt may reconcile a
          // duplicate. No roster difference, label, or latest Bot inference.
          const saved = await original.operation(operationId).catch(() => null);
          if (saved?.result) created = { targetId: saved.result.targetAgentId, desktop: null };
          else if (saved?.operation.state === "not_executed") return Effect.runPromise(store.settle(operationId, baseResult(null, false, "not-applicable")));
        }
      }
    } else {
      try { created = await native.dispatch(plan, operationId); }
      catch (error) {
        if (error instanceof ProductDispatchRefused) return Effect.runPromise(store.settle(operationId, baseResult(intent.targetId, false, "not-applicable")));
      }
    }
    if (!created) return (await Effect.runPromise(store.read(operationId)))!;
    const needsCleanup = intent.action === "delete" && intent.kind === "bot";
    let cleanup: ProductResult["cleanup"] = needsCleanup ? created.desktop ? cleanupState(created.desktop) : "unknown"
      : intent.action === "delete" ? "native-lifecycle" : "not-applicable";
    const initial = baseResult(created.targetId, true, cleanup);
    let receipt: ProductReceipt;
    try { receipt = await Effect.runPromise(store.settle(operationId, initial)); }
    catch { throw new ProductReceiptUnstored(created, intent.requestId, request.scopeId); }
    // The native acknowledgement is durable before cleanup or readback. A
    // killed process leaves cleanup=unknown and never schedules it a second time.
    if (needsCleanup && created.desktop === null) {
      try {
        await d.authorize(intent, signal); signal.throwIfAborted();
        cleanup = cleanupState(await (hooks.cleanup ?? cleanupDeleted)(created.targetId, signal));
      } catch { cleanup = "unknown"; }
    }
    let current: ProductResult["object"] = null, readBack: ProductResult["readBack"] = "not-observed";
    try {
      await d.authorize(intent, signal); signal.throwIfAborted();
      current = await native.readBack(request.scopeId, created.targetId);
      readBack = productResultMatches(intent, current, plan.target) ? "matched" : "mismatch";
    } catch { /* A durable native acknowledgement is not lost when readback fails. */ }
    try { receipt = await Effect.runPromise(store.enrich(operationId, { ...initial, cleanup, object: current, readBack })); }
    catch { /* The original receipt remains authoritative; no effect is retried. */ }
    return receipt;
  }, signal);
  if (result) return result;
  const existing = await readNativeProductOperation(d, request.scopeId, request.requestId);
  if (existing) return sameRequest(existing, request);
  throw new NativeProductError("source_unavailable");
}

/** Recovery is a separate explicit action. It consumes the original duplicate
 * receipt already stored by CONT, and can never call a native write. Unknown
 * create/update/delete outcomes cannot be cleared by an approximate readback. */
export async function reconcileNativeProduct(d: ProductManagement, scopeId: string, requestId: string, signal: AbortSignal): Promise<ProductReceipt> {
  const row = await readNativeProductOperation(d, scopeId, requestId);
  if (!row) throw new NativeProductError("not_found");
  await d.authorize(row.intent, signal); signal.throwIfAborted();
  if (row.state === "complete" || row.intent.action !== "duplicate") return row;
  const exact = await openAgentDuplication({ durableRoot: d.root, scopeId }).operation(row.operationId).catch(error => {
    if (error instanceof ContinuityFailure && error.code === "not_found") return null;
    throw error;
  });
  if (!exact || exact.request.source.agentId !== row.intent.targetId || exact.request.source.scopeId !== scopeId) return row;
  const result = exact.result ? baseResult(exact.result.targetAgentId, true, "not-applicable")
    : exact.operation.state === "not_executed" ? baseResult(null, false, "not-applicable") : null;
  if (!result) return row;
  return Effect.runPromise(productManagementPrograms(d.root, scopeId).settle(row.operationId, result));
}

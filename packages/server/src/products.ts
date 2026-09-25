import { Effect } from "effect";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ContinuityFailure, NativeProductError } from "@grokbox/runtime-kernel/continuity";
import {
  normalizeProductIntent, normalizeProductSubmission, productOperationIdentity, productReference, UUID, ManagementClientError,
  type ProductIntent, type ProductList, type Capability,
} from "@grokbox/client/contract";
import {
  previewNativeProduct, submitNativeProduct, readNativeProductOperation, reconcileNativeProduct, ProductReceiptUnstored, ProductDiagnosticUnstored,
  type NativeProductAccess, type ProductManagement, type ProductManagementHooks,
} from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { boundedPage, pageInput } from "./pagination.ts";

export type ProductDomain = {
  root: string; installationId: string; native: (signal: AbortSignal, authorizeWrite?: () => Promise<void>) => NativeProductAccess;
  authorize: (signal: AbortSignal, capability: Capability) => Promise<void>; hooks?: ProductManagementHooks;
};
function failure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ProductReceiptUnstored) return new HttpFailure(409, "operation_unknown", "A native identity receipt exists, but its management checkpoint is uncertain. Do not repeat the creation.",
    { requestId: error.requestId, scopeId: error.scopeId, targetId: error.receipt.targetId, nativeReceipt: "returned" });
  if (error instanceof ProductDiagnosticUnstored) return new HttpFailure(409, "operation_unknown", "The native effect remains unknown and its failure diagnostic could not be confirmed stored. Inspect the original request; do not repeat it.",
    { requestId: error.requestId, scopeId: error.scopeId, diagnosticStored: false });
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof NativeProductError) return new HttpFailure(error.code === "invalid_input" ? 400 : error.code === "permission_denied" ? 403
    : error.code === "not_found" ? 404 : ["revision_conflict", "source_changed"].includes(error.code) ? 409 : 503,
    error.code, error.code === "revision_conflict" ? "The original native product declaration, scope, or reviewed source changed; no replacement request was inferred."
      : "The native product operation did not pass its bounded source and permission checks.");
  if (error instanceof ContinuityFailure) {
    if (error.code === "capacity") return new HttpFailure(507, "store_full", "The original native product safety store cannot admit more work.");
    if (error.code === "conflict") return new HttpFailure(409, "idempotency_conflict", "An original declaration or unresolved native effect owns this request or target.");
    if (error.code === "scope_mismatch") return new HttpFailure(409, "source_changed", "The original safety store belongs to a different native account scope.");
    if (error.code === "commit_unknown") return new HttpFailure(409, "operation_unknown", "The original native product checkpoint is uncertain; inspect the same request.");
  }
  return new HttpFailure(503, "source_unavailable", "The native product source or original safety store is unavailable; no fallback writer was selected.");
}
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: failure });
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
/** An admitted write outlives its HTTP connection, not the Server Scope. */
function owned<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.scoped(Effect.gen(function* () {
    const task = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const promise = run(signal); void promise.catch(() => undefined);
      return { controller, promise };
    }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
    return yield* io(() => task.promise);
  }));
}
export function productIntentCapabilities(intent: ProductIntent): Capability[] {
  return ["products.read", "products.write", ...(intent.action === "create" ? ["products.create" as const] : []),
    ...(intent.action === "delete" ? ["products.delete" as const] : []),
    ...(intent.action === "duplicate" ? ["products.duplicate" as const, "routines.write" as const] : []),
    ...(intent.action === "create" && intent.kind === "bot" && !intent.deferStart ? ["lifecycle.start" as const] : [])];
}
const noQuery = (url: URL) => { if (url.search) throw new HttpFailure(400, "invalid_input", "This native product endpoint does not accept query parameters."); };
export function productApplication(d: ProductDomain, p: Principal, method: string, url: URL, input?: unknown) {
  const management: ProductManagement = { root: d.root, installationId: d.installationId, principalId: p.id, native: d.native,
    authorize: async (intent, signal) => {
      for (const capability of productIntentCapabilities(intent)) { requireCapability(p, capability); await d.authorize(signal, capability); }
      signal.throwIfAborted();
    } };
  return Effect.gen(function* () {
    yield* checked(() => requireCapability(p, "products.read"));
    if (method === "GET" && url.pathname === "/v1/products") {
      const query = yield* checked(() => {
        for (const key of url.searchParams.keys()) if (!["kind", "targetId", "limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new NativeProductError("invalid_input");
        const kind = url.searchParams.get("kind"), targetId = url.searchParams.get("targetId");
        if (kind !== null && kind !== "bot" && kind !== "group" || targetId !== null && !UUID.test(targetId)) throw new NativeProductError("invalid_input");
        const paged = new URL(url); paged.searchParams.delete("kind"); paged.searchParams.delete("targetId");
        return { kind, targetId: targetId?.toLowerCase() ?? null, page: pageInput(paged) };
      });
      return yield* io(async signal => {
        const snapshot = await d.native(signal).snapshot(d.installationId, query.targetId);
        const rows = snapshot.objects.filter(row => (query.kind === null || row.kind === query.kind) && (query.targetId === null || row.id === query.targetId));
        if (query.targetId !== null && rows.length !== 1) throw new NativeProductError("not_found");
        const revision = sha256Text(canonicalJson([snapshot.authority.scopeId, snapshot.authority.generation, query.kind, query.targetId, rows.map(row => [row.id, row.revision])]));
        const page = boundedPage(rows, query.page, d.installationId, revision, row => ({ ...row, ref: productReference(row.kind, d.installationId, row.id) }));
        return { objects: page.items, scopeId: snapshot.authority.scopeId, sourceGeneration: snapshot.authority.generation, revision,
          total: page.total, nextCursor: page.nextCursor, pageBound: page.pageBound, coverage: "current-native-roster" } satisfies ProductList;
      });
    }
    const ownership = /^\/v1\/product-ownership\/([a-f0-9-]{36})$/.exec(url.pathname);
    const relations = /^\/v1\/product-relations\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "GET" && (ownership || relations)) {
      const target = (ownership ?? relations)![1]!;
      yield* checked(() => {
        noQuery(url); if (!UUID.test(target)) throw new NativeProductError("invalid_input");
        if (relations) { requireCapability(p, "messages.read"); requireCapability(p, "routines.read"); }
      });
      return yield* io(async signal => ownership ? await d.native(signal).ownership([target]) : await d.native(signal).relations(target));
    }
    const operation = /^\/v1\/product-operations\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "GET" && operation) {
      yield* checked(() => { noQuery(url); requireCapability(p, "operations.read"); productOperationIdentity({ scopeId: operation[1], requestId: operation[2] }); });
      return yield* io(async () => {
        const row = await readNativeProductOperation(management, operation[1]!, operation[2]!);
        if (!row) throw new NativeProductError("not_found");
        return row;
      });
    }
    if (method === "POST" && url.pathname === "/v1/product-previews") {
      const intent = yield* checked(() => { noQuery(url); return normalizeProductIntent(input); });
      return yield* owned(signal => previewNativeProduct(management, intent, signal));
    }
    if (method === "POST" && url.pathname === "/v1/product-changes") {
      const command = yield* checked(() => { noQuery(url); requireCapability(p, "products.write"); return normalizeProductSubmission(input); });
      return yield* owned(signal => submitNativeProduct(management, command, signal, d.hooks));
    }
    if (method === "POST" && url.pathname === "/v1/product-reconciliations") {
      const command = yield* checked(() => { noQuery(url); requireCapability(p, "products.write"); requireCapability(p, "operations.read"); return productOperationIdentity(input); });
      return yield* owned(signal => reconcileNativeProduct(management, command.scopeId, command.requestId, signal));
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "This native product endpoint is not supported."));
  });
}

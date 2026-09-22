import { Effect } from "effect";
import { join } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { MATERIAL_UUID, MaterialError, materialIdentity, normalizeMaterialWrite, normalizeMaterialQuery,
  type MaterialQuery, type MaterialOperation, type MaterialStatus, type MaterialPage, type MaterialRead } from "@grokbox/runtime-kernel/materials";
import { currentMaterialSources, materialViews, openMaterialStore, readMaterialSource, replaceMaterialSource,
  type MaterialDomain, type MaterialWriteHooks, type startMaterialIndexer } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
export type MaterialApplicationDomain = MaterialDomain & { status: () => ReturnType<ReturnType<typeof startMaterialIndexer>["status"]>;
  authorizeWrite?: (signal: AbortSignal) => Promise<void>; writeHooks?: MaterialWriteHooks };
const failure = (error: unknown) => error instanceof HttpFailure ? error : error instanceof MaterialError
  ? new HttpFailure(error.code === "invalid_input" ? 400 : error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : error.code === "store_full" ? 507
    : error.code === "source_unavailable" || error.code === "source_incomplete" ? 503 : 409, error.code, error.reason)
  : new HttpFailure(503, "source_unavailable", "The configured material source is unavailable; no fallback source was selected.");
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const keyFor = (domain: MaterialDomain, principal: Principal, requestId: string) => sha256Text(canonicalJson(["material-write-v1", domain.installationId, principal.id, requestId]));
async function selected(domain: MaterialDomain, ref: string) {
  const target = materialIdentity(ref, domain.installationId), current = await currentMaterialSources(domain);
  const row = current.sources.find(source => source.config.id === target.sourceId);
  if (!row) throw new MaterialError("permission_denied", "This source is no longer in the enabled material scope.");
  if (!row.bound) throw new MaterialError("source_unavailable", "The configured source root is unavailable.");
  if (row.bound.binding !== target.binding) throw new MaterialError("source_changed", "The root or source authorization changed. Do not apply an old reference to its replacement.");
  return { target, source: row.bound };
}
export function materialApplication(domain: MaterialApplicationDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const path = url.pathname, store = openMaterialStore(domain.root);
    yield* Effect.try({ try: () => requireCapability(principal, path.startsWith("/v1/material-operations/") ? "operations.read"
      : method === "POST" ? "materials.write" : path.startsWith("/v1/material-content/") ? "materials.content.read"
      : url.searchParams.has("query") ? "materials.search" : "materials.read"), catch: failure });
    if (path !== "/v1/materials" && url.search) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "This material endpoint accepts no query parameters."));
    if (method === "GET" && path === "/v1/material-status") return yield* io(async () => ({ ...domain.status(), sources: (await materialViews(domain)).views } satisfies MaterialStatus));
    if (method === "GET" && path === "/v1/materials") return yield* io(async () => {
      const allowed = ["sourceId", "kind", "scope", "query", "cursor", "limit"];
      if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new MaterialError("invalid_input", "Invalid material query fields.");
      const query = normalizeMaterialQuery(Object.fromEntries([...url.searchParams].map(([key,value]) => [key,key === "limit" ? Number(value) : value])) as MaterialQuery);
      const current = await materialViews(domain);
      if (!current.config?.enabled || !current.sources.length) throw new MaterialError("source_unavailable", "No material sources are explicitly enabled.");
      if (query.sourceId && !current.sources.some(row => row.config.id === query.sourceId)) throw new MaterialError("permission_denied", "That source is not configured for this installation.");
      const bindings = current.sources.flatMap(row => row.bound ? [row.bound.binding] : []);
      const page = await store.page(query, bindings);
      const after = await currentMaterialSources(domain);
      if (after.revision !== current.revision || canonicalJson(after.sources.map(s=>s.bound?.binding ?? null)) !== canonicalJson(current.sources.map(s=>s.bound?.binding ?? null))) throw new MaterialError("source_changed", "Material authorization changed during the query.");
      return { ...page, sources: current.views, search: query.query ? "literal-case-insensitive" : "none", coverage: "indexed-window", contentIncluded: false } satisfies MaterialPage;
    });
    const content = /^\/v1\/material-content\/([^/]+)$/.exec(path);
    if (method === "GET" && content) return yield* io(async signal => {
      const ref = decodeURIComponent(content[1]!), { target, source } = await selected(domain, ref);
      const direct = await readMaterialSource(source, target.path, signal); await selected(domain, ref);
      let indexed: Awaited<ReturnType<typeof store.metadata>> = null, indexUnavailable = false;
      try { indexed = await store.exists() ? await store.metadata(target.binding, target.path) : null; } catch { indexUnavailable = true; }
      return { document: direct.metadata, content: direct.content, encoding: "utf8", source: "direct-read", contentProjection: direct.metadata.kind === "membership" ? "authorized-membership" : "exact-text", observedAtMs: Date.now(), indexedRevision: indexed?.revision ?? null,
        indexState: indexUnavailable ? "unavailable" : !indexed ? "not-indexed" : indexed.revision === direct.metadata.revision ? "matched" : "lagging", includedInTurn: "not-observed" } satisfies MaterialRead;
    });
    const lookup = /^\/v1\/material-operations\/([^/]+)$/.exec(path);
    if (method === "GET" && lookup) return yield* io(async () => {
      if (!MATERIAL_UUID.test(lookup[1]!)) throw new MaterialError("invalid_input", "Use the original material request UUID.");
      const row = await store.operation(keyFor(domain, principal, lookup[1]!.toLowerCase()));
      if (!row) throw new MaterialError("not_found", "No material operation is recorded for this principal and request."); return row.receipt;
    });
    if (method === "POST" && path === "/v1/material-changes") {
      const request = yield* Effect.try({ try: () => normalizeMaterialWrite(input, domain.installationId), catch: failure });
      const key = keyFor(domain, principal, request.requestId), digest = sha256Text(canonicalJson(request));
      const previous = yield* io(async () => await store.exists() ? store.operation(key) : null);
      if (previous) { if (previous.digest !== digest) return yield* Effect.fail(new HttpFailure(409,"idempotency_conflict","The request ID belongs to different material input.")); return previous.receipt; }
      const { target, source } = yield* io(() => selected(domain, request.ref));
      if (source.config.kind !== "files" || !source.config.writable) return yield* Effect.fail(new HttpFailure(403,"permission_denied","Native Memory/Project replicas are read-only; use their actual source owner for changes."));
      const current = yield* io(signal => readMaterialSource(source, target.path, signal));
      if (current.metadata.revision !== request.expectedRevision) return yield* Effect.fail(new HttpFailure(409,"revision_conflict","The source changed. Read the latest revision and preserve the draft."));
      yield* io(() => store.initialize());
      const initial: MaterialOperation = { requestId: request.requestId, operationRef: `material-operation:${domain.installationId}:${key}`, ref: request.ref,
        sourceId: target.sourceId, binding: target.binding, beforeRevision: request.expectedRevision, afterRevision: null, state: "unknown", acceptedAtMs: Date.now(), settledAtMs: null,
        sourceWrite: "replace-existing-text", evidence: "not-verified", externalCompareAndSwap: false, indexAdoption: "not-observed" };
      const reservation = yield* Effect.uninterruptible(io(() => store.reserve(key,digest,initial,target.path,join(source.root,target.path))));
      if (!reservation.created) return reservation.receipt;
      // The request owns both the file operation and durable settlement. Server
      // shutdown aborts pre-publication work and waits for any publication begun.
      return yield* Effect.scoped(Effect.gen(function* () {
        const task = yield* Effect.acquireRelease(Effect.sync(() => {
          const controller = new AbortController();
          const promise = (async () => {
            let sourcePublished = false;
            try {
              const after = await replaceMaterialSource(source,target.path,request.expectedRevision,request.content,controller.signal, {
                beforePublish: async () => { await domain.writeHooks?.beforePublish?.(); await selected(domain, request.ref); await domain.authorizeWrite?.(controller.signal); },
                afterPublish: domain.writeHooks?.afterPublish,
              });
              sourcePublished = true;
              return await store.settle(key,{ ...initial, state: "succeeded", afterRevision: after.metadata.revision, evidence: "source-readback", settledAtMs: Date.now() });
            } catch (error) {
              const unknown = sourcePublished || error instanceof MaterialError && error.code === "operation_unknown";
              const result = { ...initial, state: unknown ? "unknown" as const : "refused" as const, settledAtMs: Date.now() };
              await store.settle(key,result).catch(() => undefined);
              if (unknown) return initial;
              throw failure(error);
            }
          })(); void promise.catch(() => undefined); return { controller, promise };
        }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
        return yield* io(() => task.promise);
      }));
    }
    return yield* Effect.fail(new HttpFailure(404,"not_found","The material endpoint is not supported."));
  });
}

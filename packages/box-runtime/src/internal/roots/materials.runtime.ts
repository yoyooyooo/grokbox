import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { relative, isAbsolute, sep } from "node:path";
import { MaterialError, MATERIAL_POLICY as P, type MaterialSourceConfig, type MaterialSourceView, type MaterialStatus } from "@grokbox/runtime-kernel/materials";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { bindMaterialSource, scanMaterialSource, type BoundMaterialSource } from "../io/material-source.node.ts";
import { openMaterialStore } from "../io/material-store.node.ts";
export type MaterialDomain = { root: string; installationId: string };
export async function currentMaterialSources(domain: MaterialDomain) {
  const snapshot = await openConfigStore(rootConfigLayout(domain.root)).read();
  const config = snapshot.document.materials;
  const sources: { config: MaterialSourceConfig; bound: BoundMaterialSource | null; reason: string | null }[] = [];
  if (config?.enabled) for (const source of config.sources) {
    try { sources.push({ config: source, bound: await bindMaterialSource(source, domain.installationId, domain.root), reason: null }); }
    catch { sources.push({ config: source, bound: null, reason: "source-root-unavailable" }); }
  }
  const overlaps = (a: string, b: string) => { const r = relative(a, b); return r === "" || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  const invalid = new Set<string>();
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const a = sources[i]!, b = sources[j]!;
    if (a.bound && b.bound && (overlaps(a.bound.root, b.bound.root) || overlaps(b.bound.root, a.bound.root))) { invalid.add(a.config.id); invalid.add(b.config.id); }
  }
  for (const row of sources) if (invalid.has(row.config.id)) { row.bound = null; row.reason = "overlapping-source-roots"; }
  return { revision: sha256Text(canonicalJson(config ?? null)), config, sources };
}
export function materialSourceView(config: MaterialSourceConfig, bound: BoundMaterialSource | null, previous?: MaterialSourceView, reason: string | null = null): MaterialSourceView {
  const matched = previous && previous.binding === bound?.binding;
  return { id: config.id, kind: config.kind, accountScope: config.accountScope, binding: bound?.binding ?? null,
    state: !bound ? "unavailable" : matched ? previous.state : "not-indexed", indexedAtMs: matched ? previous.indexedAtMs : null,
    attemptedAtMs: matched ? previous.attemptedAtMs : null, documents: matched ? previous.documents : 0,
    skipped: matched ? previous.skipped : 0, reason: reason ?? (matched ? previous.reason : null),
    writable: config.kind === "files" && config.writable, freshness: matched && previous.indexedAtMs !== null ? "stale" : "not-indexed", coverage: "configured-local-sources", upstreamSync: "not-observed", identityBasis: "explicit-source-binding" };
}
export async function materialViews(domain: MaterialDomain) {
  const current = await currentMaterialSources(domain), store = openMaterialStore(domain.root);
  const previous = await store.exists() ? await store.views() : [];
  const now = Date.now(), maxAge = 2 * (current.config?.intervalMs ?? P.intervalMs);
  const views = current.sources.map(row => {
    const view = materialSourceView(row.config, row.bound, previous.find(p => p.id === row.config.id), row.reason);
    view.freshness = view.indexedAtMs === null ? "not-indexed" : now >= view.indexedAtMs && now - view.indexedAtMs <= maxAge ? "fresh" : "stale";return view;
  });
  return { ...current, views };
}
/** One host-owned bounded reconciliation loop. Directory events are not needed
 * for correctness: every cycle reads sources again and atomically replaces only
 * its derived index partition. No source mutation, native RPC or model call. */
export function startMaterialIndexer(domain: MaterialDomain, ports: { intervalMs?: number; scan?: typeof scanMaterialSource } = {}) {
  const controller = new AbortController(), store = openMaterialStore(domain.root), ownerToken = randomUUID();
  const state: Omit<MaterialStatus, "sources"> = { owner: "management-server", state: "not-configured", cycles: 0, lastCycleAtMs: null, sourceWrites: false, historyReconstructed: false };
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.state = "stopped"; }));
    yield* Effect.forever(Effect.gen(function* () {
      let interval: number = P.intervalMs;
      yield* Effect.uninterruptible(Effect.tryPromise({ try: async () => {
        const current = await currentMaterialSources(domain); interval = current.config?.intervalMs ?? P.intervalMs;
        if (!current.config) { state.state = "not-configured"; return; }
        if (!current.config.enabled) { state.state = "disabled"; return; }
        controller.signal.throwIfAborted(); state.state = "indexing"; await store.initialize();
        if (!(await store.claimIndexer(ownerToken))) { state.state = "unavailable"; return; }
        try {
        for (const source of current.sources) {
          controller.signal.throwIfAborted(); const previous = (await store.views()).find(row => row.id === source.config.id);
          let view = materialSourceView(source.config, source.bound, previous, source.reason);
          if (!source.bound) { await store.publish({ ...view, attemptedAtMs: Date.now() }); continue; }
          try {
            const scanned = await (ports.scan ?? scanMaterialSource)(source.bound, controller.signal);
            controller.signal.throwIfAborted(); const after = await currentMaterialSources(domain);
            if (after.revision !== current.revision || after.sources.find(s => s.config.id === source.config.id)?.bound?.binding !== source.bound.binding) throw new MaterialError("source_changed", "Source binding changed during scan.");
            view = { ...view, indexedAtMs: Date.now(), attemptedAtMs: Date.now(), state: scanned.skipped ? "partial" : "ready",
              documents: scanned.documents.length, skipped: scanned.skipped, reason: scanned.skipped ? "bounded-or-unreadable-items" : null };
            await store.publish(view, scanned.documents);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            await store.publish({ ...view, state: "unavailable", attemptedAtMs: Date.now(), reason: "scan-unavailable" });
          }
        }
        controller.signal.throwIfAborted();
        const after = await currentMaterialSources(domain);
        if (after.revision === current.revision) await store.prune(current.sources.map(s => s.config.id));
        state.state = "waiting";
        } finally { await store.releaseIndexer(ownerToken); }
      }, catch: () => new MaterialError("source_unavailable", "Material indexing is unavailable.") }).pipe(Effect.catch(() => Effect.sync(() => { state.state = "unavailable"; }))));
      state.cycles = Math.min(Number.MAX_SAFE_INTEGER, state.cycles + 1); state.lastCycleAtMs = Date.now();
      yield* Effect.sleep(`${ports.intervalMs ?? interval} millis`);
    }));
  }));
  const running = Effect.runPromiseExit(program, { signal: controller.signal });
  return { status: () => ({ ...state }), close: async () => { controller.abort(); await running; } };
}

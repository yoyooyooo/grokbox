import { Effect } from "effect";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { continuityId, continuityStorePolicy, ContinuityFailure, assertProductReceipt, assertProductDiagnostic, productIntent,
  type ProductIntent, type ProductReceipt, type ProductResult, type ProductDiagnostic } from "@grokbox/runtime-kernel/continuity";
import { PRODUCT_FAILURE_DETAIL_BYTES, type ProductCallFailure } from "./native-product-failure.node.ts";
import { continuityDatabase, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

export const productOperationId = (installationId: string, principalId: string, requestId: string) =>
  continuityId(installationId, canonicalJson(["managed-native-product-v1", principalId, requestId]));
export type ProductDeclaration = Pick<ProductReceipt, "installationId" | "principalId" | "scopeId" | "planRevision"> & { intent: ProductIntent };
const corrupt = (): never => { throw new ContinuityFailure("integrity_failure"); };
/** Product admissions live in the original CONT safety database. These rows
 * fence the authenticated management request; official Host APIs still own facts.
 * Admission and single-dispatch claim are one transaction. A crash is unknown,
 * never a fresh dispatch permit. Historical reads do not need a live Gateway. */
export function productManagementPrograms(root: string, scopeId: string, hooks: ContinuityStoreHooks = {}) {
  const db = continuityDatabase(root, scopeId, continuityStorePolicy(), hooks);
  const diagnosticId = (id: string) => continuityId(id, "managed-native-product-diagnostic-v1");
  const readDiagnostic = async (c: MonitorSqlite, id: string): Promise<ProductDiagnostic | null> => {
    const row = await c.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [diagnosticId(id)]);
    if (!row) return null;
    if (row.kind !== "managed-native-product-diagnostic" || row.agent_id !== id || row.state !== "complete"
      || row.request_json !== "{}" || typeof row.result_json !== "string" || Buffer.byteLength(row.result_json) > 65536) return corrupt();
    const saved = JSON.parse(row.result_json);
    if (!saved || Object.keys(saved).sort().join() !== "detail,diagnostic" || !(saved.detail === null
      || typeof saved.detail === "string" && Buffer.byteLength(saved.detail) <= PRODUCT_FAILURE_DETAIL_BYTES)) return corrupt();
    const diagnostic = assertProductDiagnostic(saved.diagnostic);
    if (diagnostic.detailStored !== (saved.detail !== null) || row.created_at !== diagnostic.observedAtMs || row.updated_at !== row.created_at) return corrupt();
    return diagnostic;
  };
  const readRow = async (c: MonitorSqlite, id: string): Promise<ProductReceipt | null> => {
    const row = await c.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [id]);
    if (!row) return null;
    if (row.kind !== "managed-native-product" || typeof row.request_json !== "string" || Buffer.byteLength(row.request_json) > 32768
      || !["effect_unknown", "complete"].includes(String(row.state)) || row.result_json !== null && (typeof row.result_json !== "string" || Buffer.byteLength(row.result_json) > 65536)) return corrupt();
    const declaration = JSON.parse(row.request_json) as ProductDeclaration;
    if (Object.keys(declaration).sort().join() !== "installationId,intent,planRevision,principalId,scopeId") return corrupt();
    const receipt = assertProductReceipt({ ...declaration, operationId: id, requestId: declaration.intent.requestId,
      state: row.state as ProductReceipt["state"], result: row.result_json === null ? null : JSON.parse(row.result_json),
      diagnostic: await readDiagnostic(c, id), createdAtMs: Number(row.created_at) });
    if (receipt.scopeId !== scopeId || id !== productOperationId(receipt.installationId, receipt.principalId, receipt.requestId)
      || row.agent_id !== (receipt.intent.targetId ?? receipt.requestId)) return corrupt();
    return receipt;
  };
  return {
    read: (id: string) => db.read(c => readRow(c, id)),
    recordFailure: (id: string, failure: ProductCallFailure) => db.write("native-product-diagnostic", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      if (row.diagnostic !== null) return row;
      const now = Date.now(), diagnostic = assertProductDiagnostic({ ...failure.observation,
        observedAtMs: now, detailStored: failure.privateDetail !== null });
      const text = canonicalJson({ diagnostic, detail: failure.privateDetail });
      if (Buffer.byteLength(text) > 65536) throw new ContinuityFailure("capacity");
      await db.metadataRoom(c, Buffer.byteLength(text) * 2 + 8192);
      // One bounded private observation beside the immutable original row. It
      // never supplies a native identity, settles unknown, or permits replay.
      await c.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,'{}','complete',?,?,?)",
        [diagnosticId(id), id, "managed-native-product-diagnostic", text, now, now]);
      return (await readRow(c, id))!;
    }),
    admit: (declaration: ProductDeclaration) => Effect.gen(function* () {
      const q = { ...declaration, intent: productIntent(declaration.intent) };
      if (q.scopeId !== scopeId) return yield* Effect.fail(new ContinuityFailure("scope_mismatch"));
      yield* db.initialize();
      return yield* db.write("native-product-admit", async c => {
        const id = productOperationId(q.installationId, q.principalId, q.intent.requestId), old = await readRow(c, id);
        if (old) {
          const prior = { installationId: old.installationId, principalId: old.principalId, scopeId: old.scopeId, planRevision: old.planRevision, intent: old.intent };
          if (canonicalJson(prior) !== canonicalJson(q)) throw new ContinuityFailure("conflict");
          return { dispatch: false, receipt: old };
        }
        // Creation has no existing target identity. Fence the same normalized
        // declaration across request IDs, not every independent birth. Existing
        // objects remain fenced by their exact target identity.
        const { requestId: _requestId, ...creation } = q.intent;
        const blocker = q.intent.targetId === null
          ? await c.first("SELECT operation_id FROM continuity_queued_controls WHERE kind='managed-native-product' AND state!='complete' AND json_extract(request_json,'$.intent.targetId') IS NULL AND json_remove(json_extract(request_json,'$.intent'),'$.requestId')=? LIMIT 1", [canonicalJson(creation)])
          : await c.first("SELECT operation_id FROM continuity_queued_controls WHERE kind='managed-native-product' AND state!='complete' AND agent_id=? LIMIT 1", [q.intent.targetId]);
        if (blocker || q.intent.targetId !== null && await c.first("SELECT operation_id FROM operations WHERE agent_id=? AND state IN ('prepared','effect_unknown') LIMIT 1", [q.intent.targetId])) throw new ContinuityFailure("conflict");
        if (Number((await c.first("SELECT COUNT(*) n FROM continuity_queued_controls WHERE kind='managed-native-product'"))?.n) >= 512) throw new ContinuityFailure("capacity");
        const text = canonicalJson(q), now = Date.now();
        if (Buffer.byteLength(text) > 32768) throw new ContinuityFailure("capacity");
        // Preserve room for a bounded receipt before permitting remote effects.
        await db.metadataRoom(c, Buffer.byteLength(text) * 2 + 98304);
        await c.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'effect_unknown',NULL,?,?)", [id, q.intent.targetId ?? q.intent.requestId, "managed-native-product", text, now, now]);
        return { dispatch: true, receipt: (await readRow(c, id))! };
      });
    }),
    enrich: (id: string, result: ProductResult) => db.write("native-product-observation", async c => {
      const row = await readRow(c, id); if (!row?.result) throw new ContinuityFailure("not_found");
      assertProductReceipt({ ...row, result });
      if (canonicalJson(row.result) === canonicalJson(result)) return row;
      const old = row.result;
      if (old.nativeReceipt !== "returned" || result.nativeReceipt !== old.nativeReceipt || old.targetId !== result.targetId
        || old.readBack !== "not-observed" || old.object !== null || old.cleanup !== "unknown" && old.cleanup !== result.cleanup) throw new ContinuityFailure("conflict");
      const text = canonicalJson(result); if (Buffer.byteLength(text) > 65536) throw new ContinuityFailure("capacity");
      await db.metadataRoom(c, Buffer.byteLength(text) * 2 + 8192);
      await c.run("UPDATE continuity_queued_controls SET result_json=?,updated_at=? WHERE operation_id=?", [text, Date.now(), id]);
      return (await readRow(c, id))!;
    }),
    settle: (id: string, result: ProductResult) => db.write("native-product-settle", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      if (row.result !== null) { if (canonicalJson(row.result) !== canonicalJson(result)) throw new ContinuityFailure("conflict"); return row; }
      assertProductReceipt({ ...row, state: "complete", result });
      const text = canonicalJson(result);
      if (Buffer.byteLength(text) > 65536) throw new ContinuityFailure("capacity");
      await db.metadataRoom(c, Buffer.byteLength(text) * 2 + 8192);
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?", [text, Date.now(), id]);
      return (await readRow(c, id))!;
    }),
  };
}

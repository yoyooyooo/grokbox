import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { parseContextManualApproval, parseContextReceipt, contextManualApprovalRevision, CONTEXT_FAILURE_CODES, type ContextFailureCode, type ContextManualApproval, type ContextMaintenanceReceipt } from "@grokbox/runtime-kernel/contract";
import { continuityId, continuityStorePolicy, isContinuityUuid, isContinuityHash, ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { continuityDatabase, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

export type ManagedCompactionDeclaration = { installationId: string; principalId: string; requestId: string; agentId: string;
  scopeId: string; expectedRevision: string; approval: ContextManualApproval };
export type ManagedCompactionRow = { declaration: ManagedCompactionDeclaration; operationId: string; state: "prepared" | "effect_unknown" | "complete";
  result: ContextMaintenanceReceipt | null; failureCode: ContextFailureCode | null; cancelled: boolean; createdAtMs: number };
export const compactionControlId = (installationId: string, principalId: string, requestId: string) => continuityId(installationId, canonicalJson(["managed-compaction-v1", principalId, requestId]));
const fail = (): never => { throw new ContinuityFailure("integrity_failure"); };
const safeFailure = (v: unknown): v is ContextFailureCode => typeof v === "string" && (CONTEXT_FAILURE_CODES as readonly string[]).includes(v) && !["commit_unknown", "native_cleanup_unknown"].includes(v);
function declaration(raw: unknown): ManagedCompactionDeclaration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== "agentId,approval,expectedRevision,installationId,principalId,requestId,scopeId") return fail();
  const r = raw as ManagedCompactionDeclaration, approval = parseContextManualApproval(r.approval);
  if (![r.installationId, r.requestId, r.agentId].every(isContinuityUuid) || !isContinuityHash(r.scopeId) || !isContinuityHash(r.expectedRevision)
    || r.expectedRevision !== contextManualApprovalRevision(r.agentId, approval) || typeof r.principalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(r.principalId) || r.scopeId !== approval.scopeId) return fail();
  return { ...r, approval };
}
/** Manual control identity and dispatch proof live in the existing CONT table.
 * modeld still owns summarization, budgets and its native receipt. No second
 * compaction algorithm, safety database, receipt TTL or execution retry exists. */
export function compactionManagementPrograms(root: string, scopeId: string, hooks: ContinuityStoreHooks = {}) {
  const db = continuityDatabase(root, scopeId, continuityStorePolicy(), hooks);
  const readRow = async (connection: MonitorSqlite, id: string): Promise<ManagedCompactionRow | null> => {
    if (!isContinuityUuid(id)) return fail();
    const row = await connection.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [id]);
    if (!row) return null;
    if (row.kind !== "managed-compaction" || typeof row.request_json !== "string" || row.request_json.length > 4096
      || !["prepared", "effect_unknown", "complete"].includes(String(row.state))) return fail();
    const d = declaration(JSON.parse(row.request_json));
    if (d.scopeId !== scopeId || row.agent_id !== d.agentId || id !== compactionControlId(d.installationId, d.principalId, d.requestId)
      || !Number.isSafeInteger(row.created_at) || Number(row.created_at) < 1) return fail();
    let result: ContextMaintenanceReceipt | null = null, cancelled = false, failureCode: ContextFailureCode | null = null;
    if (row.result_json !== null) {
      if (row.state !== "complete" || typeof row.result_json !== "string" || row.result_json.length > 16384) return fail();
      const value = JSON.parse(row.result_json);
      if (canonicalJson(value) === canonicalJson({ cancelledBeforeDispatch: true })) cancelled = true;
      else if (value && typeof value === "object" && Object.keys(value).join() === "failedWithNativeSettlement" && safeFailure(value.failedWithNativeSettlement)) failureCode = value.failedWithNativeSettlement;
      else {
        result = parseContextReceipt(value);
        if (result.operationId !== id || result.policyRevision !== d.approval.policyRevision
          || (result.outcome === "committed") !== result.persisted) return fail();
      }
    }
    if (row.state === "complete" && !result && !cancelled && !failureCode) return fail();
    return { declaration: d, operationId: id, state: row.state as ManagedCompactionRow["state"], result, failureCode, cancelled, createdAtMs: Number(row.created_at) };
  };
  const read = (id: string) => db.read(c => readRow(c, id));
  return { initialize: db.initialize, read,
    reserve: (raw: ManagedCompactionDeclaration) => db.write("managed-compaction-prepare", async c => {
      const d = declaration(raw), id = compactionControlId(d.installationId, d.principalId, d.requestId), old = await readRow(c, id);
      if (old) { if (canonicalJson(old.declaration) !== canonicalJson(d)) throw new ContinuityFailure("conflict"); return old; }
      if (d.scopeId !== scopeId) throw new ContinuityFailure("scope_mismatch");
      if (await c.first(`SELECT operation_id FROM continuity_queued_controls WHERE agent_id=? AND state!='complete'
        AND (kind='managed-compaction' OR kind='managed-current-state' AND json_extract(request_json,'$.declaration.action')!='capture') LIMIT 1`, [d.agentId])) throw new ContinuityFailure("conflict");
      const count = await c.first("SELECT COUNT(*) AS n FROM continuity_queued_controls WHERE kind='managed-compaction'");
      if (Number(count?.n) >= 512) throw new ContinuityFailure("capacity");
      const text = canonicalJson(d), now = Date.now(); await db.metadataRoom(c, Buffer.byteLength(text) * 2 + 32768);
      await c.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'prepared',NULL,?,?)", [id, d.agentId, "managed-compaction", text, now, now]);
      return (await readRow(c, id))!;
    }),
    claim: (id: string) => db.write("managed-compaction-claim", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      if (row.state !== "prepared") return { dispatch: false, row };
      await c.run("UPDATE continuity_queued_controls SET state='effect_unknown',updated_at=? WHERE operation_id=?", [Date.now(), id]);
      return { dispatch: true, row: (await readRow(c, id))! };
    }),
    settle: (id: string, raw: ContextMaintenanceReceipt) => db.write("managed-compaction-settle", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      const result = parseContextReceipt(raw);
      if (result.operationId !== id || result.policyRevision !== row.declaration.approval.policyRevision || (result.outcome === "committed") !== result.persisted
        || row.cancelled || row.failureCode || row.state === "prepared" || row.result && canonicalJson(row.result) !== canonicalJson(result)) throw new ContinuityFailure("conflict");
      if (row.result) return row;
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?", [canonicalJson(result), Date.now(), id]);
      return (await readRow(c, id))!;
    }),
    fail: (id: string, code: string) => db.write("managed-compaction-failure", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      if (!safeFailure(code) || row.state === "prepared" || row.cancelled || row.result || row.failureCode && row.failureCode !== code) throw new ContinuityFailure("conflict");
      if (row.failureCode) return row;
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?", [canonicalJson({ failedWithNativeSettlement: code }), Date.now(), id]);
      return (await readRow(c, id))!;
    }),
    cancel: (id: string) => db.write("managed-compaction-cancel", async c => {
      const row = await readRow(c, id); if (!row) throw new ContinuityFailure("not_found");
      if (row.cancelled) return row;
      if (row.state !== "prepared") throw new ContinuityFailure("conflict");
      await c.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?", [canonicalJson({ cancelledBeforeDispatch: true }), Date.now(), id]);
      return (await readRow(c, id))!;
    }),
  };
}

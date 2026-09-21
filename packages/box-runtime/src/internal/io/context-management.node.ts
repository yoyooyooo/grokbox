import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { continuityId, continuityStorePolicy, nativeCurrentHead, isContinuityUuid, isContinuityHash, ContinuityFailure,
  type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { continuityDatabase, readContinuityIdentity, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

export type ManagedContextDeclaration = { installationId: string; principalId: string; requestId: string; agentId: string;
  scopeId: string; action: "capture" | "initialize" | "reset" | "restore"; expectedRevision: string; snapshotId: string | null };
export type ManagedContextRecord = { version: 1; declaration: ManagedContextDeclaration; expected: NativeCurrentHead; policyRevision: string;
  operationId: string; activationId: string; captureId: string; backupId: string; candidateId: string; materialIds: string[] };
export type ManagedContextRow = { record: ManagedContextRecord; state: "prepared" | "effect_unknown" | "complete";
  createdAtMs: number; cancelled: boolean; activation: null | { state: "prepared" | "effect_unknown" | "complete"; expectedRevision: string } };
const fail = (): never => { throw new ContinuityFailure("integrity_failure"); };
export const contextControlId = (installationId: string, principalId: string, requestId: string) => continuityId(installationId, canonicalJson(["managed-current-state-v1", principalId, requestId]));
export function managedContextRecord(declaration: ManagedContextDeclaration, expected: NativeCurrentHead, policyRevision: string): ManagedContextRecord {
  const d = declaration;
  if (Object.keys(d).sort().join() !== "action,agentId,expectedRevision,installationId,principalId,requestId,scopeId,snapshotId") return fail();
  if (!isContinuityUuid(d.installationId) || !isContinuityUuid(d.requestId) || !isContinuityUuid(d.agentId) || !isContinuityHash(d.scopeId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(d.principalId) || !isContinuityHash(d.expectedRevision)
    || !["capture", "initialize", "reset", "restore"].includes(d.action)
    || (["initialize", "restore"].includes(d.action) ? !isContinuityUuid(d.snapshotId) : d.snapshotId !== null)) return fail();
  const head = nativeCurrentHead(expected);
  if (head.agentId !== d.agentId || head.scopeId !== d.scopeId || head.contextRevision !== d.expectedRevision || !isContinuityHash(policyRevision)) return fail();
  const operationId = contextControlId(d.installationId, d.principalId, d.requestId);
  const captureId = continuityId(operationId, "capture"), backupId = continuityId(operationId, "backup"), candidateId = continuityId(operationId, "candidate");
  return { version: 1, declaration: structuredClone(d), expected: head, policyRevision, operationId, activationId: continuityId(operationId, "activation"),
    captureId, backupId, candidateId, materialIds: d.action === "capture" ? [captureId] : d.action === "initialize" ? [d.snapshotId!] : [backupId, candidateId, ...(d.snapshotId ? [d.snapshotId] : [])] };
}
function decode(text: unknown): ManagedContextRecord {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384) return fail();
  try {
    const raw = JSON.parse(text), record = managedContextRecord(raw.declaration, raw.expected, raw.policyRevision);
    if (canonicalJson(raw) !== canonicalJson(record)) return fail();
    return record;
  } catch { return fail(); }
}
/** Management identity stays in the existing CONT control table. Its declared
 * material IDs are pinned by that same owner's recovery GC before publication;
 * neither rebuilding a search index nor expiring diagnostics can erase them. */
export function contextManagementPrograms(root: string, scopeId: string, hooks: ContinuityStoreHooks = {}) {
  const database = continuityDatabase(root, scopeId, continuityStorePolicy(), hooks);
  const row = async (db: MonitorSqlite, id: string): Promise<ManagedContextRow | null> => {
    if (!isContinuityUuid(id)) return fail();
    const value = await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [id]);
    if (!value) return null;
    if (value.kind !== "managed-current-state" || !["prepared", "effect_unknown", "complete"].includes(String(value.state))) return fail();
    const record = decode(value.request_json);
    if (record.operationId !== id || value.agent_id !== record.declaration.agentId || record.declaration.scopeId !== scopeId) return fail();
    const active = await db.first("SELECT * FROM continuity_queued_controls WHERE operation_id=?", [record.activationId]);
    let activation: ManagedContextRow["activation"] = null;
    if (active) {
      if (active.kind !== "managed-current-release" || active.agent_id !== value.agent_id || !["prepared", "effect_unknown", "complete"].includes(String(active.state))) return fail();
      const request = JSON.parse(String(active.request_json));
      if (Object.keys(request).sort().join() !== "expectedRevision,operationId" || request.operationId !== id || !isContinuityHash(request.expectedRevision)) return fail();
      activation = { state: active.state as NonNullable<ManagedContextRow["activation"]>["state"], expectedRevision: request.expectedRevision };
    }
    const cancelled = value.result_json !== null;
    if (cancelled && (value.state !== "complete" || value.result_json !== canonicalJson({ disposition: "cancelled-before-source-application" }) || activation)) return fail();
    if (!Number.isSafeInteger(value.created_at) || Number(value.created_at) < 1) return fail();
    return { record, state: value.state as ManagedContextRow["state"], createdAtMs: Number(value.created_at), cancelled, activation };
  };
  const read = (id: string) => database.read(db => row(db, id));
  const reserve = (input: ManagedContextRecord) => database.write("managed-context-prepare", async db => {
    const record = decode(canonicalJson(input)), old = await row(db, record.operationId);
    if (old) { if (canonicalJson(old.record) !== canonicalJson(record)) throw new ContinuityFailure("conflict"); return old; }
    // An unacknowledged mutation on this Bot cannot be bypassed with a new UUID
    // or another principal. Capture-only records cannot mutate the native source.
    if (record.declaration.action !== "capture" && await db.first(`SELECT operation_id FROM continuity_queued_controls
      WHERE agent_id=? AND state!='complete'
      AND (kind='managed-compaction' OR kind='managed-current-state' AND json_extract(request_json,'$.declaration.action')!='capture') LIMIT 1`, [record.declaration.agentId])) throw new ContinuityFailure("conflict");
    const text = canonicalJson(record), now = Date.now(); await database.metadataRoom(db, Buffer.byteLength(text) * 2 + 8192);
    await db.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'prepared',NULL,?,?)", [record.operationId, record.declaration.agentId, "managed-current-state", text, now, now]);
    return (await row(db, record.operationId))!;
  });
  const phase = (id: string, next: "effect_unknown" | "complete") => database.write("managed-context-settle", async db => {
    const current = await row(db, id); if (!current) throw new ContinuityFailure("not_found");
    if (current.state === "complete") return current;
    await db.run("UPDATE continuity_queued_controls SET state=?,updated_at=? WHERE operation_id=?", [next, Date.now(), id]);
    return (await row(db, id))!;
  });
  const activation = (id: string, expectedRevision: string) => database.write("managed-context-release-prepare", async db => {
    const current = await row(db, id); if (!current) throw new ContinuityFailure("not_found");
    if (current.record.declaration.action === "capture" || !isContinuityHash(expectedRevision)) throw new ContinuityFailure("conflict");
    if (current.activation) {
      if (current.activation.expectedRevision !== expectedRevision) throw new ContinuityFailure("conflict");
      return current;
    }
    const now = Date.now(); await database.metadataRoom(db, 8192);
    await db.run("INSERT INTO continuity_queued_controls VALUES(?,?,?,?,'prepared',NULL,?,?)", [current.record.activationId, current.record.declaration.agentId,
      "managed-current-release", canonicalJson({ operationId: id, expectedRevision }), now, now]);
    return (await row(db, id))!;
  });
  const activationPhase = (id: string, next: "effect_unknown" | "complete") => database.write("managed-context-release-settle", async db => {
    const current = await row(db, id); if (!current?.activation) throw new ContinuityFailure("not_found");
    if (current.activation.state === "complete") return current;
    await db.run("UPDATE continuity_queued_controls SET state=?,updated_at=? WHERE operation_id=?", [next, Date.now(), current.record.activationId]);
    return (await row(db, id))!;
  });
  const cancel = (id: string) => database.write("managed-context-cancel", async db => {
    const current = await row(db, id); if (!current) throw new ContinuityFailure("not_found");
    if (current.cancelled) return current;
    // The driver gate must also be held. No native application declaration is
    // treated as a proved non-dispatch: only its actual absence permits cancel.
    if (current.state === "complete" || current.activation || await db.first("SELECT operation_id FROM operations WHERE operation_id=?", [id])) throw new ContinuityFailure("conflict");
    await db.run("UPDATE continuity_queued_controls SET state='complete',result_json=?,updated_at=? WHERE operation_id=?",
      [canonicalJson({ disposition: "cancelled-before-source-application" }), Date.now(), id]);
    return (await row(db, id))!;
  });
  return { initialize: database.initialize, read, reserve, phase, activation, activationPhase, cancel };
}
export async function contextStorePresent(root: string, scopeId: string): Promise<boolean> {
  const identity = await readContinuityIdentity(root);
  if (identity && identity.scopeId !== scopeId) throw new ContinuityFailure("scope_mismatch");
  return identity !== null;
}

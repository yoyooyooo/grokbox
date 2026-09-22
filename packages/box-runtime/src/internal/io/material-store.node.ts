import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { MATERIAL_POLICY as P, MaterialError, type MaterialMetadata, type MaterialOperation, type MaterialQuery, type MaterialSourceView } from "@grokbox/runtime-kernel/materials";
import { FILE_POLICY, FILE_SHA, fileIdentity, validFileOperation, type FileOperation } from "@grokbox/runtime-kernel/files";
import { assertSafeDirectory } from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { openMonitorSqlite, type MonitorSqlite } from "./monitor-sqlite.node.ts";
import { monitorProcessIdentity } from "./monitor-owner.node.ts";
import type { SourceDocument } from "./material-source.node.ts";
const APPLICATION_ID = 1196249428;
const fail = (code: ConstructorParameters<typeof MaterialError>[0], message: string): never => { throw new MaterialError(code, message); };
const missing = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const DDL = `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2;
CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root_id TEXT NOT NULL,generation INTEGER NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY,binding TEXT,view_json TEXT NOT NULL);
CREATE TABLE index_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,start TEXT NOT NULL,token TEXT NOT NULL);
CREATE TABLE documents(source_id TEXT NOT NULL,binding TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,metadata_json TEXT NOT NULL,search_text TEXT NOT NULL,PRIMARY KEY(source_id,path));
CREATE TABLE operations(key TEXT PRIMARY KEY,digest TEXT NOT NULL,binding TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT NOT NULL,physical_path TEXT NOT NULL);
CREATE UNIQUE INDEX unsettled_document ON operations(binding,path) WHERE state='unknown';
CREATE TABLE file_operations(key TEXT PRIMARY KEY,digest TEXT NOT NULL,root_key TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT NOT NULL,physical_path TEXT NOT NULL);
CREATE INDEX file_pending ON file_operations(root_key,state);`;
function decodeFile(key: string, text: unknown): FileOperation {
  let v: unknown; try { v = JSON.parse(String(text)); } catch { return fail("source_unavailable", "The retained file receipt is corrupt."); }
  const installation = (v as { ref?: string } | null)?.ref?.split(":")[1] ?? "";
  if (!validFileOperation(v, installation) || v.operationRef !== `file-operation:${installation}:${key}`) return fail("source_unavailable", "The retained file receipt is unsupported.");
  return v;
}
/** All current source views share the same path/subtree publication exclusion.
 * Changing root declarations cannot bypass an unresolved write using another adapter. */
async function reservePhysicalPath(db: MonitorSqlite, path: string) {
  if (!path.startsWith("/") || resolve(path) !== path || path.includes("\0")) return fail("invalid_input", "Invalid physical source scope.");
  const pending = await db.all("SELECT physical_path FROM file_operations WHERE state='unknown' UNION ALL SELECT physical_path FROM operations WHERE state='unknown'");
  if (pending.some(r => typeof r.physical_path !== "string" || r.physical_path === path || path.startsWith(`${r.physical_path}/`) || String(r.physical_path).startsWith(`${path}/`))) return fail("operation_unknown", "An unresolved source publication protects this physical path or subtree.");
}
/** Index replacement never drops the operations table. A rebuild is a derived
 * snapshot replacement, not permission to discard unresolved source effects. */
export function openMaterialStore(durableRoot: string) {
  const root = resolve(durableRoot), directory = join(root, "state/materials"), path = join(directory, "materials.sqlite"), rootId = sha256Text(canonicalJson(["materials-v1", root]));
  async function exists() { return lstat(path).then(() => true).catch(e => { if (missing(e)) return false; throw e; }); }
  async function transaction<A>(write: boolean, run: (db: MonitorSqlite) => Promise<A>): Promise<A> {
    if (!(await exists())) return fail("source_unavailable", "The material index is not initialized; a read will not create it.");
    await assertSafeDirectory(directory);
    const db = await openMonitorSqlite(path, write ? "write" : "read"); let committing = false;
    try {
      if (Number(Object.values((await db.first("PRAGMA application_id"))!)[0]) !== APPLICATION_ID
        || Number(Object.values((await db.first("PRAGMA user_version"))!)[0]) !== 2
        || (await db.first("SELECT root_id FROM meta WHERE singleton=1"))?.root_id !== rootId) return fail("source_unavailable", "The existing material index is invalid; it was not recreated.");
      if (write) {
        const page = Number(Object.values((await db.first("PRAGMA page_size"))!)[0]);
        await db.run(`PRAGMA max_page_count=${Math.floor(P.maxIndexBytes / page)}`);
      }
      await db.run(write ? "BEGIN IMMEDIATE" : "BEGIN"); const value = await run(db); committing = true; await db.run("COMMIT");
      return value;
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
      if (committing && write) return fail("operation_unknown", "The material transaction acknowledgement is uncertain.");
      if (error instanceof MaterialError) throw error;
      if ((error as { code?: string })?.code === "SQLITE_FULL") return fail("store_full", "The bounded material store is full; no safety record was evicted.");
      return fail("source_unavailable", "The material store could not complete this transaction.");
    } finally { await db.close(); }
  }
  async function initialize() {
    // An established index needs validation, not a repeated global config lock.
    if (await exists()) { await transaction(false, async () => undefined); return; }
    const lease = await acquireConfigurationLease(root);
    try {
      if (await exists()) { await transaction(false, async () => undefined); return; }
      const priorDirectory = await lstat(directory).catch(e => { if (missing(e)) return null; throw e; });
      if (priorDirectory) return fail("source_unavailable", "The existing material store is missing; it was not recreated into a new write permission.");
      await assertSafeDirectory(join(root, "state"), true); await assertSafeDirectory(directory, true);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.sync(); await file.close();
      const db = await openMonitorSqlite(path, "write");
      try { await db.run("BEGIN IMMEDIATE"); await db.run(DDL); await db.run("INSERT INTO meta VALUES(1,?,0)", [rootId]); await db.run("COMMIT"); }
      finally { await db.close(); }
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await lease.release(); }
  }
  return {
    path, initialize, exists,
    fileOperation: (key: string) => transaction(false, async db => {
      if (!FILE_SHA.test(key)) return fail("invalid_input", "Invalid file operation key.");
      const row = await db.first("SELECT * FROM file_operations WHERE key=?", [key]);
      if (!row) return null;
      const receipt = decodeFile(key, row.receipt_json);
      if (row.state !== receipt.state || typeof row.digest !== "string" || !FILE_SHA.test(row.digest)) return fail("source_unavailable", "The file operation guard is corrupt.");
      return { digest: row.digest, rootKey: String(row.root_key), path: String(row.path), receipt };
    }),
    reserveFile: (key: string, digest: string, rootKey: string, receipt: FileOperation, physicalPath: string) => transaction(true, async db => {
      if (!FILE_SHA.test(key) || !FILE_SHA.test(digest) || !FILE_SHA.test(rootKey) || receipt.state !== "unknown") return fail("invalid_input", "Invalid file reservation.");
      decodeFile(key, JSON.stringify(receipt));
      const target = fileIdentity(receipt.ref, receipt.ref.split(":")[1]!);
      const prior = await db.first("SELECT digest,receipt_json FROM file_operations WHERE key=?", [key]);
      if (prior) {
        if (prior.digest !== digest) return fail("idempotency_conflict", "The file request belongs to different immutable input.");
        return { created: false, receipt: decodeFile(key, prior.receipt_json) };
      }
      await reservePhysicalPath(db, physicalPath);
      if (Number((await db.first("SELECT COUNT(*) AS n FROM file_operations"))?.n) >= FILE_POLICY.maxOperations) return fail("store_full", "File safety capacity is full; no unknown receipt was evicted.");
      await db.run("INSERT INTO file_operations VALUES(?,?,?,?,?,?,?)", [key, digest, rootKey, target.path, "unknown", JSON.stringify(receipt), physicalPath]);
      return { created: true, receipt };
    }),
    settleFile: (key: string, receipt: FileOperation) => transaction(true, async db => {
      decodeFile(key, JSON.stringify(receipt));
      const row = await db.first("SELECT receipt_json,state FROM file_operations WHERE key=?", [key]);
      if (!row) return fail("operation_unknown", "The original file guard is missing.");
      const prior = decodeFile(key, row.receipt_json);
      if (prior.ref !== receipt.ref || prior.requestId !== receipt.requestId || prior.action !== receipt.action || prior.expectedRevision !== receipt.expectedRevision || prior.serviceGeneration !== receipt.serviceGeneration || prior.acceptedAtMs !== receipt.acceptedAtMs) return fail("idempotency_conflict", "The file operation changed identity.");
      if (row.state !== "unknown") {
        if (canonicalJson(prior) !== canonicalJson(receipt)) return fail("idempotency_conflict", "A terminal file receipt cannot be overwritten.");
        return prior;
      }
      await db.run("UPDATE file_operations SET state=?,receipt_json=? WHERE key=?", [receipt.state, JSON.stringify(receipt), key]); return receipt;
    }),
    claimIndexer: (token: string) => transaction(true, async db => {
      const current = await monitorProcessIdentity(process.pid);
      if (current.state !== "present") return fail("source_unavailable", "The index owner process identity is unavailable.");
      const prior = await db.first("SELECT pid,start,token FROM index_owner WHERE singleton=1");
      if (prior) {
        if (prior.token === token && prior.pid === process.pid && prior.start === current.start) return true;
        const owner = await monitorProcessIdentity(Number(prior.pid));
        if (owner.state !== "missing" && !(owner.state === "present" && owner.start !== prior.start)) return false;
      }
      await db.run("INSERT INTO index_owner VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,start=excluded.start,token=excluded.token",[process.pid,current.start,token]);return true;
    }),
    releaseIndexer: (token: string) => transaction(true, async db => { await db.run("DELETE FROM index_owner WHERE singleton=1 AND token=?",[token]); }),
    publish: (view: MaterialSourceView, documents?: SourceDocument[]) => transaction(true, async db => {
      const prior = await db.first("SELECT binding FROM sources WHERE id=?", [view.id]);
      let changed = !prior || prior.binding !== view.binding;
      if (documents) {
        const existing = new Map((await db.all("SELECT path,metadata_json FROM documents WHERE source_id=?", [view.id])).map(row => [String(row.path),String(row.metadata_json)]));
        for (const doc of documents) {
          const metadata = JSON.stringify(doc.metadata), previous = existing.get(doc.metadata.path);existing.delete(doc.metadata.path);
          if (previous === metadata) continue;
          changed = true;
          await db.run("INSERT INTO documents VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET binding=excluded.binding,kind=excluded.kind,scope=excluded.scope,metadata_json=excluded.metadata_json,search_text=excluded.search_text", [view.id, view.binding!, doc.metadata.path,
            doc.metadata.kind, doc.metadata.scope, metadata, `${doc.metadata.path}\n${doc.content}`.toLowerCase()]);
        }
        for (const path of existing.keys()) { await db.run("DELETE FROM documents WHERE source_id=? AND path=?",[view.id,path]);changed = true; }
      }
      await db.run("INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET binding=excluded.binding,view_json=excluded.view_json", [view.id, view.binding, JSON.stringify(view)]);
      // Freshness advances on every completed reconciliation; unchanged content
      // does not rewrite all bodies or invalidate an otherwise stable cursor.
      if (changed) await db.run("UPDATE meta SET generation=generation+1");
    }),
    prune: (ids: string[]) => transaction(true, async db => {
      const current = await db.all("SELECT id FROM sources"); let changed = false;
      for (const row of current) if (!ids.includes(String(row.id))) { await db.run("DELETE FROM sources WHERE id=?", [String(row.id)]); await db.run("DELETE FROM documents WHERE source_id=?", [String(row.id)]); changed = true; }
      if (changed) await db.run("UPDATE meta SET generation=generation+1");
    }),
    views: () => transaction(false, async db => (await db.all("SELECT view_json FROM sources ORDER BY id")).map(row => JSON.parse(String(row.view_json)) as MaterialSourceView)),
    metadata: (binding: string, path: string) => transaction(false, async db => {
      const row = await db.first("SELECT metadata_json FROM documents WHERE binding=? AND path=?", [binding, path]);
      return row ? JSON.parse(String(row.metadata_json)) as MaterialMetadata : null;
    }),
    page: (query: MaterialQuery, bindings: string[]) => transaction(false, async db => {
      const generation = Number((await db.first("SELECT generation FROM meta"))!.generation), limit = query.limit ?? 50;
      const signature = sha256Text(canonicalJson([generation, [...bindings].sort(), query.sourceId ?? null, query.kind ?? null, query.scope ?? null, query.query ?? null, limit]));
      let offset = 0;
      if (query.cursor) { const p = query.cursor.split(":"); if (p.length !== 2 || p[0] !== signature || !/^\d+$/.test(p[1]!) || !Number.isSafeInteger(Number(p[1]))) return fail("cursor_gap", "The material snapshot or query changed. Start a new page traversal."); offset = Number(p[1]); }
      const clauses = [bindings.length ? `binding IN (${bindings.map(() => "?").join(",")})` : "0"], params: (string | number)[] = [...bindings];
      for (const [field, value] of [["source_id", query.sourceId], ["kind", query.kind], ["scope", query.scope]] as const) if (value !== undefined) { clauses.push(`${field}=?`); params.push(value); }
      if (query.query !== undefined) { clauses.push("instr(search_text,?)>0"); params.push(query.query.toLowerCase()); }
      const rows = await db.all(`SELECT metadata_json FROM documents WHERE ${clauses.join(" AND ")} ORDER BY source_id,path LIMIT ? OFFSET ?`, [...params, limit + 1, offset]);
      const items: MaterialMetadata[] = []; let bytes = 0;
      for (const row of rows.slice(0, limit)) { const text = String(row.metadata_json); if (bytes + Buffer.byteLength(text) > 160 * 1024) break; items.push(JSON.parse(text)); bytes += Buffer.byteLength(text); }
      return { items, snapshot: signature, nextCursor: rows.length > items.length ? `${signature}:${offset + items.length}` : null };
    }),
    operation: (key: string) => transaction(false, async db => {
      const row = await db.first("SELECT digest,receipt_json FROM operations WHERE key=?", [key]);
      return row ? { digest: String(row.digest), receipt: JSON.parse(String(row.receipt_json)) as MaterialOperation } : null;
    }),
    reserve: (key: string, digest: string, receipt: MaterialOperation, relativePath: string, physicalPath: string) => transaction(true, async db => {
      const prior = await db.first("SELECT digest,receipt_json FROM operations WHERE key=?", [key]);
      if (prior) {
        if (prior.digest !== digest) return fail("idempotency_conflict", "This material request ID belongs to different input.");
        return { created: false, receipt: JSON.parse(String(prior.receipt_json)) as MaterialOperation };
      }
      await reservePhysicalPath(db, physicalPath);
      if (Number((await db.first("SELECT COUNT(*) AS n FROM operations"))!.n) >= P.maxOperations) return fail("store_full", "Material operation capacity is full; unresolved records have not been discarded.");
      await db.run("INSERT INTO operations VALUES(?,?,?,?,?,?,?)", [key, digest, receipt.binding, relativePath, "unknown", JSON.stringify(receipt), physicalPath]);
      return { created: true, receipt };
    }),
    settle: (key: string, receipt: MaterialOperation) => transaction(true, async db => {
      const row = await db.first("SELECT receipt_json,state FROM operations WHERE key=?", [key]);
      if (!row) return fail("operation_unknown", "The original source operation cannot be found.");
      const prior = JSON.parse(String(row.receipt_json)) as MaterialOperation;
      if (prior.ref !== receipt.ref || prior.requestId !== receipt.requestId) return fail("idempotency_conflict", "The operation target changed.");
      if (row.state !== "unknown") return prior;
      await db.run("UPDATE operations SET state=?,receipt_json=? WHERE key=?", [receipt.state, JSON.stringify(receipt), key]); return receipt;
    }),
  };
}
export type MaterialStore = ReturnType<typeof openMaterialStore>;

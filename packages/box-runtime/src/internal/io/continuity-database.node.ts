import { Effect } from "effect";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ContinuityFailure, failContinuity, continuityStorePolicy, isContinuityHash, type ContinuityStorePolicy } from "@grokbox/runtime-kernel/continuity";
import { openMonitorSqlite, type MonitorSqlite } from "./monitor-sqlite.node.ts";
import { checkContinuityFile, checkContinuityRoot, continuityPrivateDirectory, syncContinuityDirectory, continuityIoFailure, missingFile } from "./continuity-files.node.ts";

import { CONTINUITY_WORKFLOW_SCHEMA } from "./continuity-workflow-schema.ts";

export const CONTINUITY_DB_VERSION = 4;
const SCHEMA = `
CREATE TABLE continuity_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,root_id TEXT NOT NULL,scope_id TEXT NOT NULL);
CREATE TABLE publications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,agent_id TEXT NOT NULL,quality TEXT NOT NULL,manifest_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('reserved','published','abandoned','retired')),reserved_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX publication_agent ON publications(agent_id,state,sequence);
CREATE TABLE objects(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
CREATE TABLE material_links(request_id TEXT NOT NULL REFERENCES publications(request_id),hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(request_id,hash));
CREATE INDEX material_hash ON material_links(hash);
CREATE TABLE reference_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt_json TEXT NOT NULL);
CREATE TABLE claims(owner TEXT NOT NULL,claim_id TEXT NOT NULL,ref TEXT NOT NULL,revision TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),PRIMARY KEY(owner,claim_id));
CREATE INDEX protected_reference ON claims(owner,ref,revision);
CREATE TABLE operations(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,intent_json TEXT NOT NULL,agent_id TEXT NOT NULL,snapshot_id TEXT REFERENCES publications(request_id),
 state TEXT NOT NULL CHECK(state IN ('prepared','effect_unknown','succeeded','not_executed')),revision INTEGER NOT NULL,effect_id TEXT UNIQUE,evidence_hash TEXT,created_at INTEGER NOT NULL,request_json TEXT,result_json TEXT);
CREATE INDEX operation_snapshot ON operations(snapshot_id,state);
CREATE INDEX operation_agent_state ON operations(agent_id,state);
${CONTINUITY_WORKFLOW_SCHEMA}
`;
export type ContinuityStoreHooks = {
  /** Private fault/barrier seams; no environment or CLI can provide them. */
  afterReservation?: () => Promise<void>;
  afterObject?: (index: number) => Promise<void>;
  beforeCommit?: (label: string) => Promise<void>;
  afterCommit?: (label: string) => Promise<void>;
};
export const continuityIo = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: continuityIoFailure });

/** Read only the existing owner identity. It is historical scope, not a fresh
 * account attestation. A missing database inside a known owner directory is
 * damage, never permission to initialize a replacement safety history. */
export async function readContinuityIdentity(root: string): Promise<{ scopeId: string; schemaVersion: number } | null> {
  const directory = join(resolve(root), "continuity"), file = join(directory, "state.sqlite");
  await checkContinuityRoot(root);
  const found = await lstat(directory).catch(error => { if (missingFile(error)) return null; throw error; });
  if (!found) return null;
  await continuityPrivateDirectory(directory);
  const info = await checkContinuityFile(file, true);
  if (!info) return failContinuity("integrity_failure");
  if ((await lstat(file)).size > continuityStorePolicy().maxMetadataBytes) return failContinuity("capacity");
  const db = await openMonitorSqlite(file, "read");
  try {
    const meta = await db.first("SELECT version,root_id,scope_id FROM continuity_meta WHERE singleton=1");
    const version = (await db.first("PRAGMA user_version"))?.user_version;
    if (!meta || !isContinuityHash(meta.scope_id) || !Number.isSafeInteger(version) || meta.version !== version
      || meta.root_id !== sha256Text(canonicalJson(["continuity-store-v1", resolve(root), meta.scope_id]))) return failContinuity("integrity_failure");
    return { scopeId: meta.scope_id, schemaVersion: Number(version) };
  } finally { await db.close(); }
}

/** One private CONT management DB shared by recovery + safety, separate from
 * the diagnostic TTL/cap. Reuses the existing Node SQLite driver only. No
 * collector, implicit migration or second native-session writer is installed. */
export function continuityDatabase(root: string, scopeId: string, policy: ContinuityStorePolicy, hooks: ContinuityStoreHooks) {
  const directory = join(resolve(root), "continuity"), file = join(directory, "state.sqlite");
  const rootId = sha256Text(canonicalJson(["continuity-store-v1", resolve(root), scopeId]));
  const checkDirectories = async () => {
    await checkContinuityRoot(root); await continuityPrivateDirectory(directory);
    await continuityPrivateDirectory(join(directory, "objects")); await continuityPrivateDirectory(join(directory, "staging"));
    for (const suffix of ["-journal", "-wal", "-shm"]) await checkContinuityFile(file + suffix, true);
  };
  const checkDb = async (db: MonitorSqlite) => {
    const version = await db.first("PRAGMA user_version"), meta = await db.first("SELECT * FROM continuity_meta WHERE singleton=1");
    if (version?.user_version !== CONTINUITY_DB_VERSION || meta?.version !== CONTINUITY_DB_VERSION) return failContinuity("schema_mismatch");
    if (meta.root_id !== rootId || meta.scope_id !== scopeId) return failContinuity("scope_mismatch");
    if ((await db.first("PRAGMA journal_mode"))?.journal_mode !== "delete") return failContinuity("schema_mismatch");
  };
  const acquire = (mode: "read" | "write") => continuityIo(async () => {
    try { await checkDirectories(); if (!await checkContinuityFile(file, true)) return failContinuity("not_initialized"); }
    catch (e) { if (missingFile(e)) return failContinuity("not_initialized"); throw e; }
    const db = await openMonitorSqlite(file, mode);
    try {
      await checkDb(db);
      if (mode === "write") await db.run(`PRAGMA max_page_count=${Math.floor(policy.maxMetadataBytes / 4096)};`);
      return db;
    } catch (e) { await db.close(); throw e; }
  });
  const close = (db: MonitorSqlite) => continuityIo(() => db.close()).pipe(Effect.orDie);
  const transaction = <A>(label: string, write: boolean, body: (db: MonitorSqlite) => Promise<A>) => Effect.scoped(Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(Effect.uninterruptible(acquire(write ? "write" : "read")), close);
    // Exactly one bounded local transaction. No remote effects, detached work,
    // model calls or timers may enter this callback. Cancellation settles it.
    return yield* Effect.uninterruptible(continuityIo(async () => {
      let begun = false, commitAttempted = false;
      try {
        await db.run(write ? "BEGIN IMMEDIATE" : "BEGIN"); begun = true;
        const result = await body(db);
        if (write) await hooks.beforeCommit?.(label);
        commitAttempted = write; await db.run(write ? "COMMIT" : "ROLLBACK"); begun = false;
        if (write) await hooks.afterCommit?.(label);
        return result;
      } catch (error) {
        if (begun) await db.run("ROLLBACK").catch(() => undefined);
        if (commitAttempted) throw new ContinuityFailure("commit_unknown");
        throw error;
      }
    }));
  }));
  const initialize = () => Effect.scoped(Effect.gen(function* () {
    yield* continuityIo(async () => {
      await checkContinuityRoot(root);
      const existingOwner = await lstat(directory).catch(error => { if (missingFile(error)) return null; throw error; });
      if (existingOwner && !await checkContinuityFile(file, true)) return failContinuity("integrity_failure");
      await continuityPrivateDirectory(directory, true);
      await continuityPrivateDirectory(join(directory, "objects"), true);
      await continuityPrivateDirectory(join(directory, "staging"), true);
    });
    const exists = yield* continuityIo(() => checkContinuityFile(file, true));
    if (exists) {
      // Explicit initializer only. GET never performs schema migration. Preserve
      // all old unknown operations. Exact requests and bounded identity receipts
      // let restarted consumers reconcile without inferring or recreating Bots.
      yield* continuityIo(checkDirectories);
      const existing = yield* Effect.acquireRelease(Effect.uninterruptible(continuityIo(() => openMonitorSqlite(file, "write"))), close);
      return yield* Effect.uninterruptible(continuityIo(async () => {
        await existing.run("BEGIN IMMEDIATE"); let committing = false;
        try {
          const version = await existing.first("PRAGMA user_version"), meta = await existing.first("SELECT * FROM continuity_meta WHERE singleton=1");
          if (meta?.root_id !== rootId || meta.scope_id !== scopeId) return failContinuity("scope_mismatch");
          if ((await existing.first("PRAGMA journal_mode"))?.journal_mode !== "delete") return failContinuity("schema_mismatch");
          const previous = version?.user_version;
          if (previous !== meta.version || ![1, 2, 3, CONTINUITY_DB_VERSION].includes(Number(previous))) return failContinuity("schema_mismatch");
          const migrated = previous !== CONTINUITY_DB_VERSION;
          if (migrated) {
            if (previous === 1) await existing.run("ALTER TABLE operations ADD COLUMN request_json TEXT");
            if (Number(previous) < 3) await existing.run("ALTER TABLE operations ADD COLUMN result_json TEXT");
            await existing.run(CONTINUITY_WORKFLOW_SCHEMA);
            await existing.run("CREATE INDEX IF NOT EXISTS operation_agent_state ON operations(agent_id,state)");
            await existing.run(`UPDATE continuity_meta SET version=${CONTINUITY_DB_VERSION} WHERE singleton=1; PRAGMA user_version=${CONTINUITY_DB_VERSION};`);
          } else await checkDb(existing);
          await hooks.beforeCommit?.("initialize-schema"); committing = true; await existing.run("COMMIT");
          await hooks.afterCommit?.("initialize-schema");
          return { initialized: true, created: false, ...(migrated ? { migrated: true } : {}) };
        } catch (cause) {
          await existing.run("ROLLBACK").catch(() => undefined);
          if (committing) return failContinuity("commit_unknown"); throw cause;
        }
      }));
    }
    const db = yield* Effect.acquireRelease(Effect.uninterruptible(continuityIo(() => openMonitorSqlite(file, "create"))), close);
    yield* Effect.uninterruptible(continuityIo(async () => {
      await db.run(`PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA max_page_count=${policy.maxMetadataBytes / 4096}; BEGIN IMMEDIATE;`);
      try {
        await db.run(SCHEMA);
        await db.run("INSERT INTO continuity_meta VALUES(1,?,?,?)", [CONTINUITY_DB_VERSION, rootId, scopeId]);
        await db.run(`PRAGMA user_version=${CONTINUITY_DB_VERSION}; COMMIT;`);
        await syncContinuityDirectory(directory); await syncContinuityDirectory(resolve(root)); await checkDb(db);
      } catch (e) { await db.run("ROLLBACK").catch(() => undefined); throw e; }
    }));
    return { initialized: true, created: true };
  }));
  return { directory, file, initialize,
    read: <A>(body: (db: MonitorSqlite) => Promise<A>) => transaction("read", false, body),
    write: <A>(label: string, body: (db: MonitorSqlite) => Promise<A>) => transaction(label, true, body),
    metadataRoom: async (db: MonitorSqlite, bytes: number) => {
      const pages = Number((await db.first("PRAGMA page_count"))?.page_count), free = Number((await db.first("PRAGMA freelist_count"))?.freelist_count);
      if (!Number.isSafeInteger(pages) || !Number.isSafeInteger(free) || (pages - free) * 4096 + bytes + 16384 > policy.maxMetadataBytes) return failContinuity("capacity");
    },
  };
}

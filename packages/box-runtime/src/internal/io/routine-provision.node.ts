import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ROUTINE_PROVISION_POLICY, RoutineProvisionError, provisionOperationId, routineAgentId, routineId, routineRevision,
  type ProvisionRecord, type ProvisionRetired, type ProvisionBinding, type ProvisionReservation } from "@grokbox/runtime-kernel/routines";
import { assertSafeDirectory } from "./config-layout.node.ts";
import { monitorProcessIdentity } from "./monitor-owner.node.ts";
import { openMonitorSqlite, type MonitorSqlite, type SqlRow } from "./monitor-sqlite.node.ts";

// Reuse only the portable SQL driver, not monitor initialization or retention.
// This is the scoped provision replay guard required by T53. Diagnostic TTL
// and GC must never erase it. No prompt, credential or network response stored.
const APPLICATION_ID = 1196576848;
const VERSION = 3;
const RETIRED_DDL = "CREATE TABLE operation_tombstones(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(agent_id,operation_id));";
const STATE_DDL = `CREATE TABLE state_operations(operation_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,native_id TEXT NOT NULL,action TEXT NOT NULL,
 fingerprint TEXT NOT NULL,before_revision TEXT NOT NULL,definition_revision TEXT NOT NULL,generation TEXT NOT NULL,
 state TEXT NOT NULL,after_revision TEXT,evidence TEXT NOT NULL,created_at INTEGER NOT NULL,owner_pid INTEGER NOT NULL,owner_start TEXT NOT NULL);
 CREATE UNIQUE INDEX unresolved_routine_state ON state_operations(agent_id,native_id) WHERE state IN ('attempting','unknown');`;
const DDL = `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};
CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root_id TEXT NOT NULL);
CREATE TABLE operations(agent_id TEXT NOT NULL,operation_id TEXT NOT NULL,managed_key TEXT NOT NULL,fingerprint TEXT NOT NULL,desired_digest TEXT NOT NULL,
 action TEXT NOT NULL,state TEXT NOT NULL,native_id TEXT,observed_revision TEXT,before_revision TEXT,created_at INTEGER NOT NULL,owner_pid INTEGER NOT NULL,owner_start TEXT NOT NULL,
 PRIMARY KEY(agent_id,operation_id));
CREATE UNIQUE INDEX unresolved_key ON operations(agent_id,managed_key) WHERE state IN ('attempting','unknown');
CREATE TABLE bindings(agent_id TEXT NOT NULL,managed_key TEXT NOT NULL,native_id TEXT NOT NULL,revision TEXT NOT NULL,operation_id TEXT NOT NULL,
 PRIMARY KEY(agent_id,managed_key),UNIQUE(agent_id,native_id));${RETIRED_DDL}${STATE_DDL}`;
const missing = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const fail = (reason: ConstructorParameters<typeof RoutineProvisionError>[0]): never => { throw new RoutineProvisionError(reason); };
const key = (v: unknown): string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v) ? v : fail("ledger_unavailable");
function parse(r: SqlRow): ProvisionRecord {
  if (!["create", "update"].includes(String(r.action)) || !["attempting", "unknown", "observed"].includes(String(r.state))
    || !Number.isSafeInteger(r.created_at) || Number(r.created_at) < 1) return fail("ledger_unavailable");
  return { schemaVersion: 1, agentId: routineAgentId(r.agent_id), operationId: provisionOperationId(r.operation_id), key: key(r.managed_key),
    fingerprint: routineRevision(r.fingerprint), desiredDigest: routineRevision(r.desired_digest), action: r.action as "create" | "update",
    state: r.state as ProvisionRecord["state"], nativeId: r.native_id === null ? null : routineId(r.native_id),
    observedRevision: r.observed_revision === null ? null : routineRevision(r.observed_revision),
    beforeRevision: r.before_revision === null ? null : routineRevision(r.before_revision), createdAtMs: Number(r.created_at) };
}
function retired(r: SqlRow, agentId: string, operationId: string): ProvisionRetired {
  return { schemaVersion: 1, agentId: routineAgentId(agentId), operationId: provisionOperationId(operationId), fingerprint: routineRevision(r.fingerprint), state: "retired" };
}
async function tombstone(db: MonitorSqlite, agentId: string, operationId: string) {
  return db.first("SELECT fingerprint FROM operation_tombstones WHERE agent_id=? AND operation_id=?", [agentId, operationId]);
}
async function retireSuperseded(db: MonitorSqlite) {
  const rows = await db.all(`SELECT o.agent_id,o.operation_id,o.fingerprint FROM operations o WHERE o.state='observed'
    AND NOT EXISTS(SELECT 1 FROM bindings b WHERE b.agent_id=o.agent_id AND b.operation_id=o.operation_id) LIMIT 32`);
  for (const r of rows) {
    await db.run("INSERT INTO operation_tombstones VALUES(?,?,?)", [String(r.agent_id), String(r.operation_id), String(r.fingerprint)]);
    await db.run("DELETE FROM operations WHERE agent_id=? AND operation_id=?", [String(r.agent_id), String(r.operation_id)]);
  }
  return rows.length;
}
function binding(r: SqlRow | null): ProvisionBinding | null {
  return r ? { key: key(r.managed_key), routineId: routineId(r.native_id), revision: routineRevision(r.revision), operationId: provisionOperationId(r.operation_id) } : null;
}
export type RoutineStateRecord = {
  operationId: string; agentId: string; nativeId: string; action: "enable" | "disable" | "delete";
  fingerprint: string; beforeRevision: string; definitionRevision: string; generation: string;
  state: "attempting" | "unknown" | "observed"; afterRevision: string | null;
  evidence: "not-verified" | "requested-state-observed" | "absent-in-returned-window"; createdAtMs: number;
};
function stateRecord(row: SqlRow): RoutineStateRecord {
  if (!["enable", "disable", "delete"].includes(String(row.action)) || !["attempting", "unknown", "observed"].includes(String(row.state))
    || !["not-verified", "requested-state-observed", "absent-in-returned-window"].includes(String(row.evidence))
    || !Number.isSafeInteger(row.created_at) || Number(row.created_at) < 1) return fail("ledger_unavailable");
  return { operationId: provisionOperationId(row.operation_id), agentId: routineAgentId(row.agent_id), nativeId: routineId(row.native_id),
    action: row.action as RoutineStateRecord["action"], fingerprint: routineRevision(row.fingerprint), beforeRevision: routineRevision(row.before_revision),
    definitionRevision: routineRevision(row.definition_revision), generation: routineRevision(row.generation), state: row.state as RoutineStateRecord["state"],
    afterRevision: row.after_revision === null ? null : routineRevision(row.after_revision), evidence: row.evidence as RoutineStateRecord["evidence"], createdAtMs: Number(row.created_at) };
}
export type ProvisionStoreHooks = { afterReserve?: () => void; beforeFinish?: () => void; afterFinish?: () => void };
export function openRoutineProvisionStore(durableRoot: string, hooks: ProvisionStoreHooks = {}) {
  const root = resolve(durableRoot), directory = join(root, "state", "routine-provision"), path = join(directory, "operations.sqlite");
  const rootId = sha256Text(canonicalJson(["routine-provision-v1", root]));
  async function connect(write: boolean): Promise<{ db: MonitorSqlite; initializing: boolean } | null> {
    const found = await lstat(path).catch(e => { if (missing(e)) return null; throw e; });
    const existingDirectory = await lstat(directory).catch(e => { if (missing(e)) return null; throw e; });
    if (!found && existingDirectory) return fail("ledger_unavailable");
    if (!write && !found) return null;
    await assertSafeDirectory(root, write); await assertSafeDirectory(join(root, "state"), write);
    let initializing = false;
    if (!found) {
      // Only the process winning the first private directory creation may
      // initialize its empty file. Existing/missing/truncated stores are never
      // silently reset; interrupted first initialization is an explicit blocker.
      await mkdir(directory, { mode: 0o700 }); initializing = true;
      const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await f.sync(); } finally { await f.close(); }
    }
    await assertSafeDirectory(directory);
    return { db: await openMonitorSqlite(path, write ? "write" : "read"), initializing };
  }
  async function transaction<T>(write: boolean, action: (db: MonitorSqlite | null) => Promise<T>): Promise<T> {
    let db: MonitorSqlite | null = null, committed = false, commitStarted = false;
    try {
      const connected = await connect(write); db = connected?.db ?? null; if (!db) return await action(null);
      if (write) {
        if ((await lstat(path)).size > ROUTINE_PROVISION_POLICY.maxDatabaseBytes) return fail("capacity");
        const page = Number(Object.values((await db.first("PRAGMA page_size"))!)[0]);
        if (!Number.isSafeInteger(page) || page < 512) return fail("ledger_unavailable");
        await db.run(`PRAGMA max_page_count=${Math.floor(ROUTINE_PROVISION_POLICY.maxDatabaseBytes / page)}`);
      }
      await db.run(write ? "BEGIN IMMEDIATE" : "BEGIN");
      const application = Number(Object.values((await db.first("PRAGMA application_id"))!)[0]);
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      if (write && connected?.initializing && application === 0 && tables.length === 0) {
        await db.run(DDL); await db.run("INSERT INTO meta(singleton,root_id) VALUES(1,?)", [rootId]);
      } else if (application !== APPLICATION_ID || (await db.first("PRAGMA user_version"))?.user_version !== VERSION
        || (await db.first("SELECT root_id FROM meta WHERE singleton=1"))?.root_id !== rootId) return fail("ledger_unavailable");
      // Both reads and mutations consume only the current safety ledger.
      // Missing old tables never mean an operation was not dispatched.
      const result = await action(db);
      commitStarted = write;
      await db.run("COMMIT"); committed = true;
      if (write) { const d = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await d.sync(); } finally { await d.close(); } }
      return result;
    } catch (e) {
      if (!committed) await db?.run("ROLLBACK").catch(() => undefined);
      if (commitStarted) return fail("outcome_unknown");
      if (e instanceof RoutineProvisionError) throw e;
      if (e && typeof e === "object" && "code" in e && e.code === "SQLITE_FULL") return fail("capacity");
      return fail("ledger_unavailable");
    } finally { await db?.close(); }
  }
  const read = (agentId: string, operationId: string) => transaction(false, async db => {
    routineAgentId(agentId); provisionOperationId(operationId);
    const r = await db?.first("SELECT * FROM operations WHERE agent_id=? AND operation_id=?", [agentId, operationId]);
    if (r) return parse(r);
    const t = db ? await tombstone(db, agentId, operationId) : null;
    return t ? retired(t, agentId, operationId) : null;
  });
  return { path, read,
    stateRecord: (agentId: string, operationId: string) => transaction(false, async db => {
      routineAgentId(agentId); provisionOperationId(operationId);
      if (!db) return null;
      const row = await db.first("SELECT * FROM state_operations WHERE agent_id=? AND operation_id=?", [agentId, operationId]);
      return row ? stateRecord(row) : null;
    }),
    reserveState: async (input: Omit<RoutineStateRecord, "state" | "afterRevision" | "evidence">) => {
      const owner = await monitorProcessIdentity(process.pid);
      if (owner.state !== "present") return fail("ledger_unavailable");
      routineAgentId(input.agentId); routineId(input.nativeId); provisionOperationId(input.operationId); routineRevision(input.fingerprint);
      routineRevision(input.beforeRevision); routineRevision(input.definitionRevision); routineRevision(input.generation);
      if (!["enable", "disable", "delete"].includes(input.action) || !Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 1) return fail("invalid_input");
      return transaction(true, async db => {
        if (!db) return fail("ledger_unavailable");
        const prior = await db.first("SELECT * FROM state_operations WHERE operation_id=?", [input.operationId]);
        if (prior) {
          const record = stateRecord(prior);
          if (record.fingerprint !== input.fingerprint || record.agentId !== input.agentId) return fail("operation_conflict");
          return { dispatch: false, record };
        }
        if (await db.first("SELECT 1 FROM operations WHERE agent_id=? AND operation_id=?", [input.agentId, input.operationId]) || await tombstone(db, input.agentId, input.operationId)) return fail("operation_conflict");
        if (await db.first("SELECT 1 FROM state_operations WHERE agent_id=? AND native_id=? AND state IN ('attempting','unknown')", [input.agentId, input.nativeId])
          || await db.first("SELECT 1 FROM operations WHERE agent_id=? AND native_id=? AND state IN ('attempting','unknown')", [input.agentId, input.nativeId])) return fail("key_busy");
        if (Number((await db.first("SELECT COUNT(*) AS n FROM state_operations"))?.n) >= ROUTINE_PROVISION_POLICY.maxOperations) return fail("capacity");
        await db.run("INSERT INTO state_operations VALUES(?,?,?,?,?,?,?,?,'attempting',NULL,'not-verified',?,?,?)", [input.operationId,input.agentId,input.nativeId,input.action,input.fingerprint,input.beforeRevision,input.definitionRevision,input.generation,input.createdAtMs,process.pid,owner.start]);
        return { dispatch: true, record: { ...input, state: "attempting" as const, afterRevision: null, evidence: "not-verified" as const } };
      });
    },
    settleState: (record: RoutineStateRecord, afterRevision: string | null, evidence: "requested-state-observed" | "absent-in-returned-window") => transaction(true, async db => {
      if (!db) return fail("ledger_unavailable");
      if (afterRevision !== null) routineRevision(afterRevision);
      const row = await db.first("SELECT * FROM state_operations WHERE agent_id=? AND operation_id=?", [record.agentId, record.operationId]);
      if (!row) return fail("not_recorded");
      const current = stateRecord(row);
      if (current.fingerprint !== record.fingerprint || (current.state === "observed" && (current.afterRevision !== afterRevision || current.evidence !== evidence))) return fail("operation_conflict");
      await db.run("UPDATE state_operations SET state='observed',after_revision=?,evidence=? WHERE operation_id=?", [afterRevision,evidence,record.operationId]);
      return { ...current, state: "observed" as const, afterRevision, evidence };
    }),
    markStateUnknown: (record: RoutineStateRecord) => transaction(true, async db => {
      if (!db) return fail("ledger_unavailable");
      await db.run("UPDATE state_operations SET state='unknown' WHERE operation_id=? AND fingerprint=? AND state='attempting'", [record.operationId,record.fingerprint]);
    }),
    status: () => transaction(false, async db => {
      const common = { owner: "routine_provision", diagnosticGcAllowed: false, maxOperations: ROUTINE_PROVISION_POLICY.maxOperations,
        maxMainFileBytes: ROUTINE_PROVISION_POLICY.maxDatabaseBytes, replaySafeRetirement: "superseded-observed-to-exact-tombstone" } as const;
      if (!db) return { ...common, state: "not_initialized", operations: null, unresolved: null, fileBytes: null };
      const count = await db.first("SELECT COUNT(*) AS n, COALESCE(SUM(state IN ('attempting','unknown')),0) AS pending FROM operations");
      const file = await lstat(path);
      const retiredOperations = Number((await db.first("SELECT COUNT(*) AS n FROM operation_tombstones"))?.n);
      return { ...common, state: "measured", retiredOperations, operations: Number(count?.n), unresolved: Number(count?.pending), fileBytes: file.size,
        allocatedBytes: file.blocks * 512, diagnosticBudgetIncluded: false };
    }),
    binding: (agentId: string, managedKey: string) => transaction(false, async db => {
      routineAgentId(agentId); key(managedKey);
      return binding(await db?.first("SELECT * FROM bindings WHERE agent_id=? AND managed_key=?", [agentId, managedKey]) ?? null);
    }),
    reserve: async (input: ProvisionReservation) => {
      routineAgentId(input.agentId); provisionOperationId(input.operationId); key(input.key); routineRevision(input.fingerprint); routineRevision(input.desiredDigest);
      if (!["create", "update"].includes(input.action) || !Number.isSafeInteger(input.atMs) || input.atMs < 1) return fail("invalid_input");
      const owner = await monitorProcessIdentity(process.pid);
      if (owner.state !== "present") return fail("ledger_unavailable");
      const result = await transaction(true, async db => {
        if (!db) return fail("ledger_unavailable");
        const prior = await db.first("SELECT * FROM operations WHERE agent_id=? AND operation_id=?", [input.agentId, input.operationId]);
        if (prior) { const record = parse(prior); if (record.fingerprint !== input.fingerprint) return fail("operation_conflict"); return { dispatch: false, record }; }
        if (await tombstone(db, input.agentId, input.operationId) || await db.first("SELECT 1 FROM state_operations WHERE operation_id=?", [input.operationId])) return fail("operation_conflict");
        if (input.binding && await db.first("SELECT 1 FROM state_operations WHERE agent_id=? AND native_id=? AND state IN ('attempting','unknown')", [input.agentId,input.binding.routineId])) return fail("key_busy");
        await retireSuperseded(db);
        if (await db.first("SELECT 1 FROM operations WHERE agent_id=? AND managed_key=? AND state IN ('attempting','unknown')", [input.agentId, input.key])) return fail("key_busy");
        const current = binding(await db.first("SELECT * FROM bindings WHERE agent_id=? AND managed_key=?", [input.agentId, input.key]));
        if (canonicalJson(current) !== canonicalJson(input.binding) || input.action === "create" && current !== null || input.action === "update" && current === null) return fail("revision_conflict");
        if (Number((await db.first("SELECT COUNT(*) AS n FROM operations"))?.n) >= ROUTINE_PROVISION_POLICY.maxOperations) return fail("capacity");
        await db.run("INSERT INTO operations VALUES(?,?,?,?,?,?,'attempting',?,NULL,?,?,?,?)", [input.agentId, input.operationId, input.key, input.fingerprint, input.desiredDigest,
          input.action, input.binding?.routineId ?? null, input.binding?.revision ?? null, input.atMs, process.pid, owner.start]);
        return { dispatch: true, record: parse((await db.first("SELECT * FROM operations WHERE agent_id=? AND operation_id=?", [input.agentId, input.operationId]))!) };
      });
      if (result.dispatch) hooks.afterReserve?.(); return result;
    },
    reconcileRecord: (agentId: string, operationId: string) => transaction(true, async db => {
      routineAgentId(agentId); provisionOperationId(operationId);
      const row = await db?.first("SELECT * FROM operations WHERE agent_id=? AND operation_id=?", [agentId, operationId]);
      if (!row || !db) return fail("not_recorded");
      const record = parse(row);
      if (record.state !== "attempting") return record;
      const live = await monitorProcessIdentity(Number(row.owner_pid));
      if (!(live.state === "missing" || live.state === "present" && live.start !== row.owner_start)) return fail("key_busy");
      await db.run("UPDATE operations SET state='unknown' WHERE agent_id=? AND operation_id=? AND state='attempting'", [agentId, operationId]);
      return { ...record, state: "unknown" as const };
    }),
    markUnknown: (agentId: string, operationId: string) => transaction(true, async db => {
      if (!db) return fail("ledger_unavailable");
      await db.run("UPDATE operations SET state='unknown' WHERE agent_id=? AND operation_id=? AND state='attempting'", [routineAgentId(agentId), provisionOperationId(operationId)]);
    }),
    finish: async (record: ProvisionRecord, nativeId: string, revision: string) => {
      routineId(nativeId); routineRevision(revision);
      hooks.beforeFinish?.();
      const result = await transaction(true, async db => {
        if (!db) return fail("ledger_unavailable");
        const row = await db.first("SELECT * FROM operations WHERE agent_id=? AND operation_id=?", [record.agentId, record.operationId]);
        if (!row) return fail("not_recorded"); const current = parse(row);
        if (current.fingerprint !== record.fingerprint || current.nativeId !== null && current.nativeId !== nativeId) return fail("operation_conflict");
        if (current.state === "observed") {
          if (current.nativeId !== nativeId || current.observedRevision !== revision) return fail("operation_conflict"); return current;
        }
        const prior = binding(await db.first("SELECT * FROM bindings WHERE agent_id=? AND managed_key=?", [record.agentId, record.key]));
        if (current.action === "create" ? prior !== null : prior?.routineId !== current.nativeId || prior?.revision !== current.beforeRevision) return fail("revision_conflict");
        const other = await db.first("SELECT managed_key FROM bindings WHERE agent_id=? AND native_id=?", [record.agentId, nativeId]);
        if (other && other.managed_key !== record.key) return fail("operation_conflict");
        await db.run("INSERT INTO bindings VALUES(?,?,?,?,?) ON CONFLICT(agent_id,managed_key) DO UPDATE SET native_id=excluded.native_id,revision=excluded.revision,operation_id=excluded.operation_id",
          [record.agentId, record.key, nativeId, revision, record.operationId]);
        await db.run("UPDATE operations SET state='observed',native_id=?,observed_revision=? WHERE agent_id=? AND operation_id=?", [nativeId, revision, record.agentId, record.operationId]);
        return { ...current, state: "observed" as const, nativeId, observedRevision: revision };
      });
      hooks.afterFinish?.(); return result;
    },
  };
}
export type RoutineProvisionStore = ReturnType<typeof openRoutineProvisionStore>;

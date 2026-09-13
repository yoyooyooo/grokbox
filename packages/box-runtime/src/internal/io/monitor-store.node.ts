import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire as observationRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database } from "sql.js/dist/sql-asm.js";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { MONITOR_POLICY, MONITOR_RULES, confirmedObservation, monitorFreshness, monitorScope, monitorTargets, monitorUuid,
  type MonitorRule, type MonitorSample } from "@grokbox/runtime-kernel/monitor";
import { acquireExclusiveLock } from "./op-lock.ts";

/* SQLite's portable asm build works on the existing Node20 contract. This is a
 * bounded snapshot adapter, not WAL: every mutating command opens the latest
 * image under a short exclusive writer lock and fsync+renames a complete image.
 * No in-memory DB is kept across a commit. No native ABI or WASM asset is shipped.
 * Larger histories need a qualified disk-VFS adapter, not an unbounded export. */
const engine = () => {
  if (enginePromise) return enginePromise;
  const filename = fileURLToPath(import.meta.url);
  const published = basename(filename) === "index.js" && basename(dirname(filename)) === "dist";
  // Keep the large CJS engine out of ordinary CLI/Host loading. Published code
  // loads only its packaged companion, never an arbitrary NODE_PATH fallback.
  const initialize = observationRequire(import.meta.url)(published ? "./observation-sqlite.cjs" : "sql.js/dist/sql-asm.js") as typeof initSqlJs;
  return enginePromise = initialize({ printErr: () => {} });
};
let enginePromise: ReturnType<typeof initSqlJs> | undefined;
const VERSION = 1;
const HEADER = "SQLite format 3\u0000";
const error = (message: string) => new BoxRuntimeError("invalid_usage", message);
type Row = Record<string, string | number | null | Uint8Array>;
const query = (db: Database, sql: string, params: Array<string | number | null> = []): Row[] => {
  const statement = db.prepare(sql, params), rows: Row[] = [];
  try { while (statement.step()) rows.push(statement.getAsObject()); }
  finally { statement.free(); }
  return rows;
};
const first = (db: Database, sql: string, params: Array<string | number | null> = []): Row | null => query(db, sql, params)[0] ?? null;
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw error("monitor_store_invalid");
  return value;
};
const uuid = (value: unknown): string => { if (!monitorUuid(value)) throw error("monitor_store_invalid"); return value; };
const scope = (value: unknown): string => { if (!monitorScope(value)) throw error("monitor_store_invalid"); return value; };
const nullableTime = (v: unknown) => v === null ? null : number(v);
const harness = (v: unknown): "box" | "temporal" | null => {
  if (v !== null && v !== "box" && v !== "temporal") throw error("monitor_store_invalid"); return v;
};
const rule = (v: unknown): MonitorRule => {
  if (!(MONITOR_RULES as readonly unknown[]).includes(v)) throw error("monitor_store_invalid"); return v as MonitorRule;
};
const missing = (e: unknown) => e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
const SCHEMA = `
PRAGMA user_version=1;
CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, database_id TEXT NOT NULL,
 root_id TEXT NOT NULL, epoch TEXT, running INTEGER NOT NULL DEFAULT 0, current_scope TEXT, gateway_epoch TEXT,
 heartbeat INTEGER, last_number INTEGER NOT NULL DEFAULT 0, last_sample_id TEXT, last_digest TEXT);
CREATE TABLE watched (agent_id TEXT PRIMARY KEY);
CREATE TABLE observations (scope TEXT NOT NULL, agent_id TEXT NOT NULL, state TEXT NOT NULL, server_id TEXT,
 server_harness TEXT, local_harness TEXT, last_attempt INTEGER NOT NULL, last_success INTEGER, latest_success INTEGER NOT NULL,
 PRIMARY KEY(scope,agent_id));
CREATE TABLE incidents (id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT, rule TEXT NOT NULL, status TEXT NOT NULL,
 first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, resolved_at INTEGER, revision INTEGER NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0, snooze_until INTEGER);
CREATE UNIQUE INDEX one_open_incident ON incidents(scope,COALESCE(agent_id,''),rule) WHERE status='open';
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, epoch TEXT NOT NULL,
 kind TEXT NOT NULL, scope TEXT NOT NULL, agent_id TEXT, incident_id TEXT, at_ms INTEGER NOT NULL,
 before_harness TEXT, after_harness TEXT, interval_start INTEGER);
CREATE TABLE management (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, incident_id TEXT NOT NULL,
 revision INTEGER NOT NULL, action TEXT NOT NULL);
`;
export type MonitorStoreOptions = {
  /** Narrow fault injection at the persistence boundary, not a live CLI option. */
  beforePublish?: () => void;
  afterRename?: () => void;
};
export function openMonitorStore(root: string, options: MonitorStoreOptions = {}) {
  const rootId = sha256Text(canonicalJson(["grokbox-observability-v1", resolve(root)]));
  const directory = join(resolve(root), "observability"), file = join(directory, "observations.sqlite");
  async function checkDirectory(create: boolean) {
    if (create) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const parent = await lstat(root);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw error("monitor_path_unsafe");
      await mkdir(directory, { mode: 0o700 }).catch(e => { if (!e || e.code !== "EEXIST") throw e; });
    }
    const info = await lstat(directory).catch(e => { throw error(missing(e) ? "monitor_not_initialized" : "monitor_path_unavailable"); });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw error("monitor_path_unsafe");
  }
  async function load(): Promise<Database> {
    await checkDirectory(false);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(e => { throw error(missing(e) ? "monitor_not_initialized" : "monitor_store_unavailable"); });
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > MONITOR_POLICY.maxDbBytes
        || (process.getuid && stat.uid !== process.getuid())) throw error("monitor_store_unsafe_or_capacity");
      bytes = Buffer.alloc(stat.size + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== stat.size || bytes.subarray(0,16).toString() !== HEADER) throw error("monitor_store_invalid");
      bytes = bytes.subarray(0, stat.size);
    } finally { await handle.close(); }
    let db: Database | undefined;
    try {
      const SQL = await engine(); db = new SQL.Database(bytes);
      const meta = first(db, "SELECT * FROM meta WHERE singleton=1");
      if (!meta || meta.version !== VERSION || meta.root_id !== rootId || !monitorUuid(meta.database_id)) throw error("monitor_store_schema_or_root_mismatch");
      return db;
    } catch (e) { db?.close(); throw e instanceof BoxRuntimeError ? e : error("monitor_store_invalid"); }
  }
  async function publish(db: Database) {
    const bytes = db.export();
    if (bytes.length > MONITOR_POLICY.maxDbBytes) throw error("monitor_store_capacity");
    const temp = join(directory, `.observations-${randomUUID()}.tmp`);
    let published = false;
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      options.beforePublish?.();
      await rename(temp, file); published = true;
      options.afterRename?.();
      const dir = await open(directory, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (e) {
      if (!published) await unlink(temp).catch(() => {});
      throw error(published ? "monitor_commit_unknown" : e instanceof BoxRuntimeError ? e.message : "monitor_commit_failed");
    }
  }
  async function mutate<T>(f: (db: Database) => T): Promise<T> {
    await checkDirectory(false);
    const held = await acquireExclusiveLock(join(directory, "writer.lock"));
    if (!held.ok) throw error("monitor_writer_busy");
    let db: Database | undefined;
    try {
      db = await load(); db.run("BEGIN IMMEDIATE");
      const result = f(db);
      db.run("COMMIT"); await publish(db);
      return result;
    } catch (e) { throw e instanceof BoxRuntimeError ? e : error("monitor_transaction_failed"); }
    finally { db?.close(); await held.lock.release(); }
  }
  function meta(db: Database): Row { const row = first(db,"SELECT * FROM meta WHERE singleton=1"); if (!row) throw error("monitor_store_invalid"); return row; }
  function event(db: Database, epoch: string, kind: string, sid: string, agentId: string | null, at: number,
    incidentId: string | null = null, before: "box"|"temporal"|null = null, after: "box"|"temporal"|null = null, from: number|null = null) {
    const count = number(first(db,"SELECT COUNT(*) AS n FROM events")?.n);
    if (count >= MONITOR_POLICY.maxEvents) throw error("monitor_retention_required");
    db.run("INSERT INTO events(id,epoch,kind,scope,agent_id,incident_id,at_ms,before_harness,after_harness,interval_start) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [randomUUID(),epoch,kind,sid,agentId,incidentId,at,before,after,from]);
  }
  function incident(db: Database, epoch: string, sid: string, agentId: string|null, key: MonitorRule, active: boolean, at: number) {
    const row = first(db,"SELECT * FROM incidents WHERE scope=? AND agent_id IS ? AND rule=? AND status='open'",[sid,agentId,key]);
    if (active && row) { db.run("UPDATE incidents SET last_seen=? WHERE id=?",[at,uuid(row.id)]); return; }
    if (active) {
      const id = randomUUID();
      db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision) VALUES(?,?,?,?,'open',?,?,1)",[id,sid,agentId,key,at,at]);
      event(db,epoch,"incident_opened",sid,agentId,at,id); return;
    }
    if (row) {
      db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=?,revision=revision+1 WHERE id=?",[at,at,uuid(row.id)]);
      event(db,epoch,"incident_resolved",sid,agentId,at,uuid(row.id));
    }
  }
  function getIncident(row: Row) {
    if (row.status !== "open" && row.status !== "resolved") throw error("monitor_store_invalid");
    return { id: uuid(row.id), scopeId: scope(row.scope), agentId: row.agent_id === null ? null : uuid(row.agent_id), rule: rule(row.rule),
      status: row.status, firstSeenAtMs: number(row.first_seen), lastSeenAtMs: number(row.last_seen), resolvedAtMs: nullableTime(row.resolved_at),
      revision: number(row.revision), acknowledged: number(row.acknowledged) === 1, snoozeUntilMs: nullableTime(row.snooze_until) };
  }
  function getEvent(row: Row) {
    const allowed = ["collector_started","observation_gap","collector_stopped","scope_changed","ownership_changed","incident_opened","incident_resolved","incident_ack","incident_snooze"];
    if (!allowed.includes(String(row.kind))) throw error("monitor_store_invalid");
    return { seq: number(row.seq), eventId: uuid(row.id), collectorEpoch: uuid(row.epoch), kind: row.kind, scopeId: scope(row.scope),
      agentId: row.agent_id === null ? null : uuid(row.agent_id), incidentId: row.incident_id === null ? null : uuid(row.incident_id),
      observedAtMs: number(row.at_ms), previousHarness: harness(row.before_harness), currentHarness: harness(row.after_harness),
      observationIntervalStartMs: nullableTime(row.interval_start) };
  }
  const lastSequence = (db: Database) => number(first(db,"SELECT COALESCE(MAX(seq),0) AS n FROM events")?.n);
  return {
    path: file,
    async initialize() {
      await checkDirectory(true);
      const held = await acquireExclusiveLock(join(directory,"writer.lock"));
      if (!held.ok) throw error("monitor_writer_busy");
      let db: Database | undefined;
      try {
        const existing = await lstat(file).catch(e => { if (!missing(e)) throw e; return null; });
        if (existing) { db = await load(); return { databaseId: uuid(meta(db).database_id), created: false }; }
        const SQL = await engine(); db = new SQL.Database();
        db.run(SCHEMA); const databaseId = randomUUID();
        db.run("INSERT INTO meta(singleton,version,database_id,root_id) VALUES(1,?,?,?)",[VERSION,databaseId,rootId]);
        await publish(db); return { databaseId, created: true };
      } finally { db?.close(); await held.lock.release(); }
    },
    async begin(epoch: string, at: number, agentIds: string[]) {
      if (!monitorUuid(epoch) || number(at) === 0) throw error("monitor_invalid_epoch");
      const ids = monitorTargets(agentIds);
      return mutate(db => {
        const previous = meta(db), oldAt = nullableTime(previous.heartbeat);
        db.run("DELETE FROM watched");
        for (const id of ids) db.run("INSERT INTO watched(agent_id) VALUES(?)",[id]);
        db.run("UPDATE observations SET latest_success=0");
        db.run("UPDATE meta SET epoch=?,running=1,heartbeat=?,last_number=0,last_sample_id=NULL,last_digest=NULL WHERE singleton=1",[epoch,at]);
        event(db,epoch,previous.epoch === null ? "collector_started" : "observation_gap",rootId,null,at,null,null,null,oldAt);
        return { collectorEpoch: epoch, previousHeartbeatMs: oldAt, gap: previous.epoch !== null };
      });
    },
    async finish(epoch: string, at: number) {
      return mutate(db => {
        if (meta(db).epoch !== epoch) throw error("monitor_epoch_changed");
        db.run("UPDATE meta SET running=0,heartbeat=? WHERE singleton=1",[number(at)]);
        event(db,epoch,"collector_stopped",rootId,null,at); return { stopped: true };
      });
    },
    async record(epoch: string, sampleNumber: number, sample: MonitorSample) {
      if (!monitorUuid(epoch) || !monitorUuid(sample.sampleId) || !Number.isSafeInteger(sampleNumber) || sampleNumber < 1
        || !Array.isArray(sample.agents) || sample.agents.length > MONITOR_POLICY.maxTargets
        || !Number.isSafeInteger(sample.startedAtMs) || sample.startedAtMs < 1 || sample.completedAtMs < sample.startedAtMs) throw error("monitor_invalid_sample");
      return mutate(db => {
        const current = meta(db), digest = sha256Text(canonicalJson(sample));
        if (current.epoch !== epoch || current.running !== 1) throw error("monitor_epoch_changed");
        if (sampleNumber === current.last_number && sample.sampleId === current.last_sample_id && digest === current.last_digest) return { duplicate: true, sampleNumber, events: [] as ReturnType<typeof getEvent>[] };
        const previousSeq = lastSequence(db);
        if (sampleNumber !== number(current.last_number) + 1 || sample.completedAtMs < number(current.heartbeat)) throw error("monitor_stale_sample");
        const at = number(sample.completedAtMs);
        if (sample.failure || !sample.scopeId) {
          incident(db,epoch,rootId,null,"observation_unavailable",true,at);
          db.run("UPDATE observations SET latest_success=0,last_attempt=? WHERE scope IS ?",[at,current.current_scope]);
        } else {
          const expectedIds = query(db,"SELECT agent_id FROM watched ORDER BY agent_id").map(row => uuid(row.agent_id));
          if (canonicalJson(sample.agents.map(row => row.agentId).sort()) !== canonicalJson(expectedIds)) throw error("monitor_incomplete_sample");
          const sid = scope(sample.scopeId), serverAt = number(sample.serverObservedAtMs);
          if (serverAt > at || serverAt < sample.startedAtMs - MONITOR_POLICY.readTimeoutMs || at - serverAt > MONITOR_POLICY.readTimeoutMs
            || !sample.gatewayEpoch || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,15}$/.test(sample.gatewayEpoch)) throw error("monitor_invalid_sample");
          if (current.current_scope !== null && current.current_scope !== sid) event(db,epoch,"scope_changed",sid,null,at);
          db.run("UPDATE meta SET current_scope=?,gateway_epoch=? WHERE singleton=1",[sid,sample.gatewayEpoch]);
          incident(db,epoch,rootId,null,"observation_unavailable",false,at);
          for (const row of sample.agents) {
            if (!monitorUuid(row.agentId) || !first(db,"SELECT agent_id FROM watched WHERE agent_id=?",[row.agentId])
              || !["confirmed_box","confirmed_temporal","conflict","unconfirmed"].includes(row.state)
              || ![null,"box","temporal"].includes(row.serverHarness) || ![null,"box","temporal"].includes(row.localHarness)
              || (row.serverId !== null && (!/^[a-zA-Z0-9-]{1,64}$/.test(row.serverId) || /secret|token|auth|password|api.?key|sk-/i.test(row.serverId)))) throw error("monitor_invalid_sample");
            const previous = first(db,"SELECT * FROM observations WHERE scope=? AND agent_id=?",[sid,row.agentId]);
            const succeeded = confirmedObservation(row);
            if (!succeeded) {
              incident(db,epoch,sid,row.agentId,"observation_unavailable",true,at);
              if (previous) db.run("UPDATE observations SET last_attempt=?,latest_success=0 WHERE scope=? AND agent_id=?",[at,sid,row.agentId]);
              continue;
            }
            if (previous?.last_success !== null && previous?.last_success !== undefined && serverAt < number(previous.last_success)) throw error("monitor_stale_sample");
            const changed = previous !== null && previous.server_harness !== row.serverHarness;
            if (changed) event(db,epoch,"ownership_changed",sid,row.agentId,at,null,harness(previous.server_harness),row.serverHarness,nullableTime(previous.last_success));
            db.run("INSERT INTO observations(scope,agent_id,state,server_id,server_harness,local_harness,last_attempt,last_success,latest_success) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(scope,agent_id) DO UPDATE SET state=excluded.state,server_id=excluded.server_id,server_harness=excluded.server_harness,local_harness=excluded.local_harness,last_attempt=excluded.last_attempt,last_success=excluded.last_success,latest_success=1",
              [sid,row.agentId,row.state,row.serverId,row.serverHarness,row.localHarness,at,serverAt]);
            incident(db,epoch,sid,row.agentId,"observation_unavailable",false,at);
            incident(db,epoch,sid,row.agentId,"ownership_conflict",row.state === "conflict",at);
            incident(db,epoch,sid,row.agentId,"ownership_changed",changed,at);
          }
        }
        db.run("UPDATE meta SET heartbeat=?,last_number=?,last_sample_id=?,last_digest=? WHERE singleton=1",[at,sampleNumber,sample.sampleId,digest]);
        const events = query(db,"SELECT * FROM events WHERE seq>? ORDER BY seq",[previousSeq]).map(getEvent);
        return { duplicate: false, sampleNumber, events };
      });
    },
    async snapshot(now = Date.now()) {
      const db = await load();
      try {
        const current = meta(db), epoch = current.epoch === null ? null : uuid(current.epoch);
        const sid = current.current_scope === null ? null : scope(current.current_scope);
        const rows = query(db,"SELECT w.agent_id AS watched_id,o.* FROM watched w LEFT JOIN observations o ON o.agent_id=w.agent_id AND o.scope IS ? ORDER BY w.agent_id LIMIT 33",[sid]);
        if (rows.length > MONITOR_POLICY.maxTargets) throw error("monitor_target_capacity");
        const cursor = number(first(db,"SELECT COALESCE(MAX(seq),0) AS n FROM events")?.n);
        return { schemaVersion: 1, databaseId: uuid(current.database_id), collectorEpoch: epoch,
          source: "local_observations_not_authority", scopeId: sid, cursor: `${current.database_id}:${epoch ?? "none"}:${cursor}`,
          lastHeartbeatMs: nullableTime(current.heartbeat), collectorRecordedRunning: current.running === 1,
          lastObservedGatewayEpoch: typeof current.gateway_epoch === "string" && /^[1-9][0-9]{0,9}:[1-9][0-9]{0,15}$/.test(current.gateway_epoch) ? current.gateway_epoch : null,
          admissionAuthority: false, productionAccepted: false, notificationMode: "local_only",
          agents: rows.map(row => {
            if (row.state === null) return { agentId: uuid(row.watched_id), lastKnown: null, lastAttemptMs: nullableTime(current.heartbeat), lastSuccessMs: null, freshness: "unavailable" as const };
            if (!["confirmed_box","confirmed_temporal","conflict","unconfirmed"].includes(String(row.state))) throw error("monitor_store_invalid");
            return { agentId: uuid(row.agent_id), lastKnown: { state: row.state, serverHarness: harness(row.server_harness), localHarness: harness(row.local_harness) },
              lastAttemptMs: number(row.last_attempt), lastSuccessMs: nullableTime(row.last_success),
              freshness: monitorFreshness(nullableTime(row.last_success),now,current.running === 1 && row.latest_success === 1) };
          }),
        };
      } finally { db.close(); }
    },
    async incidents() {
      const db = await load();
      try {
        const rows = query(db,"SELECT * FROM incidents ORDER BY first_seen DESC,id LIMIT 201");
        if (rows.length > MONITOR_POLICY.maxPage) throw error("monitor_use_incident_pagination");
        return rows.map(getIncident);
      } finally { db.close(); }
    },
    async incidentPage(after?: string, limit: number = MONITOR_POLICY.maxPage) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MONITOR_POLICY.maxPage) throw error("monitor_invalid_limit");
      const db = await load();
      try {
        const m = meta(db); let before = Number.MAX_SAFE_INTEGER, id = "";
        if (after) {
          const parts = after.split(":");
          if (parts.length !== 5 || parts[0] !== m.database_id || parts[1] !== (m.epoch ?? "none") || parts[2] !== "incidents"
            || !/^[0-9]+$/.test(parts[3]!) || !Number.isSafeInteger(Number(parts[3])) || !monitorUuid(parts[4])) throw error("monitor_cursor_invalid");
          before = Number(parts[3]); id = parts[4]!;
        }
        const rows = query(db,"SELECT * FROM incidents WHERE first_seen<? OR (first_seen=? AND id>?) ORDER BY first_seen DESC,id LIMIT ?",[before,before,id,limit+1]);
        const selected = rows.slice(0,limit).map(getIncident), last = selected.at(-1);
        return { incidents: selected, hasMore: rows.length > limit,
          cursor: last ? `${m.database_id}:${m.epoch ?? "none"}:incidents:${last.firstSeenAtMs}:${last.id}` : after ?? null };
      } finally { db.close(); }
    },
    async events(after?: string, limit: number = MONITOR_POLICY.maxPage) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MONITOR_POLICY.maxPage) throw error("monitor_invalid_limit");
      const db = await load();
      try {
        const m = meta(db); let seq = 0;
        if (after) {
          const parts = after.split(":");
          if (parts.length !== 3 || parts[0] !== m.database_id || parts[1] !== (m.epoch ?? "none") || !/^\d+$/.test(parts[2]!)) throw error("monitor_cursor_invalid");
          seq = Number(parts[2]);
          if (!Number.isSafeInteger(seq) || seq > number(first(db,"SELECT COALESCE(MAX(seq),0) AS n FROM events")?.n)) throw error("monitor_cursor_invalid");
        }
        const rows = query(db,"SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?",[seq,limit+1]);
        const selected = rows.slice(0,limit).map(getEvent);
        return { entries: selected, hasMore: rows.length > limit,
          cursor: `${m.database_id}:${m.epoch ?? "none"}:${selected.at(-1)?.seq ?? seq}` };
      } finally { db.close(); }
    },
    async manage(input: { requestId: string; incidentId: string; expectedRevision: number; action: "ack"|"snooze"; untilMs?: number; nowMs: number }) {
      if (!monitorUuid(input.requestId) || !monitorUuid(input.incidentId) || !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 1 || !["ack","snooze"].includes(input.action)) throw error("monitor_invalid_management");
      if (input.action === "snooze" && (!Number.isSafeInteger(input.untilMs) || input.untilMs! <= input.nowMs || input.untilMs! - input.nowMs > MONITOR_POLICY.maxSnoozeMs)) throw error("monitor_invalid_snooze");
      const fingerprint = sha256Text(canonicalJson([input.incidentId,input.expectedRevision,input.action,input.untilMs ?? null]));
      return mutate(db => {
        const prior = first(db,"SELECT * FROM management WHERE request_id=?",[input.requestId]);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw error("monitor_request_conflict");
          return { requestId: input.requestId, incidentId: uuid(prior.incident_id), appliedRevision: number(prior.revision), duplicate: true, repaired: false };
        }
        const row = first(db,"SELECT * FROM incidents WHERE id=?",[input.incidentId]);
        if (!row) throw error("monitor_incident_not_found");
        if (row.status !== "open") throw error("monitor_incident_resolved");
        if (row.revision !== input.expectedRevision) throw error("monitor_revision_conflict");
        db.run(input.action === "ack" ? "UPDATE incidents SET acknowledged=1,revision=revision+1 WHERE id=?" : "UPDATE incidents SET snooze_until=?,revision=revision+1 WHERE id=?",
          input.action === "ack" ? [input.incidentId] : [input.untilMs!,input.incidentId]);
        const revision = input.expectedRevision + 1;
        db.run("INSERT INTO management(request_id,fingerprint,incident_id,revision,action) VALUES(?,?,?,?,?)",[input.requestId,fingerprint,input.incidentId,revision,input.action]);
        event(db,uuid(meta(db).epoch),`incident_${input.action}`,scope(row.scope),row.agent_id === null ? null : uuid(row.agent_id),number(input.nowMs),input.incidentId);
        return { requestId: input.requestId, incidentId: input.incidentId, appliedRevision: revision, duplicate: false, repaired: false };
      });
    },
  };
}
export type MonitorStore = ReturnType<typeof openMonitorStore>;

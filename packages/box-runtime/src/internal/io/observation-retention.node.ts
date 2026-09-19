import { OBSERVATION_RETENTION, retentionClock } from "@grokbox/runtime-kernel/observation";
import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

/** Incremental lifetime transitions. Acknowledgement is not an evidence pin;
 * removing payload never changes an unknown delivery into a safe retry. */
export async function retireObservationDetails(db: MonitorSqlite, nowMs: number, detailMs: number) {
  const prior = await db.first("SELECT last_at FROM observation_maintenance WHERE singleton=1");
  const clock = retentionClock(nowMs, prior?.last_at === null || prior?.last_at === undefined ? null : Number(prior.last_at));
  if (!clock.mayExpire) {
    await db.run("UPDATE observation_maintenance SET last_state=? WHERE singleton=1", [clock.state]);
    return { state: clock.state, expiredSnapshots: 0, mayExpire: false };
  }
  await db.run("UPDATE observation_maintenance SET last_at=?,last_state='observed' WHERE singleton=1", [nowMs]);
  await db.run("DELETE FROM evidence_leases WHERE id IN(SELECT id FROM evidence_leases WHERE expires_at<=? LIMIT 1000)", [nowMs]);
  const snapshots = await db.all("SELECT s.incident_id,s.revision FROM incident_snapshots s WHERE s.tier='detail' AND s.expires_at<=? AND NOT EXISTS(SELECT 1 FROM evidence_leases l WHERE l.incident_id=s.incident_id AND l.revision=s.revision AND l.expires_at>?) ORDER BY s.expires_at LIMIT 1000", [nowMs, nowMs]);
  for (const snapshot of snapshots) {
    await db.run("DELETE FROM snapshot_links WHERE incident_id=? AND revision=?", [String(snapshot.incident_id), Number(snapshot.revision)]);
    await db.run("UPDATE incident_snapshots SET tier='summary',logical_bytes=length(CAST(manifest_json AS BLOB))+length(CAST(assessment_json AS BLOB)) WHERE incident_id=? AND revision=?", [String(snapshot.incident_id), Number(snapshot.revision)]);
  }
  // The compact incident summary and management row survive independently.
  await db.run("DELETE FROM incident_evidence WHERE rowid IN(SELECT l.rowid FROM incident_evidence l JOIN incidents i ON i.id=l.incident_id WHERE i.last_seen<? AND NOT EXISTS(SELECT 1 FROM evidence_leases p WHERE p.incident_id=i.id AND p.expires_at>?) LIMIT 1000)", [nowMs - detailMs, nowMs]);
  await db.run("UPDATE notification_work SET state='expired',last_reason='notification_expired' WHERE id IN(SELECT id FROM notification_work WHERE state IN ('preparing','ready','blocked') AND expires_at<=? LIMIT 1000)", [nowMs]);
  await db.run("DELETE FROM open_executions WHERE identity IN(SELECT identity FROM open_executions WHERE state NOT IN ('queued','started') AND last_progress<? LIMIT 1000)", [nowMs - OBSERVATION_RETENTION.dedupeMs]);
  // Snapshot identities remain queryable as summary-only throughout their stated
  // summary window; no query-time deletion or lease renewal is permitted.
  // An unknown HTTP effect keeps its exact work/attempt replay guard below, NOT
  // an unlimited pin on diagnostic material. After the promised summary/lease
  // window and delivery expiry, payload may retire independently. Both begin
  // and reservation still reject the old identity, and a late settlement uses
  // its frozen attempt rather than reviving/recreating an evidence revision.
  const expired = await db.all(`SELECT s.incident_id,s.revision FROM incident_snapshots s WHERE s.tier='summary' AND s.summary_expires_at<=?
    AND NOT EXISTS(SELECT 1 FROM evidence_leases l WHERE l.incident_id=s.incident_id AND l.revision=s.revision AND l.expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM notification_work w WHERE w.incident_id=s.incident_id AND w.evidence_revision=s.revision
      AND w.expires_at>? AND w.state IN ('preparing','ready','attempting')) LIMIT 1000`, [nowMs, nowMs, nowMs]);
  for (const snapshot of expired) {
    const id = String(snapshot.incident_id), revision = Number(snapshot.revision);
    await db.run("INSERT INTO incident_evidence_history(incident_id,last_revision,retired_through,updated_at) VALUES(?,?,?,?) ON CONFLICT(incident_id) DO UPDATE SET last_revision=MAX(last_revision,excluded.last_revision),retired_through=MAX(retired_through,excluded.retired_through),updated_at=excluded.updated_at", [id, revision, revision, nowMs]);
    await db.run("DELETE FROM snapshot_links WHERE incident_id=? AND revision=?", [id, revision]);
    await db.run("DELETE FROM incident_snapshots WHERE incident_id=? AND revision=?", [id, revision]);
  }
  // Retire only terminal, fully reconciled delivery metadata, after its dedupe
  // horizon and after the incident itself is gone. Unknown is never made retryable.
  const work = await db.all(`SELECT w.id FROM notification_work w WHERE w.state IN ('expired','completed','superseded') AND w.created_at<?
    AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.id=w.incident_id)
    AND NOT EXISTS(SELECT 1 FROM notification_attempts a WHERE a.work_id=w.id AND a.state IN ('reserved','attempting','unknown')) LIMIT 1000`, [nowMs - OBSERVATION_RETENTION.dedupeMs]);
  for (const row of work) {
    await db.run("DELETE FROM notification_attempts WHERE work_id=?", [String(row.id)]);
    await db.run("DELETE FROM notification_work WHERE id=?", [String(row.id)]);
  }
  await db.run(`DELETE FROM incident_evidence_history WHERE incident_id IN(SELECT h.incident_id FROM incident_evidence_history h WHERE h.updated_at<?
    AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.id=h.incident_id)
    AND NOT EXISTS(SELECT 1 FROM incident_snapshots s WHERE s.incident_id=h.incident_id)
    AND NOT EXISTS(SELECT 1 FROM notification_work w WHERE w.incident_id=h.incident_id) LIMIT 1000)`, [nowMs - OBSERVATION_RETENTION.dedupeMs]);
  return { state: clock.state, expiredSnapshots: snapshots.length, retiredSnapshots: expired.length, retiredNotifications: work.length, mayExpire: true };
}

export async function sqlitePhysicalUsage(db: MonitorSqlite) {
  const page = Number((await db.first("PRAGMA page_size"))?.page_size ?? 0);
  const pages = Number((await db.first("PRAGMA page_count"))?.page_count ?? 0);
  const free = Number((await db.first("PRAGMA freelist_count"))?.freelist_count ?? 0);
  const mode = Number((await db.first("PRAGMA auto_vacuum"))?.auto_vacuum ?? 0);
  return { pageBytes: page, allocatedBytes: page * pages, freeBytes: page * free,
    livePageBytes: page * Math.max(0, pages - free), incrementalReclamation: mode === 2,
    reclamationBlockedReason: mode === 2 ? null : "requires_explicit_database_rebuild" };
}

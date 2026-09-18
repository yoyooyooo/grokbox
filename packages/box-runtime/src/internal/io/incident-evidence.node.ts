import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { assessEvidenceCoverage, assessIncident, buildBotIncidentNotice, evidenceIdentity, publicEvidenceSummary, allocateEvidenceAliases, selectEvidenceClosure,
  OBSERVATION_RETENTION, projectContinuityEvent, type EvidenceFact, type EvidenceView, type IncidentAssessment, type IncidentEvidenceManifest } from "@grokbox/runtime-kernel/observation";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { projectControlEvent } from "./journal.node.ts";
import type { MonitorSqlite, SqlRow } from "./monitor-sqlite.node.ts";
import { monitorWriteAdmission } from "./monitor-storage.node.ts";

export const INCIDENT_EVIDENCE_SCHEMA = `
CREATE TABLE incident_snapshots(incident_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,summary_expires_at INTEGER NOT NULL,digest TEXT NOT NULL,facts_digest TEXT NOT NULL,manifest_json TEXT NOT NULL,assessment_json TEXT NOT NULL,tier TEXT NOT NULL DEFAULT 'detail',logical_bytes INTEGER NOT NULL,lease_origin_at INTEGER,PRIMARY KEY(incident_id,revision));
CREATE TABLE snapshot_links(incident_id TEXT NOT NULL,revision INTEGER NOT NULL,event_ref TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(incident_id,revision,event_ref));
CREATE INDEX snapshot_links_ref ON snapshot_links(event_ref);
CREATE INDEX snapshot_expiry ON incident_snapshots(tier,expires_at);
CREATE TABLE incident_evidence_history(incident_id TEXT PRIMARY KEY,last_revision INTEGER NOT NULL,retired_through INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE evidence_leases(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL);
CREATE INDEX evidence_lease_expiry ON evidence_leases(expires_at,incident_id,revision);
CREATE UNIQUE INDEX evidence_lease_snapshot ON evidence_leases(incident_id,revision);
CREATE TABLE notification_work(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL UNIQUE,evidence_revision INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_reason TEXT);
CREATE INDEX notification_work_ready ON notification_work(state,created_at);
CREATE TABLE notification_attempts(id TEXT PRIMARY KEY,work_id TEXT NOT NULL,target_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,state TEXT NOT NULL,reserved_at INTEGER NOT NULL,settled_at INTEGER,receipt_json TEXT);
CREATE INDEX notification_attempt_work ON notification_attempts(work_id,reserved_at);
CREATE TABLE open_executions(identity TEXT PRIMARY KEY,source_key TEXT NOT NULL,agent_id TEXT NOT NULL,host_generation TEXT NOT NULL,dispatch_id TEXT NOT NULL,state TEXT NOT NULL,last_progress INTEGER NOT NULL,event_ref TEXT NOT NULL,incident_id TEXT);
CREATE INDEX open_execution_expiry ON open_executions(state,last_progress);
CREATE TABLE evidence_retirement(source_key TEXT PRIMARY KEY,through_sequence INTEGER NOT NULL DEFAULT -1,through_time INTEGER NOT NULL DEFAULT 0);
CREATE TABLE observation_maintenance(singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_at INTEGER,last_state TEXT NOT NULL DEFAULT 'not_checked',dropped_events INTEGER NOT NULL DEFAULT 0,pressure_state TEXT NOT NULL DEFAULT 'normal',rejected_batches INTEGER NOT NULL DEFAULT 0);
INSERT INTO observation_maintenance(singleton) VALUES(1);
CREATE INDEX evidence_turn ON evidence(agent_id,host_generation,json_extract(payload,'$.turnId'));
CREATE INDEX evidence_dispatch ON evidence(agent_id,host_generation,json_extract(payload,'$.dispatchId'));
`;
const fail = (code: string): never => { throw new BoxRuntimeError("invalid_usage", code); };
const ref = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f]/.test(v);
function manifestDigest(manifest: IncidentEvidenceManifest): string {
  const { digest: _digest, ...body } = manifest;
  return sha256Text(canonicalJson(body));
}
const safeEvent = (value: unknown): Record<string, unknown> | null => {
  try { return projectControlEvent(value) as Record<string, unknown> | null; } catch { return null; }
};

/** Materialize only an explicitly linked, bounded closure in one read transaction.
 * Facts are shared with evidence, not copied into each manifest or Bot payload. */
export async function collectIncidentEvidence(db: MonitorSqlite, incident: SqlRow, selector?: { agentId: string; stepId: string }) {
  const max = OBSERVATION_RETENTION.maxSnapshotFacts, rows = new Map<string, SqlRow>();
  const queries = new Set<string>();
  let truncated = false;
  const add = (found: SqlRow[]) => {
    for (const row of found) {
      if (rows.has(String(row.ref))) continue;
      if (rows.size >= max) { truncated = true; break; }
      rows.set(String(row.ref), row);
    }
  };
  const fetch = async (sql: string, params: Array<string | number | null>, key: string) => {
    if (queries.has(key)) return;
    if (queries.size >= 64) { truncated = true; return; }
    queries.add(key);
    add(await db.all(sql + " ORDER BY e.seq LIMIT ?", [...params, max - rows.size + 1]));
  };
  if(selector)await fetch("SELECT e.* FROM evidence e WHERE e.agent_id=? AND e.step_id=?",[selector.agentId,selector.stepId],"seed");
  else await fetch("SELECT e.* FROM evidence e JOIN incident_evidence i ON i.event_ref=e.ref WHERE i.incident_id=?", [String(incident.id)], "seed");
  const seedRefs = new Set(rows.keys());
  let index = 0;
  while (index < rows.size && queries.size < 64) {
    const row = [...rows.values()][index++]!;
    let v: Record<string, unknown> | null = null;
    try { v = safeEvent(JSON.parse(String(row.payload))); } catch { /* report missing schema */ }
    if (!v) continue;
    const agent = evidenceIdentity(v.agentId) ? v.agentId : undefined;
    const generation = evidenceIdentity(v.hostGenerationId) ? v.hostGenerationId : undefined;
    if (agent && generation) {
      for (const field of ["turnId", "dispatchId"] as const) {
        if (!evidenceIdentity(v[field])) continue;
        const epoch = evidenceIdentity(v.serviceEpoch) ? v.serviceEpoch : null;
        await fetch(`SELECT e.* FROM evidence e WHERE e.agent_id=? AND e.host_generation=? AND json_extract(e.payload,'$.${field}')=? AND (? IS NULL OR json_extract(e.payload,'$.serviceEpoch') IS NULL OR json_extract(e.payload,'$.serviceEpoch')=?)`,
          [agent, generation, v[field], epoch, epoch], JSON.stringify([field, agent, generation, v[field], epoch]));
      }
      if (evidenceIdentity(v.failureId)) await fetch("SELECT e.* FROM evidence e WHERE e.agent_id=? AND e.host_generation=? AND e.failure_id=?", [agent, generation, v.failureId], `failure:${agent}:${generation}:${v.failureId}`);
    }
    if (evidenceIdentity(v.sourceInstanceId) && generation) for (const field of ["trayId", "decisionId"] as const) {
      if (!evidenceIdentity(v[field])) continue;
      const column = field === "trayId" ? "tray_id" : "decision_id";
      await fetch(`SELECT e.* FROM evidence e WHERE e.source_key=? AND e.host_generation=? AND e.${column}=?`, [v.sourceInstanceId, generation, v[field]], `${field}:${v.sourceInstanceId}:${generation}:${v[field]}`);
    }
    if (generation) await fetch("SELECT e.* FROM evidence e WHERE e.host_generation=? AND json_extract(e.payload,'$.kind') IN ('observer_started','manager_attached')", [generation], `observer:${generation}`);
  }
  let bytes = 0;
  const facts: EvidenceFact[] = [];
  for (const row of [...rows.values()].sort((a, b) => Number(seedRefs.has(String(b.ref))) - Number(seedRefs.has(String(a.ref))) || Number(a.seq) - Number(b.seq))) {
    const payload = String(row.payload), next = Buffer.byteLength(payload);
    if (bytes + next > OBSERVATION_RETENTION.maxSnapshotBytes) { truncated = true; continue; }
    let value: Record<string, unknown> | null = null;
    try { value = safeEvent(JSON.parse(payload)); } catch { /* unsupported saved evidence */ }
    if (!value) continue;
    facts.push({ ref: String(row.ref), value }); bytes += next;
  }
  facts.sort((a,b)=>Number(rows.get(a.ref)!.seq)-Number(rows.get(b.ref)!.seq));
  return { facts, truncated, logicalBytes: bytes, seedRefs };
}

export async function captureIncidentEvidence(db: MonitorSqlite, incidentId: string, atMs: number, input: { detailMs?: number; summaryMs?: number; prepareNotification?: boolean; maxDatabaseBytes?: number } = {}) {
  const incident = await db.first("SELECT * FROM incidents WHERE id=?", [incidentId]);
  if (!incident) return fail("monitor_incident_not_found");
  const data = await collectIncidentEvidence(db, incident);
  const assessed = assessIncident(String(incident.rule), data.facts);
  const factsDigest = sha256Text(canonicalJson([data.facts.map(f => [f.ref, sha256Text(canonicalJson(f.value))]), String(incident.rule), assessed]));
  const previous = await db.first("SELECT * FROM incident_snapshots WHERE incident_id=? ORDER BY revision DESC LIMIT 1", [incidentId]);
  const prepareWork = async (revision: number) => {
    if (input.prepareNotification && assessed.disposition === "notify" && incident.acknowledged !== 1
      && Number(incident.last_seen) >= atMs - OBSERVATION_RETENTION.notificationTtlMs && Number(incident.last_seen) <= atMs + 60_000
      && (incident.snooze_until === null || Number(incident.snooze_until) <= atMs) && !incident.parent_id) {
      await db.run("INSERT OR IGNORE INTO notification_work(id,incident_id,evidence_revision,state,created_at,expires_at) VALUES(?,?,?,'ready',?,?)", [randomUUID(), incidentId, revision, atMs, atMs + OBSERVATION_RETENTION.notificationTtlMs]);
    }
  };
  if (previous?.facts_digest === factsDigest && previous.tier === "detail") {
    await prepareWork(Number(previous.revision));
    return { revision: Number(previous.revision), digest: String(previous.digest), duplicate: true };
  }
  // A retained revision is immutable. Limit count without evicting a promised
  // notification or an active reader. History watermarks prevent ID reuse even
  // when all snapshot payloads have expired.
  const history = await db.first("SELECT last_revision FROM incident_evidence_history WHERE incident_id=?", [incidentId]);
  const revision = Math.max(Number(previous?.revision ?? 0), Number(history?.last_revision ?? 0)) + 1;
  if (!Number.isSafeInteger(revision)) return fail("monitor_evidence_revision_exhausted");
  const retained = await db.all("SELECT revision FROM incident_snapshots WHERE incident_id=? ORDER BY revision", [incidentId]);
  const toRetire = Math.max(0, retained.length + 1 - OBSERVATION_RETENTION.maxSnapshotRevisions);
  const removable = toRetire ? await db.all(`SELECT s.revision FROM incident_snapshots s WHERE s.incident_id=?
    AND NOT EXISTS(SELECT 1 FROM evidence_leases l WHERE l.incident_id=s.incident_id AND l.revision=s.revision AND l.expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM notification_work w WHERE w.incident_id=s.incident_id AND w.evidence_revision=s.revision
      AND ((w.state IN ('preparing','ready') AND w.expires_at>?) OR EXISTS(SELECT 1 FROM notification_attempts a WHERE a.work_id=w.id AND a.state IN ('reserved','attempting','unknown'))))
    ORDER BY s.revision LIMIT ?`, [incidentId, atMs, atMs, toRetire]) : [];
  if (removable.length < toRetire) return fail("monitor_evidence_revisions_protected");
  const meta = await db.first("SELECT evidence_floor FROM meta WHERE singleton=1");
  const generations = new Set(data.facts.map(f => f.value.hostGenerationId).filter(evidenceIdentity));
  const continuityGaps = [...new Set(data.facts.flatMap(f => projectContinuityEvent(f.value)?.coverage.gapCodes ?? []))];
  const manifest: IncidentEvidenceManifest = {
    schemaVersion: 1, incidentId, occurrenceId: incidentId, evidenceRevision: revision, capturedAtMs: atMs,
    classifierVersion: assessed.classifierVersion, incidentRule: String(incident.rule),
    sourceWindow: { source: "monitor", state: continuityGaps.length ? "partial" : data.facts.length ? "observed" : "not_observed_in_window", retainedFloor: Number(meta?.evidence_floor ?? 0), selected: data.facts.length, truncated: data.truncated,
      gapCodes: data.facts.length ? continuityGaps : ["source_facts_not_available"] },
    factRefs: data.facts.map(f => ({ ref: f.ref, digest: sha256Text(canonicalJson(f.value)) })), relationEdges: [],
    identityAliases: allocateEvidenceAliases(data.facts, previous ? (JSON.parse(String(previous.manifest_json)) as IncidentEvidenceManifest).identityAliases : {}),
    assessmentDigest: sha256Text(canonicalJson(assessed)),
    coverageByRequirement: assessEvidenceCoverage(data.facts, { truncated: data.truncated, conflicting: generations.size > 1 }),
    currentObservations: { status: "not_checked" }, viewPolicyVersion: "evidence-views-v1",
    retention: { tier: "detail", expiresAtMs: atMs + (input.detailMs ?? OBSERVATION_RETENTION.detailMs), summaryExpiresAtMs: atMs + (input.summaryMs ?? OBSERVATION_RETENTION.summaryMs) },
    logicalBytes: data.logicalBytes, digest: "",
  };
  // Stable report-local aliases must not become a lifetime-sized identity cache.
  if (Object.keys(manifest.identityAliases).length > OBSERVATION_RETENTION.maxAliasEntries) return fail("monitor_evidence_alias_budget");
  const primary = data.facts.find(f => evidenceIdentity(f.value.agentId) && ["stepId","dispatchId","trayId"].some(k => evidenceIdentity(f.value[k])));
  if(primary){const v=primary.value;const closure=selectEvidenceClosure(data.facts,{agentId:String(v.agentId),...(evidenceIdentity(v.stepId)?{stepId:v.stepId}:{}),...(evidenceIdentity(v.dispatchId)?{dispatchId:v.dispatchId}:{}),...(evidenceIdentity(v.trayId)?{trayId:v.trayId}:{})});manifest.relationEdges=closure.relationEdges;
    if(closure.conflicting)manifest.coverageByRequirement=assessEvidenceCoverage(data.facts,{truncated:data.truncated,conflicting:true});
  }
  // Metadata and alias maps count toward the same bounded report, not only the
  // source payload. Keep the failure seeds before optional surrounding traffic.
  while(data.facts.length && Buffer.byteLength(canonicalJson(manifest))+data.logicalBytes>OBSERVATION_RETENTION.maxSnapshotBytes){
    let index=-1;
    for(let i=data.facts.length-1;i>=0;i--)if(!data.seedRefs.has(data.facts[i]!.ref)&&!assessed.basisRefs.includes(data.facts[i]!.ref)){index=i;break;}
    if(index<0)for(let i=data.facts.length-1;i>=0;i--)if(!assessed.basisRefs.includes(data.facts[i]!.ref)){index=i;break;}
    if(index<0)index=data.facts.length-1;
    const removed=data.facts.splice(index,1)[0]!;data.logicalBytes-=Buffer.byteLength(canonicalJson(removed.value));manifest.factRefs.splice(index,1);
    manifest.sourceWindow.truncated=true;manifest.sourceWindow.selected=data.facts.length;manifest.sourceWindow.gapCodes=[...new Set([...manifest.sourceWindow.gapCodes,"snapshot_byte_budget"])];
    manifest.relationEdges=manifest.relationEdges.filter(edge=>edge.from!==removed.ref&&edge.to!==removed.ref);
    manifest.coverageByRequirement=assessEvidenceCoverage(data.facts,{truncated:true,conflicting:manifest.coverageByRequirement.some(row=>row.status==="conflicting")});manifest.logicalBytes=data.logicalBytes;
  }
  const retainedRefs=new Set(data.facts.map(f=>f.ref));
  if(assessed.basisRefs.some(ref=>!retainedRefs.has(ref))){
    Object.assign(assessed,assessIncident(String(incident.rule),data.facts));
    manifest.assessmentDigest=sha256Text(canonicalJson(assessed));
  }
  manifest.digest = manifestDigest(manifest);
  const encoded = canonicalJson(manifest), assessment = canonicalJson(assessed);
  // Payload facts already occupy the shared evidence table. Reserve the new
  // manifest, indexes and links; the file-level SQLite cap is a final backstop.
  const incoming = 16 * 1024 + 4 * (Buffer.byteLength(encoded) + Buffer.byteLength(assessment) + data.facts.length * 512);
  if (!(await monitorWriteAdmission(db, input.maxDatabaseBytes ?? OBSERVATION_RETENTION.monitorDatabaseBytes, incoming)).accepted) return fail("monitor_storage_pressure");
  await db.run("INSERT INTO incident_snapshots(incident_id,revision,created_at,expires_at,summary_expires_at,digest,facts_digest,manifest_json,assessment_json,logical_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [incidentId, revision, atMs, manifest.retention.expiresAtMs, manifest.retention.summaryExpiresAtMs, manifest.digest, factsDigest, encoded, assessment, data.logicalBytes + Buffer.byteLength(encoded) + Buffer.byteLength(assessment)]);
  for (const [i, fact] of data.facts.entries()) await db.run("INSERT INTO snapshot_links(incident_id,revision,event_ref,ordinal) VALUES(?,?,?,?)", [incidentId, revision, fact.ref, i]);
  await db.run("INSERT INTO incident_evidence_history(incident_id,last_revision,updated_at) VALUES(?,?,?) ON CONFLICT(incident_id) DO UPDATE SET last_revision=excluded.last_revision,updated_at=excluded.updated_at", [incidentId, revision, atMs]);
  for (const row of removable) {
    const expired = Number(row.revision);
    await db.run("DELETE FROM snapshot_links WHERE incident_id=? AND revision=?", [incidentId, expired]);
    await db.run("DELETE FROM incident_snapshots WHERE incident_id=? AND revision=?", [incidentId, expired]);
    await db.run("DELETE FROM evidence_leases WHERE incident_id=? AND revision=? AND expires_at<=?", [incidentId, expired, atMs]);
    await db.run("UPDATE incident_evidence_history SET retired_through=MAX(retired_through,?) WHERE incident_id=?", [expired, incidentId]);
  }
  await prepareWork(revision);
  return { revision, digest: manifest.digest, duplicate: false };
}

export async function readIncidentEvidence(db: MonitorSqlite, incidentId: string, revision: number | undefined, view: EvidenceView = "local-diagnostic") {
  const row = revision === undefined
    ? await db.first("SELECT * FROM incident_snapshots WHERE incident_id=? ORDER BY revision DESC LIMIT 1", [incidentId])
    : await db.first("SELECT * FROM incident_snapshots WHERE incident_id=? AND revision=?", [incidentId, revision]);
  if (!row) {
    const incident = await db.first("SELECT id,rule,status,first_seen,last_seen FROM incidents WHERE id=?", [incidentId]);
    if (!incident) return fail("monitor_incident_not_found");
    const history = await db.first("SELECT last_revision,retired_through FROM incident_evidence_history WHERE incident_id=?", [incidentId]);
    const expired = !!history && (revision === undefined || revision <= Number(history.last_revision));
    const state = expired ? "expired" : "not_checked", reason = expired ? "snapshot_revision_retired" : "snapshot_not_captured";
    if(view==="public-summary")return {schemaVersion:1,view,state,reason,facts:[],replayAuthorized:false};
    return { schemaVersion: 1, incidentId, evidenceRevision: revision ?? null, state, reason, incident,
      facts: [], replayAuthorized: false, currentObservations: { status: "not_checked" } };
  }
  const manifest = JSON.parse(String(row.manifest_json)) as IncidentEvidenceManifest;
  if (manifest.schemaVersion !== 1 || manifest.incidentId !== incidentId || manifest.evidenceRevision !== row.revision
    || manifest.digest !== row.digest || manifestDigest(manifest) !== manifest.digest) return fail("monitor_evidence_integrity");
  const assessment = JSON.parse(String(row.assessment_json)) as IncidentAssessment;
  if(sha256Text(canonicalJson(assessment))!==manifest.assessmentDigest)return fail("monitor_evidence_integrity");
  const records = row.tier === "detail" ? await db.all("SELECT e.ref,e.payload FROM snapshot_links s JOIN evidence e ON e.ref=s.event_ref WHERE s.incident_id=? AND s.revision=? ORDER BY s.ordinal LIMIT ?", [incidentId, Number(row.revision), OBSERVATION_RETENTION.maxSnapshotFacts + 1]) : [];
  const facts: EvidenceFact[] = [];
  let missing = false;
  for (const item of manifest.factRefs) {
    if (!ref(item.ref)) return fail("monitor_evidence_integrity");
    const found = records.find(r => r.ref === item.ref);
    if (!found) { missing = true; continue; }
    const value = safeEvent(JSON.parse(String(found.payload)));
    if (!value || sha256Text(canonicalJson(value)) !== item.digest) return fail("monitor_evidence_integrity");
    facts.push({ ref: item.ref, value });
  }
  const state = row.tier === "summary" ? "expired" : missing ? "unavailable" : "available";
  if (view === "public-summary") return { ...publicEvidenceSummary(manifest, facts, assessment), state,
    retention: { tier: row.tier, expiresAtMs: Number(row.expires_at) } };
  return { ...manifest, view, state, assessment, facts, retention: { ...manifest.retention, tier: row.tier,
    ...(state === "expired" ? { reason: "detail_retired" } : missing ? { reason: "linked_fact_unavailable" } : {}) },
    replayAuthorized: false, executionCompleted: "not_proven" };
}

export async function noticeForWork(db: MonitorSqlite, workId: string) {
  const work = await db.first("SELECT * FROM notification_work WHERE id=?", [workId]);
  if (!work) return fail("notification_work_not_found");
  const snapshot = await db.first("SELECT * FROM incident_snapshots WHERE incident_id=? AND revision=?", [String(work.incident_id), Number(work.evidence_revision)]);
  if (!snapshot) return fail("notification_evidence_missing");
  await readIncidentEvidence(db,String(work.incident_id),Number(work.evidence_revision));
  const notice = buildBotIncidentNotice(JSON.parse(String(snapshot.manifest_json)), JSON.parse(String(snapshot.assessment_json)));
  if (snapshot.tier !== "detail") notice.evidence.tier = "summary";
  return notice;
}

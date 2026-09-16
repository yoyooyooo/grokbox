import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { MONITOR_POLICY, MONITOR_RULES, confirmedObservation, monitorFreshness, monitorScope, monitorTargets, monitorUuid, type MonitorRule, type MonitorSample } from "@grokbox/runtime-kernel/monitor";
import { traceAlerts, observationId, projectAlertEvent, projectNotification, chooseNotification, type AlertTraceSelector } from "@grokbox/runtime-kernel/alerts";
import type { LockHandle } from "./op-lock.ts";
import { acquireMonitorMigrationLock, monitorProcessIdentity as processStart } from "./monitor-owner.node.ts";
import { MonitorSqlite, openMonitorSqlite, privateMonitorDirectory, type SqlRow as Row } from "./monitor-sqlite.node.ts";
import { projectControlEvent } from "./journal.node.ts";
import { recordSourceSequence } from "./monitor-source-sequence.node.ts";
import { indexExecutionOccurrence, retainedDiagnosis } from "./monitor-occurrence.node.ts";
import { indexProviderRouteCondition, projectProviderRouteDiagnosis } from "./monitor-provider-route.node.ts";
const VERSION=2;
const error=(message:string)=>new BoxRuntimeError("invalid_usage",message);
const number=(v:unknown):number=>{if(typeof v!=="number"||!Number.isSafeInteger(v)||v<0)throw error("monitor_store_invalid");return v;};
const uuid=(v:unknown):string=>{if(!monitorUuid(v))throw error("monitor_store_invalid");return v;};
const scope=(v:unknown):string=>{if(!monitorScope(v))throw error("monitor_store_invalid");return v;};
const nullableTime=(v:unknown)=>v===null?null:number(v);
const harness=(v:unknown):"box"|"temporal"|null=>{if(v!==null&&v!=="box"&&v!=="temporal")throw error("monitor_store_invalid");return v;};
const missing=(e:unknown)=>e!==null&&typeof e==="object"&&"code"in e&&e.code==="ENOENT";
const RUNTIME_RULES=["execution_failure","pre_step_failure","shared_runtime_failure","upstream_route_failure"] as const;
const rule=(v:unknown)=>{if(![...MONITOR_RULES,...RUNTIME_RULES].includes(v as never))throw error("monitor_store_invalid");return v as MonitorRule|typeof RUNTIME_RULES[number];};
const SCHEMA=`
PRAGMA user_version=2;
CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,database_id TEXT NOT NULL,root_id TEXT NOT NULL,epoch TEXT,running INTEGER NOT NULL DEFAULT 0,current_scope TEXT,gateway_epoch TEXT,heartbeat INTEGER,last_number INTEGER NOT NULL DEFAULT 0,last_sample_id TEXT,last_digest TEXT,owner_pid INTEGER,owner_start TEXT,event_floor INTEGER NOT NULL DEFAULT 0,evidence_floor INTEGER NOT NULL DEFAULT 0);
CREATE TABLE watched(agent_id TEXT PRIMARY KEY);
CREATE TABLE observations(scope TEXT NOT NULL,agent_id TEXT NOT NULL,state TEXT NOT NULL,server_id TEXT,server_harness TEXT,local_harness TEXT,last_attempt INTEGER NOT NULL,last_success INTEGER,latest_success INTEGER NOT NULL,PRIMARY KEY(scope,agent_id));
CREATE TABLE incidents(id TEXT PRIMARY KEY,scope TEXT NOT NULL,agent_id TEXT,rule TEXT NOT NULL,status TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,resolved_at INTEGER,revision INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,snooze_until INTEGER,occurrence_key TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT 'condition',parent_id TEXT,summary_json TEXT);
CREATE UNIQUE INDEX one_open_incident ON incidents(scope,COALESCE(agent_id,''),rule,occurrence_key) WHERE status IN ('open','recorded');
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,epoch TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,agent_id TEXT,incident_id TEXT,at_ms INTEGER NOT NULL,before_harness TEXT,after_harness TEXT,interval_start INTEGER,detail_json TEXT);
CREATE TABLE management(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,incident_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL);
`;
const EVIDENCE_SCHEMA=`
CREATE TABLE evidence(seq INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,source_key TEXT NOT NULL,source_seq INTEGER,at_ms INTEGER NOT NULL,agent_id TEXT,step_id TEXT,host_generation TEXT,tray_id TEXT,failure_id TEXT,decision_id TEXT,payload TEXT NOT NULL);
CREATE INDEX evidence_tray ON evidence(tray_id,source_key,seq);
CREATE INDEX evidence_step ON evidence(agent_id,step_id,host_generation,seq);
CREATE INDEX incident_summary_step ON incidents(json_extract(summary_json,'$[0].agentId'),json_extract(summary_json,'$[0].stepId'));
CREATE INDEX evidence_failure ON evidence(failure_id,host_generation);
CREATE INDEX evidence_decision ON evidence(decision_id,source_key);
CREATE TABLE evidence_cursors(source_key TEXT PRIMARY KEY,cursor TEXT NOT NULL,batch_digest TEXT NOT NULL,updated_at INTEGER NOT NULL,gap TEXT);
CREATE TABLE incident_evidence(incident_id TEXT NOT NULL,event_ref TEXT NOT NULL,PRIMARY KEY(incident_id,event_ref));
CREATE TABLE source_health(source_key TEXT PRIMARY KEY,last_sequence INTEGER,last_event_at INTEGER,gaps INTEGER NOT NULL DEFAULT 0,conflicts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX events_time ON events(at_ms,seq);
CREATE INDEX evidence_time ON evidence(at_ms,seq);
CREATE INDEX evidence_source_sequence ON evidence(source_key,source_seq);
CREATE INDEX evidence_host_kind ON evidence(host_generation,json_extract(payload,'$.kind'));
CREATE TABLE source_gaps(source_key TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,PRIMARY KEY(source_key,start_seq));
CREATE UNIQUE INDEX notification_decision_key ON events(json_extract(detail_json,'$.deliveryKey')) WHERE kind='notification_decided';
`;
export type MonitorStoreOptions={beforePublish?:()=>void;afterRename?:()=>void;retentionMs?:number;eventTarget?:number};
/** Existing observation domain, incremental disk transactions. No alerts DB,
 * no modeld authority, no query-time initialization or retention mutation. */
export function openMonitorStore(root:string,options:MonitorStoreOptions={}){
 const rootId=sha256Text(canonicalJson(["grokbox-observability-v1",resolve(root)]));
 const directory=join(resolve(root),"observability"),file=join(directory,"observations.sqlite");
 const retentionMs=options.retentionMs??MONITOR_POLICY.retentionMs,eventTarget=options.eventTarget??MONITOR_POLICY.evidenceTarget;
 if(!Number.isSafeInteger(retentionMs)||retentionMs<1||!Number.isSafeInteger(eventTarget)||eventTarget<1)throw error("monitor_invalid_policy");
 const meta=async(db:MonitorSqlite)=>{const m=await db.first("SELECT * FROM meta WHERE singleton=1");if(!m)throw error("monitor_store_invalid");return m;};
 async function load(mode:"read"|"write"="read"){
  let db:MonitorSqlite|undefined;
  try{db=await openMonitorSqlite(file,mode);const m=await meta(db);if(m.root_id!==rootId||!monitorUuid(m.database_id)||![1,VERSION].includes(Number(m.version)))throw error("monitor_store_schema_or_root_mismatch");
   if(mode==="write"&&m.version!==VERSION)throw error("monitor_migration_required");return db;
  }catch(e){await db?.close().catch(()=>{});throw e instanceof BoxRuntimeError?e:error(missing(e)?"monitor_not_initialized":e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_reader_busy":"monitor_store_unavailable");}
 }
 async function read<T>(f:(db:MonitorSqlite)=>Promise<T>):Promise<T>{const db=await load();try{await db.run("BEGIN");return await f(db);}catch(e){throw e instanceof BoxRuntimeError?e:error(e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_reader_busy":"monitor_store_unavailable");}finally{await db.close();}}
 async function legacyLockPresent(){try{await lstat(join(directory,"writer.lock"));return true;}catch(e){if(missing(e))return false;throw e;}}
 async function mutate<T>(f:(db:MonitorSqlite)=>Promise<T>):Promise<T>{
  if(await legacyLockPresent())throw error("monitor_writer_busy");
  const db=await load("write");let committed=false;
  try{await db.run("BEGIN IMMEDIATE");const result=await f(db);options.beforePublish?.();await db.run("COMMIT");committed=true;options.afterRename?.();return result;
  }catch(e){if(!committed)await db.run("ROLLBACK").catch(()=>{});throw e instanceof BoxRuntimeError?e:error(committed?"monitor_commit_unknown":e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_writer_busy":"monitor_commit_failed");}
  finally{await db.close();}
 }
 const lastSequence=async(db:MonitorSqlite)=>number((await db.first("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS n"))?.n);
 async function event(db:MonitorSqlite,epoch:string,kind:string,sid:string,agentId:string|null,at:number,incidentId:string|null=null,before:"box"|"temporal"|null=null,after:"box"|"temporal"|null=null,from:number|null=null){
  await db.run("INSERT INTO events(id,epoch,kind,scope,agent_id,incident_id,at_ms,before_harness,after_harness,interval_start) VALUES(?,?,?,?,?,?,?,?,?,?)",[randomUUID(),epoch,kind,sid,agentId,incidentId,at,before,after,from]);
 }
 async function incident(db:MonitorSqlite,epoch:string,sid:string,agentId:string|null,key:MonitorRule,active:boolean,at:number){
  const row=await db.first("SELECT * FROM incidents WHERE scope=? AND agent_id IS ? AND rule=? AND status='open' AND occurrence_key=''",[sid,agentId,key]);
  if(active&&row){await db.run("UPDATE incidents SET last_seen=? WHERE id=?",[at,uuid(row.id)]);return;}
  if(active){const id=randomUUID();await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision) VALUES(?,?,?,?,'open',?,?,1)",[id,sid,agentId,key,at,at]);await event(db,epoch,"incident_opened",sid,agentId,at,id);}
  else if(row){await db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=?,revision=revision+1 WHERE id=?",[at,at,uuid(row.id)]);await event(db,epoch,"incident_resolved",sid,agentId,at,uuid(row.id));}
 }
 function getIncident(row:Row){if(!["open","resolved","recorded"].includes(String(row.status)))throw error("monitor_store_invalid");
  return {id:uuid(row.id),scopeId:scope(row.scope),agentId:row.agent_id===null?null:uuid(row.agent_id),rule:rule(row.rule),status:String(row.status),category:String(row.category??"condition"),parentIncidentId:monitorUuid(row.parent_id)?row.parent_id:null,diagnosis:row.rule==="upstream_route_failure" && typeof row.summary_json==="string" ? projectProviderRouteDiagnosis(JSON.parse(row.summary_json)) : retainedDiagnosis(row.summary_json),
   firstSeenAtMs:number(row.first_seen),lastSeenAtMs:number(row.last_seen),resolvedAtMs:nullableTime(row.resolved_at),revision:number(row.revision),acknowledged:number(row.acknowledged)===1,snoozeUntilMs:nullableTime(row.snooze_until)};
 }
 function getEvent(row:Row){const allowed=["collector_started","observation_gap","collector_stopped","scope_changed","ownership_changed","incident_opened","incident_resolved","incident_ack","incident_snooze","execution_failure_observed","source_conflict","notification_decided","notification_exported","notification_export_unknown"];
  if(!allowed.includes(String(row.kind)))throw error("monitor_store_invalid");return {seq:number(row.seq),eventId:uuid(row.id),collectorEpoch:uuid(row.epoch),kind:String(row.kind),scopeId:scope(row.scope),agentId:row.agent_id===null?null:uuid(row.agent_id),incidentId:row.incident_id===null?null:uuid(row.incident_id),observedAtMs:number(row.at_ms),previousHarness:harness(row.before_harness),currentHarness:harness(row.after_harness),observationIntervalStartMs:nullableTime(row.interval_start), ...(typeof row.detail_json === "string" ? { notification: projectNotification(JSON.parse(row.detail_json)) } : {})};
 }
 async function notificationDecisions(db:MonitorSqlite,changes:ReturnType<typeof getEvent>[],at:number){
  const result:Array<{eventId:string;incidentId:string;deliveryKey:string;decision:"emit"|"suppress";reason:"new_occurrence"|"acknowledged"|"snoozed"|"aggregated";channel:"local_only"}>=[];
  for(const e of changes){if(!e.incidentId||!["incident_opened","execution_failure_observed"].includes(e.kind))continue;const row=await db.first("SELECT * FROM incidents WHERE id=?",[e.incidentId]);if(!row)continue;
   const chosen=chooseNotification({acknowledged:row.acknowledged===1,snoozeUntilMs:row.snooze_until===null?null:Number(row.snooze_until),nowMs:at,parentIncidentId:monitorUuid(row.parent_id)?row.parent_id:null});
   const decision={eventId:e.eventId,incidentId:e.incidentId,deliveryKey:sha256Text(`${e.incidentId}:${e.eventId}:local-v1`),...chosen};
   result.push(decision);
   await db.run("INSERT INTO events(id,epoch,kind,scope,agent_id,incident_id,at_ms,detail_json) VALUES(?,?,'notification_decided',?,?,?,?,?)",[randomUUID(),e.collectorEpoch,e.scopeId,e.agentId,e.incidentId,at,canonicalJson({...decision,ruleVersion:"monitor-local-v1"})]);
  }return result;
 }
 const api={
  path:file,
  async initialize(){
   await mkdir(root,{recursive:true,mode:0o700});await privateMonitorDirectory(resolve(root));await privateMonitorDirectory(directory,true);
   const initial=await lstat(file).catch(e=>{if(!missing(e))throw e;return null;});
   if(!initial){
    // A failed/crashed first transaction must never leave an empty canonical
    // database. Build privately and publish with an exclusive link. No persistent
    // bootstrap lock is needed for new databases; racing creators cannot replace
    // one another's committed file. Legacy migration below still fences v1 writers.
    const staging=join(directory,`.observations-init-${randomUUID()}.sqlite`);
    let fresh:MonitorSqlite|undefined,published=false;
    try{
     fresh=await openMonitorSqlite(staging,"create");
     await fresh.run("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL; BEGIN IMMEDIATE;");
     await fresh.run(SCHEMA+EVIDENCE_SCHEMA);const databaseId=randomUUID();
     await fresh.run("INSERT INTO meta(singleton,version,database_id,root_id) VALUES(1,?,?,?)",[VERSION,databaseId,rootId]);
     options.beforePublish?.();await fresh.run("COMMIT");await fresh.close();fresh=undefined;
     try{await link(staging,file);published=true;}
     catch(e){
      if(!(e&&typeof e==="object"&&"code"in e&&e.code==="EEXIST"))throw e;
      const current=await load();try{const m=await meta(current);return {databaseId:uuid(m.database_id),created:false,migrated:false};}finally{await current.close();}
     }
     await unlink(staging);const parent=await open(directory,"r");try{await parent.sync();}finally{await parent.close();}
     options.afterRename?.();return {databaseId,created:true,migrated:false};
    }catch(e){
     await fresh?.run("ROLLBACK").catch(()=>{});
     throw e instanceof BoxRuntimeError?e:error(published?"monitor_commit_unknown":"monitor_initialization_failed");
    }finally{await fresh?.close();await unlink(staging).catch(()=>{});}
   }
   let db:MonitorSqlite|undefined,migrationCommitted=false,held:LockHandle|null=null,collectorLock:LockHandle|null=null;
   try{
     // Serialize new migration/recovery owners with SQLite, then fence legacy
     // image writers with their lock. Only demonstrably dead lock PIDs recover.
     db=await openMonitorSqlite(file,"write");await db.run("BEGIN IMMEDIATE");
     const m=await meta(db);if(m.root_id!==rootId||!monitorUuid(m.database_id)||![1,VERSION].includes(Number(m.version)))throw error("monitor_store_schema_or_root_mismatch");
     held=await acquireMonitorMigrationLock(join(directory,"writer.lock"));if(!held)throw error("monitor_writer_busy");
     if(m.version===VERSION){await db.run("COMMIT");migrationCommitted=true;return {databaseId:uuid(m.database_id),created:false,migrated:false};}
     const legacyCollector=await lstat(join(directory,"collector.lock")).catch(e=>{if(!missing(e))throw e;return null;});
     if(legacyCollector){collectorLock=await acquireMonitorMigrationLock(join(directory,"collector.lock"));if(!collectorLock)throw error("monitor_legacy_collector_requires_stop");}
     const backup=join(directory,`observations-v1-${m.database_id}-${randomUUID()}.sqlite`);
     await copyFile(file,backup,constants.COPYFILE_EXCL);
     const backupHandle=await open(backup,"r");try{await backupHandle.sync();}finally{await backupHandle.close();}
     const directoryHandle=await open(directory,"r");try{await directoryHandle.sync();}finally{await directoryHandle.close();}
     await db.run("ALTER TABLE events ADD COLUMN detail_json TEXT; ALTER TABLE meta ADD COLUMN owner_pid INTEGER; ALTER TABLE meta ADD COLUMN owner_start TEXT; ALTER TABLE meta ADD COLUMN event_floor INTEGER NOT NULL DEFAULT 0; ALTER TABLE meta ADD COLUMN evidence_floor INTEGER NOT NULL DEFAULT 0; ALTER TABLE incidents ADD COLUMN occurrence_key TEXT NOT NULL DEFAULT ''; ALTER TABLE incidents ADD COLUMN category TEXT NOT NULL DEFAULT 'condition'; ALTER TABLE incidents ADD COLUMN parent_id TEXT; ALTER TABLE incidents ADD COLUMN summary_json TEXT; DROP INDEX one_open_incident; CREATE UNIQUE INDEX one_open_incident ON incidents(scope,COALESCE(agent_id,''),rule,occurrence_key) WHERE status IN ('open','recorded');");
     await db.run(EVIDENCE_SCHEMA);await db.run("UPDATE meta SET version=2,running=0,epoch=NULL,owner_pid=NULL,owner_start=NULL; PRAGMA user_version=2;");options.beforePublish?.();await db.run("COMMIT");migrationCommitted=true;options.afterRename?.();
     return {databaseId:uuid(m.database_id),created:false,migrated:true,backup};
   }catch(e){if(!migrationCommitted)await db?.run("ROLLBACK").catch(()=>{});throw e instanceof BoxRuntimeError?e:error(migrationCommitted?"monitor_commit_unknown":"monitor_initialization_failed");}
   finally{await collectorLock?.release();await held?.release();await db?.close();}
  },
  async begin(epoch:string,at:number,agentIds:string[]){
   if(!monitorUuid(epoch)||number(at)===0)throw error("monitor_invalid_epoch");const ids=monitorTargets(agentIds),owner=await processStart(process.pid);
   return mutate(async db=>{const previous=await meta(db),oldAt=nullableTime(previous.heartbeat);
    if(previous.running===1){
      if(!Number.isSafeInteger(previous.owner_pid)||typeof previous.owner_start!=="string")throw error("monitor_already_running_or_recovery_required");
      const alive=await processStart(number(previous.owner_pid));
      if(alive.state==="unavailable"||(alive.state==="present"&&alive.start===previous.owner_start))throw error("monitor_already_running_or_recovery_required");
    }
    await db.run("DELETE FROM watched");for(const id of ids)await db.run("INSERT INTO watched(agent_id) VALUES(?)",[id]);await db.run("UPDATE observations SET latest_success=0");
    await db.run("UPDATE meta SET epoch=?,running=1,heartbeat=?,last_number=0,last_sample_id=NULL,last_digest=NULL,owner_pid=?,owner_start=? WHERE singleton=1",[epoch,at,process.pid,owner.state==="present"?owner.start:null]);
    await event(db,epoch,previous.epoch===null?"collector_started":"observation_gap",rootId,null,at,null,null,null,oldAt);return {collectorEpoch:epoch,previousHeartbeatMs:oldAt,gap:previous.epoch!==null};});
  },
  async finish(epoch:string,at:number){return mutate(async db=>{if((await meta(db)).epoch!==epoch)throw error("monitor_epoch_changed");await db.run("UPDATE meta SET running=0,heartbeat=?,owner_pid=NULL,owner_start=NULL WHERE singleton=1",[number(at)]);await event(db,epoch,"collector_stopped",rootId,null,at);return {stopped:true};});},
  async record(epoch:string,sampleNumber:number,sample:MonitorSample){
   if(!monitorUuid(epoch)||!monitorUuid(sample.sampleId)||!Number.isSafeInteger(sampleNumber)||sampleNumber<1||!Array.isArray(sample.agents)||sample.agents.length>MONITOR_POLICY.maxTargets||!Number.isSafeInteger(sample.startedAtMs)||sample.startedAtMs<1||sample.completedAtMs<sample.startedAtMs)throw error("monitor_invalid_sample");
   return mutate(async db=>{const current=await meta(db),digest=sha256Text(canonicalJson(sample));if(current.epoch!==epoch||current.running!==1)throw error("monitor_epoch_changed");
    if(sampleNumber===current.last_number&&sample.sampleId===current.last_sample_id&&digest===current.last_digest)return {duplicate:true,sampleNumber,events:[] as ReturnType<typeof getEvent>[],notifications:[]};
    const previousSeq=await lastSequence(db);if(sampleNumber!==number(current.last_number)+1||sample.completedAtMs<number(current.heartbeat))throw error("monitor_stale_sample");const at=number(sample.completedAtMs);
    if(sample.failure||!sample.scopeId){await incident(db,epoch,rootId,null,"observation_unavailable",true,at);await db.run("UPDATE observations SET latest_success=0,last_attempt=? WHERE scope IS ?",[at,current.current_scope as string|null]);}
    else{const expectedIds=(await db.all("SELECT agent_id FROM watched ORDER BY agent_id")).map(r=>uuid(r.agent_id));if(canonicalJson(sample.agents.map(r=>r.agentId).sort())!==canonicalJson(expectedIds))throw error("monitor_incomplete_sample");
     const sid=scope(sample.scopeId),serverAt=number(sample.serverObservedAtMs);if(serverAt>at||serverAt<sample.startedAtMs-MONITOR_POLICY.readTimeoutMs||at-serverAt>MONITOR_POLICY.readTimeoutMs||!sample.gatewayEpoch||!/^\d+:\d+$/.test(sample.gatewayEpoch))throw error("monitor_invalid_sample");
     if(current.current_scope!==null&&current.current_scope!==sid)await event(db,epoch,"scope_changed",sid,null,at);await db.run("UPDATE meta SET current_scope=?,gateway_epoch=? WHERE singleton=1",[sid,sample.gatewayEpoch]);await incident(db,epoch,rootId,null,"observation_unavailable",false,at);
     for(const row of sample.agents){if(!monitorUuid(row.agentId)||!["confirmed_box","confirmed_temporal","conflict","unconfirmed"].includes(row.state)||![null,"box","temporal"].includes(row.serverHarness)||![null,"box","temporal"].includes(row.localHarness)||(row.serverId!==null&&(!/^[A-Za-z0-9-]{1,64}$/.test(row.serverId)||/secret|token|auth|password|api.?key|sk-/i.test(row.serverId))))throw error("monitor_invalid_sample");
      const previous=await db.first("SELECT * FROM observations WHERE scope=? AND agent_id=?",[sid,row.agentId]);if(!confirmedObservation(row)){await incident(db,epoch,sid,row.agentId,"observation_unavailable",true,at);if(previous)await db.run("UPDATE observations SET last_attempt=?,latest_success=0 WHERE scope=? AND agent_id=?",[at,sid,row.agentId]);continue;}
      if(previous?.last_success!==null&&previous?.last_success!==undefined&&serverAt<number(previous.last_success))throw error("monitor_stale_sample");const changed=previous!==null&&previous.server_harness!==row.serverHarness;
      if(changed)await event(db,epoch,"ownership_changed",sid,row.agentId,at,null,harness(previous!.server_harness),row.serverHarness,nullableTime(previous!.last_success));
      await db.run("INSERT INTO observations(scope,agent_id,state,server_id,server_harness,local_harness,last_attempt,last_success,latest_success) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(scope,agent_id) DO UPDATE SET state=excluded.state,server_id=excluded.server_id,server_harness=excluded.server_harness,local_harness=excluded.local_harness,last_attempt=excluded.last_attempt,last_success=excluded.last_success,latest_success=1",[sid,row.agentId,row.state,row.serverId,row.serverHarness,row.localHarness,at,serverAt]);
      await incident(db,epoch,sid,row.agentId,"observation_unavailable",false,at);await incident(db,epoch,sid,row.agentId,"ownership_conflict",row.state==="conflict",at);await incident(db,epoch,sid,row.agentId,"ownership_changed",changed,at);
     }
    }
    await db.run("UPDATE meta SET heartbeat=?,last_number=?,last_sample_id=?,last_digest=? WHERE singleton=1",[at,sampleNumber,sample.sampleId,digest]);const events=(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previousSeq])).map(getEvent);
    const notifications=await notificationDecisions(db,events,at);
    return {duplicate:false,sampleNumber,events:(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previousSeq])).map(getEvent),notifications};
   });
  },
  async snapshot(now=Date.now()){return read(async db=>{const m=await meta(db),epoch=m.epoch===null?null:uuid(m.epoch),sid=m.current_scope===null?null:scope(m.current_scope),cursor=await lastSequence(db);
   const rows=await db.all("SELECT w.agent_id AS watched_id,o.* FROM watched w LEFT JOIN observations o ON o.agent_id=w.agent_id AND o.scope IS ? ORDER BY w.agent_id",[sid]);
   return {schemaVersion:number(m.version),databaseId:uuid(m.database_id),collectorEpoch:epoch,source:"local_observations_not_authority",scopeId:sid,cursor:`${m.database_id}:${epoch??"none"}:${cursor}`,lastHeartbeatMs:nullableTime(m.heartbeat),collectorRecordedRunning:m.running===1,lastObservedGatewayEpoch:typeof m.gateway_epoch==="string"?m.gateway_epoch:null,admissionAuthority:false,productionAccepted:false,notificationMode:"local_only",storage:{engine:"sqlite-disk",journalMode:"delete",lifetimeEventLimit:null,migrationRequired:m.version!==VERSION},
    agents:rows.map(row=>row.state===null?{agentId:uuid(row.watched_id),lastKnown:null,lastAttemptMs:nullableTime(m.heartbeat),lastSuccessMs:null,freshness:"unavailable" as const}:{agentId:uuid(row.agent_id),lastKnown:{state:String(row.state),serverHarness:harness(row.server_harness),localHarness:harness(row.local_harness)},lastAttemptMs:number(row.last_attempt),lastSuccessMs:nullableTime(row.last_success),freshness:monitorFreshness(nullableTime(row.last_success),now,m.running===1&&row.latest_success===1)})};});},
  async incidents(){return read(async db=>{const rows=await db.all("SELECT * FROM incidents ORDER BY first_seen DESC,id LIMIT 201");if(rows.length>MONITOR_POLICY.maxPage)throw error("monitor_use_incident_pagination");return rows.map(getIncident);});},
  async incidentPage(after?:string,limit:number=MONITOR_POLICY.maxPage){if(!Number.isSafeInteger(limit)||limit<1||limit>MONITOR_POLICY.maxPage)throw error("monitor_invalid_limit");return read(async db=>{const m=await meta(db);let before=Number.MAX_SAFE_INTEGER,id="";
   if(after){const p=after.split(":");if(p.length!==5||p[0]!==m.database_id||p[1]!==String(m.epoch??"none")||p[2]!=="incidents"||!/^\d+$/.test(p[3]!)||!Number.isSafeInteger(Number(p[3]))||!monitorUuid(p[4]))throw error("monitor_cursor_invalid");before=Number(p[3]);id=p[4]!;}
   const rows=await db.all("SELECT * FROM incidents WHERE first_seen<? OR(first_seen=? AND id>?) ORDER BY first_seen DESC,id LIMIT ?",[before,before,id,limit+1]),selected=rows.slice(0,limit).map(getIncident),last=selected.at(-1);
   return {incidents:selected,hasMore:rows.length>limit,cursor:last?`${m.database_id}:${m.epoch??"none"}:incidents:${last.firstSeenAtMs}:${last.id}`:after??null};});},
  async events(after?:string,limit:number=MONITOR_POLICY.maxPage){if(!Number.isSafeInteger(limit)||limit<1||limit>MONITOR_POLICY.maxPage)throw error("monitor_invalid_limit");return read(async db=>{const m=await meta(db);let seq=0;
   if(after){const p=after.split(":");if(p.length!==3||p[0]!==m.database_id||p[1]!==String(m.epoch??"none")||!/^\d+$/.test(p[2]!))throw error("monitor_cursor_invalid");seq=Number(p[2]);if(!Number.isSafeInteger(seq)||seq>await lastSequence(db))throw error("monitor_cursor_invalid");if(seq<Number(m.event_floor??0))throw error("monitor_cursor_expired");}
   const rows=await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?",[seq,limit+1]),selected=rows.slice(0,limit).map(getEvent);return {entries:selected,hasMore:rows.length>limit,cursor:`${m.database_id}:${m.epoch??"none"}:${selected.at(-1)?.seq??seq}`,retentionFloor:Number(m.event_floor??0)};});},
  async manage(input:{requestId:string;incidentId:string;expectedRevision:number;action:"ack"|"snooze";untilMs?:number;nowMs:number}){
   if(!monitorUuid(input.requestId)||!monitorUuid(input.incidentId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!["ack","snooze"].includes(input.action))throw error("monitor_invalid_management");
   if(input.action==="snooze"&&(!Number.isSafeInteger(input.untilMs)||input.untilMs!<=input.nowMs||input.untilMs!-input.nowMs>MONITOR_POLICY.maxSnoozeMs))throw error("monitor_invalid_snooze");const fingerprint=sha256Text(canonicalJson([input.incidentId,input.expectedRevision,input.action,input.untilMs??null]));
   return mutate(async db=>{const prior=await db.first("SELECT * FROM management WHERE request_id=?",[input.requestId]);if(prior){if(prior.fingerprint!==fingerprint)throw error("monitor_request_conflict");return {requestId:input.requestId,incidentId:uuid(prior.incident_id),appliedRevision:number(prior.revision),duplicate:true,repaired:false};}
    const row=await db.first("SELECT * FROM incidents WHERE id=?",[input.incidentId]);if(!row)throw error("monitor_incident_not_found");if(row.status==="resolved")throw error("monitor_incident_resolved");if(row.revision!==input.expectedRevision)throw error("monitor_revision_conflict");
    await db.run(input.action==="ack"?"UPDATE incidents SET acknowledged=1,revision=revision+1 WHERE id=?":"UPDATE incidents SET snooze_until=?,revision=revision+1 WHERE id=?",input.action==="ack"?[input.incidentId]:[input.untilMs!,input.incidentId]);const revision=input.expectedRevision+1;
    await db.run("INSERT INTO management(request_id,fingerprint,incident_id,revision,action) VALUES(?,?,?,?,?)",[input.requestId,fingerprint,input.incidentId,revision,input.action]);await event(db,uuid((await meta(db)).epoch),`incident_${input.action}`,scope(row.scope),row.agent_id===null?null:uuid(row.agent_id),number(input.nowMs),input.incidentId);
    return {requestId:input.requestId,incidentId:input.incidentId,appliedRevision:revision,duplicate:false,repaired:false};});
  },
  async recordNotificationExport(epoch:string,notifications:unknown[],returned:boolean,atMs:number){
   return mutate(async db=>{if((await meta(db)).epoch!==epoch)throw error("monitor_epoch_changed");let written=0;
    for(const value of notifications){const choice=projectNotification(value);if(!choice||choice.decision!=="emit")continue;
     const source=await db.first("SELECT * FROM events WHERE kind='notification_decided' AND json_extract(detail_json,'$.deliveryKey')=?",[choice.deliveryKey]);if(!source)throw error("monitor_notification_unlinked");
     const hash=sha256Text(`${choice.deliveryKey}:${returned?"callback_returned":"callback_threw"}`),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
     await db.run("INSERT OR IGNORE INTO events(id,epoch,kind,scope,agent_id,incident_id,at_ms,detail_json) VALUES(?,?,?,?,?,?,?,?)",[id,epoch,returned?"notification_exported":"notification_export_unknown",String(source.scope),source.agent_id as string|null,choice.incidentId,atMs,canonicalJson({...choice,exportEvidence:returned?"callback_returned":"callback_threw"})]);written++;
    }return {observed:written,remoteReceipt:"not_configured"};
   });
  },
  async evidenceCursor(sourceKey:string){return read(async db=>{if((await meta(db)).version!==VERSION)throw error("monitor_migration_required");const row=await db.first("SELECT * FROM evidence_cursors WHERE source_key=?",[sourceKey]);return row?{cursor:String(row.cursor),gap:row.gap===null?null:String(row.gap)}:null;});},
  async ingestEvidence(input:{epoch:string;sourceKey:string;expectedCursor:string|null;nextCursor:string;events:unknown[];atMs:number;gap?:string}){
   if(!monitorUuid(input.epoch)||!monitorScope(input.sourceKey)||input.nextCursor.length>2048||input.events.length>4096)throw error("monitor_invalid_evidence_batch");
   const safe=input.events.map(projectControlEvent).filter((x):x is NonNullable<typeof x>=>x!==null),digest=sha256Text(canonicalJson({events:safe,gap:input.gap??null}));
   return mutate(async db=>{const m=await meta(db);if(m.epoch!==input.epoch||m.running!==1)throw error("monitor_epoch_changed");const current=await db.first("SELECT * FROM evidence_cursors WHERE source_key=?",[input.sourceKey]);
    if(current?.cursor===input.nextCursor&&current.batch_digest===digest)return {duplicate:true,inserted:0,conflicts:0,changes:[] as ReturnType<typeof getEvent>[]};
    if((current?.cursor??null)!==input.expectedCursor)throw error("monitor_source_cursor_conflict");const previous=await lastSequence(db);let inserted=0,conflicts=0;
    if(input.gap)await event(db,input.epoch,"observation_gap",rootId,null,input.atMs);
    for(const item of safe){const value=item as Record<string,unknown>,payload=canonicalJson(value),hash=sha256Text(payload),source=observationId(value.sourceInstanceId)?value.sourceInstanceId:input.sourceKey;
     const ref=observationId(value.eventId)?`${source}:${value.eventId}`:`legacy:${input.sourceKey}:${hash}`,old=await db.first("SELECT digest FROM evidence WHERE ref=?",[ref]);
     const sequenceConflict=Number.isSafeInteger(value.sourceSequence)?await db.first("SELECT ref,digest FROM evidence WHERE source_key=? AND source_seq=?",[source,Number(value.sourceSequence)]):null;
     if(old||sequenceConflict){if((old&&old.digest!==hash)||(sequenceConflict&&sequenceConflict.ref!==ref)){
       conflicts++;await event(db,input.epoch,"source_conflict",rootId,null,input.atMs);
       await db.run("INSERT INTO source_health(source_key,last_sequence,last_event_at,gaps,conflicts) VALUES(?,NULL,?,0,1) ON CONFLICT(source_key) DO UPDATE SET conflicts=source_health.conflicts+1",[source,input.atMs]);
     }continue;}
     const at=typeof value.at==="string"&&Number.isFinite(Date.parse(value.at))?Date.parse(value.at):input.atMs;
     const field=(k:string)=>observationId(value[k])?String(value[k]):null;
     await db.run("INSERT INTO evidence(ref,digest,source_key,source_seq,at_ms,agent_id,step_id,host_generation,tray_id,failure_id,decision_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",[ref,hash,source,Number.isSafeInteger(value.sourceSequence)?Number(value.sourceSequence):null,at,field("agentId"),field("stepId"),field("hostGenerationId"),field("trayId"),field("failureId"),field("decisionId"),payload]);inserted++;
     if(Number.isSafeInteger(value.sourceSequence))await recordSourceSequence(db,source,Number(value.sourceSequence),at);
     await indexExecutionOccurrence(db,{rootId,epoch:input.epoch,value,ref,at,
       opened:(id,agent)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,at,id),
       recovered:id=>event(db,input.epoch,"incident_resolved",rootId,null,at,id)});
     await indexProviderRouteCondition(db,{rootId,value,ref,
       opened:(id,agent)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,at,id),
       recovered:id=>event(db,input.epoch,"incident_resolved",rootId,null,at,id)});
    }
    await db.run("INSERT INTO evidence_cursors(source_key,cursor,batch_digest,updated_at,gap) VALUES(?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor,batch_digest=excluded.batch_digest,updated_at=excluded.updated_at,gap=excluded.gap",[input.sourceKey,input.nextCursor,digest,input.atMs,input.gap??null]);
    const changes=(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previous])).map(getEvent),notifications=await notificationDecisions(db,changes,input.atMs);return {duplicate:false,inserted,conflicts,changes:(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previous])).map(getEvent),notifications};
   });
  },
  async executionEvidence(selector:{agentId:string;stepId:string}){return read(async db=>{
    if((await meta(db)).version!==VERSION)throw error("monitor_migration_required");
    if(!observationId(selector.agentId)||!observationId(selector.stepId))throw error("monitor_invalid_trace_selector");
    const raw=await db.all("SELECT payload FROM evidence WHERE agent_id=? AND step_id=? ORDER BY seq LIMIT 4097",[selector.agentId,selector.stepId]);
    const values=raw.slice(0,4096).map(r=>JSON.parse(String(r.payload))),summaryRows=await db.all("SELECT summary_json FROM incidents WHERE rule='execution_failure' AND json_extract(summary_json,'$[0].agentId')=? AND json_extract(summary_json,'$[0].stepId')=? LIMIT 33",[selector.agentId,selector.stepId]);
    let summaryUsed=false;
    if(!values.length)for(const row of summaryRows.slice(0,32)){try{const summary=JSON.parse(String(row.summary_json));if(Array.isArray(summary))for(const event of summary){const safe=projectControlEvent(event);if(safe){values.push(safe);summaryUsed=true;}}}catch{/* malformed summary is not evidence */}}
    return {events:values,source:"monitor_materialized_journal",summaryUsed,truncated:raw.length>4096||summaryRows.length>32,retentionFloor:Number((await meta(db)).evidence_floor??0)};
  });},
  async alertTrace(selector:AlertTraceSelector){return read(async db=>{
    if((await meta(db)).version!==VERSION)throw error("monitor_migration_required");
    // Read the same explicit relationship closure as the journal projection.
    // A STEP may have produced a Tray subsequently updated by another STEP.
    // Budget exhaustion is disclosed, never silently treated as a complete trace.
    const budget=4096,values=new Map<string,unknown>(),queue:unknown[]=[],queried=new Set<string>();
    let truncated=false,queries=0;
    const add=(rows:Row[])=>{
      for(const row of rows){const ref=String(row.ref);if(values.has(ref))continue;
        if(values.size>=budget){truncated=true;break;}
        const value=JSON.parse(String(row.payload));values.set(ref,value);queue.push(value);
      }
    };
    const fetchLinks=async(sql:string,params:Array<string|number|null>,key:string)=>{
      if(queried.has(key))return;queried.add(key);
      if(++queries>256){truncated=true;return;}
      const limit=budget-values.size+1;
      const rows=await db.all(sql+" ORDER BY seq LIMIT ?",[...params,limit]);
      if(rows.length>=limit)truncated=true;
      add(rows);
    };
    if(selector.trayId)await fetchLinks("SELECT ref,payload FROM evidence WHERE tray_id=? AND (? IS NULL OR source_key=?) AND (? IS NULL OR host_generation=?) AND (? IS NULL OR agent_id=?)",[selector.trayId,selector.sourceInstanceId??null,selector.sourceInstanceId??null,selector.hostGenerationId??null,selector.hostGenerationId??null,selector.agentId??null,selector.agentId??null],"seed");
    else if(selector.agentId&&selector.stepId)await fetchLinks("SELECT ref,payload FROM evidence WHERE agent_id=? AND step_id=? AND (? IS NULL OR host_generation=?)",[selector.agentId,selector.stepId,selector.hostGenerationId??null,selector.hostGenerationId??null],"seed");
    else throw error("monitor_invalid_trace_selector");
    for(let i=0;i<queue.length&&queries<=256;i++){
      const e=projectAlertEvent(queue[i]);if(!e)continue;
      for(const [column,id] of [["tray_id",e.trayId],["decision_id",e.decisionId]] as const){
        if(id)await fetchLinks(`SELECT ref,payload FROM evidence WHERE ${column}=? AND source_key=? AND host_generation=?`,[id,e.sourceInstanceId,e.hostGenerationId],JSON.stringify([column,id,e.sourceInstanceId,e.hostGenerationId]));
      }
      if(e.failureId&&e.agentId)await fetchLinks("SELECT ref,payload FROM evidence WHERE failure_id=? AND agent_id=? AND host_generation=?",[e.failureId,e.agentId,e.hostGenerationId],JSON.stringify(["failure",e.failureId,e.agentId,e.hostGenerationId]));
      if(e.stepEvidence==="direct"&&e.stepId&&e.agentId)await fetchLinks("SELECT ref,payload FROM evidence WHERE step_id=? AND agent_id=? AND host_generation=?",[e.stepId,e.agentId,e.hostGenerationId],JSON.stringify(["step",e.stepId,e.agentId,e.hostGenerationId]));
    }
    const generations=[...new Set([...values.values()].map(value=>value&&typeof value==="object"&&"hostGenerationId" in value?value.hostGenerationId:undefined).filter(observationId))];
    for(const generation of generations)await fetchLinks("SELECT ref,payload FROM evidence WHERE host_generation=? AND json_extract(payload,'$.kind') IN ('observer_started','manager_attached')",[generation],`instrumentation:${generation}`);
    const raw=[...values.values()],sources=[...new Set(raw.map(projectAlertEvent).filter(e=>e!==null).map(e=>e.sourceInstanceId))];
    const health=sources.length?await db.all(`SELECT source_key,gaps,conflicts,last_sequence FROM source_health WHERE source_key IN (${sources.map(()=>"?").join(",")})`,sources):[];
    const report=traceAlerts(raw,selector,{complete:!truncated,source:"monitor_materialized_journal",conflictingSources:health.filter(row=>Number(row.conflicts)>0).map(row=>String(row.source_key))});
    return {...report,evidence:{...report.evidence,linkageTruncated:truncated,retentionFloor:Number((await meta(db)).evidence_floor??0),
      sourceSequenceCoverage:health.map(row=>({sourceInstanceId:String(row.source_key),knownMissingEvents:Number(row.gaps),conflicts:Number(row.conflicts),lastSequence:row.last_sequence}))}};
  });},
  async maintain(now=Date.now()){return mutate(async db=>{
    const before=number((await db.first("SELECT COUNT(*) AS n FROM evidence"))?.n),cutoff=now-retentionMs;
    // Small incremental batches. Active conditions/management facts are not
    // deleted to meet a count. A target is housekeeping pressure, not admission.
    const expired=await db.all("SELECT id FROM incidents WHERE category='occurrence' AND acknowledged=0 AND id NOT IN(SELECT incident_id FROM management) AND id NOT IN(SELECT parent_id FROM incidents WHERE parent_id IS NOT NULL) AND last_seen<? AND (snooze_until IS NULL OR snooze_until<?) LIMIT 1000",[cutoff,now]);
    for(const row of expired){await db.run("DELETE FROM incident_evidence WHERE incident_id=?",[uuid(row.id)]);await db.run("DELETE FROM incidents WHERE id=?",[uuid(row.id)]);}
    const floor=await db.first("SELECT MAX(seq) AS n FROM (SELECT seq FROM evidence WHERE (at_ms<? OR ?=1) AND ref NOT IN (SELECT event_ref FROM incident_evidence) ORDER BY seq LIMIT 1000)",[cutoff,before>eventTarget?1:0]);
    if(floor?.n!==null&&floor?.n!==undefined){await db.run("DELETE FROM evidence WHERE seq<=? AND (at_ms<? OR ?=1) AND ref NOT IN(SELECT event_ref FROM incident_evidence)",[number(floor.n),cutoff,before>eventTarget?1:0]);await db.run("UPDATE meta SET evidence_floor=MAX(evidence_floor,?)",[number(floor.n)]);}
    const eventFloor=await db.first("SELECT MAX(seq) AS n FROM (SELECT seq FROM events WHERE at_ms<? AND (incident_id IS NULL OR incident_id NOT IN(SELECT id FROM incidents WHERE status='open')) ORDER BY seq LIMIT 1000)",[cutoff]);
    if(eventFloor?.n!==null&&eventFloor?.n!==undefined){await db.run("DELETE FROM events WHERE seq<=? AND at_ms<? AND (incident_id IS NULL OR incident_id NOT IN(SELECT id FROM incidents WHERE status='open'))",[number(eventFloor.n),cutoff]);await db.run("UPDATE meta SET event_floor=MAX(event_floor,?)",[number(eventFloor.n)]);}
    // A short page-reclamation slice, never a full-image rewrite or a GET side effect.
    await db.run("PRAGMA incremental_vacuum(128)");
    const after=number((await db.first("SELECT COUNT(*) AS n FROM evidence"))?.n);return {removedEvidence:before-after,remainingEvidence:after,pressure:after>eventTarget,lifetimeEventLimit:null,managementRetained:true};
  });},
  async storageHealth(){return read(async db=>{const m=await meta(db);const info=await stat(file);return {engine:"sqlite-disk",schemaVersion:m.version,fileBytes:info.size,lifetimeEventLimit:null,sources:m.version===VERSION?await db.all("SELECT * FROM source_health ORDER BY source_key LIMIT 200"):[],migrationRequired:m.version!==VERSION};});},
 };
 return api;
}
export type MonitorStore=ReturnType<typeof openMonitorStore>;

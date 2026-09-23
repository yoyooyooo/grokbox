import { link, lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { MONITOR_POLICY, MONITOR_RULES, confirmedObservation, projectMonitorOwnershipDiagnosis, monitorFreshness, monitorScope, monitorTargets, monitorUuid, type MonitorRule, type MonitorSample } from "@grokbox/runtime-kernel/monitor";
import { traceAlerts, observationId, projectAlertEvent, projectNotification, chooseNotification, type AlertTraceSelector } from "@grokbox/runtime-kernel/alerts";
import { monitorProcessIdentity as processStart } from "./monitor-owner.node.ts";
import { MonitorSqlite, openMonitorSqlite, privateMonitorDirectory, type SqlRow as Row } from "./monitor-sqlite.node.ts";
import { projectControlEvent } from "./journal.node.ts";
import { recordSourceSequence } from "./monitor-source-sequence.node.ts";
import { indexHostHealthCondition } from "./monitor-host-health.node.ts";
import { indexExecutionOccurrence, retainedDiagnosis } from "./monitor-occurrence.node.ts";
import { indexProviderRouteCondition, projectProviderRouteDiagnosis } from "./monitor-provider-route.node.ts";
import { OBSERVATION_INCIDENT_RULES, OBSERVATION_RETENTION, type EvidenceView } from "@grokbox/runtime-kernel/observation";
import { INCIDENT_EVIDENCE_SCHEMA, captureIncidentEvidence, readIncidentEvidence, noticeForWork, collectIncidentEvidence } from "./incident-evidence.node.ts";
import { indexNativeIncident, indexExecutionProgress, recordSourceGap, detectUnsettledExecutions } from "./monitor-incident-intake.node.ts";
import { retireObservationDetails, sqlitePhysicalUsage } from "./observation-retention.node.ts";
import { capMonitorDatabase, monitorDatabaseBytes, monitorWriteAdmission, monitorAuxiliaryUsage } from "./monitor-storage.node.ts";
import { notificationOutbox, NOTIFICATION_SCHEMA } from "./notification-outbox.node.ts";
import { MONITOR_SCHEMA_VERSION } from "./monitor-schema.node.ts";
import type { NativeRunHealth } from "@grokbox/runtime-kernel/observation";
import { DiagnosticBudgetError, withDiagnosticAdmission } from "../host/diagnostic-budget.node.ts";
const VERSION=MONITOR_SCHEMA_VERSION;
// Preserve a caller's denied commit check through the SQLite rollback boundary,
// without teaching this storage adapter about HTTP or management principals.
class ManagementCommitRefused extends BoxRuntimeError {
 constructor(readonly failure:unknown){super("invalid_usage","monitor_management_commit_refused");}
}
const error=(message:string)=>new BoxRuntimeError("invalid_usage",message);
const number=(v:unknown):number=>{if(typeof v!=="number"||!Number.isSafeInteger(v)||v<0)throw error("monitor_store_invalid");return v;};
const uuid=(v:unknown):string=>{if(!monitorUuid(v))throw error("monitor_store_invalid");return v;};
const scope=(v:unknown):string=>{if(!monitorScope(v))throw error("monitor_store_invalid");return v;};
const nullableTime=(v:unknown)=>v===null?null:number(v);
const harness=(v:unknown):"box"|"temporal"|null=>{if(v!==null&&v!=="box"&&v!=="temporal")throw error("monitor_store_invalid");return v;};
const missing=(e:unknown)=>e!==null&&typeof e==="object"&&"code"in e&&e.code==="ENOENT";
const RUNTIME_RULES=["execution_failure","pre_step_failure","shared_runtime_failure","upstream_route_failure",...OBSERVATION_INCIDENT_RULES] as const;
const rule=(v:unknown)=>{if(![...MONITOR_RULES,...RUNTIME_RULES].includes(v as never))throw error("monitor_store_invalid");return v as MonitorRule|typeof RUNTIME_RULES[number];};
const SCHEMA=`
PRAGMA user_version=${VERSION};
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
export type MonitorStoreOptions={beforePublish?:()=>void;afterRename?:()=>void;retentionMs?:number;summaryMs?:number;eventTarget?:number;maxDatabaseBytes?:number};
/** Existing observation domain, incremental disk transactions. No alerts DB,
 * no modeld authority, no query-time initialization or retention mutation. */
export function openMonitorStore(root:string,options:MonitorStoreOptions={}){
 const rootId=sha256Text(canonicalJson(["grokbox-observability-v1",resolve(root)]));
 const directory=join(resolve(root),"observability"),file=join(directory,"observations.sqlite");
 const retentionMs=options.retentionMs??MONITOR_POLICY.retentionMs,summaryMs=options.summaryMs??OBSERVATION_RETENTION.summaryMs,eventTarget=options.eventTarget??MONITOR_POLICY.evidenceTarget;
 if(!Number.isSafeInteger(summaryMs)||summaryMs<retentionMs)throw error("monitor_invalid_policy");
 const maxDatabaseBytes=monitorDatabaseBytes(options.maxDatabaseBytes);
 if(!Number.isSafeInteger(retentionMs)||retentionMs<1||!Number.isSafeInteger(eventTarget)||eventTarget<1)throw error("monitor_invalid_policy");
 const meta=async(db:MonitorSqlite)=>{const m=await db.first("SELECT * FROM meta WHERE singleton=1");if(!m)throw error("monitor_store_invalid");return m;};
 const checkIdentity=async(db:MonitorSqlite)=>{
  const m=await meta(db),header=await db.first("PRAGMA user_version");
  if(m.root_id!==rootId||!monitorUuid(m.database_id)||m.version!==VERSION||header?.user_version!==VERSION)throw error("monitor_store_schema_or_root_mismatch");
  return m;
 };
 async function load(mode:"read"|"write"="read"){
  let db:MonitorSqlite|undefined;
  try{db=await openMonitorSqlite(file,mode);await checkIdentity(db);
   if(mode==="write")await capMonitorDatabase(db,maxDatabaseBytes);return db;
  }catch(e){await db?.close().catch(()=>{});throw e instanceof BoxRuntimeError?e:error(missing(e)?"monitor_not_initialized":e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_reader_busy":"monitor_store_unavailable");}
 }
 async function read<T>(f:(db:MonitorSqlite)=>Promise<T>):Promise<T>{const db=await load();try{await db.run("BEGIN");await checkIdentity(db);return await f(db);}catch(e){throw e instanceof BoxRuntimeError?e:error(e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_reader_busy":"monitor_store_unavailable");}finally{await db.close();}}
 // Foreign owner footprints are not ours to delete or recover by PID age.
 // They block writes, but are never parsed as a supported lock protocol.
 async function foreignOwnerPresent(){
  for(const name of ["writer.lock","collector.lock"]){try{await lstat(join(directory,name));return true;}catch(e){if(!missing(e))throw e;}}
  return false;
 }
 async function admission<T>(writer:"monitor"|"monitor-initialize",f:()=>Promise<T>,maintenance=false):Promise<T>{
  try{return await withDiagnosticAdmission({configurationRoot:resolve(root),sourceRoot:resolve(root),writer,maxBytes:maxDatabaseBytes,maintenance},f);}
  catch(e){if(e instanceof DiagnosticBudgetError)throw error(e.reason==="busy"?"monitor_writer_busy":e.reason==="pressure"?"monitor_storage_pressure":"monitor_storage_scope_unavailable");throw e;}
 }
 async function mutate<T>(f:(db:MonitorSqlite)=>Promise<T>,maintenance=false):Promise<T>{return admission("monitor",async()=>{
  if(await foreignOwnerPresent())throw error("monitor_writer_busy");
  const db=await load("write");let committed=false,commitAttempted=false,commitUncertain=false;
  try{await db.run("BEGIN IMMEDIATE");await checkIdentity(db);const result=await f(db);options.beforePublish?.();commitAttempted=true;await db.run("COMMIT");committed=true;options.afterRename?.();return result;
  }catch(e){
   let rolledBack=false;if(!committed){try{await db.run("ROLLBACK");rolledBack=true;}catch{ /* A failed rollback is not proof of no commit. */ }}
   commitUncertain=committed||(commitAttempted&&!rolledBack);
   if(commitUncertain)throw error("monitor_commit_unknown");
   throw e instanceof BoxRuntimeError?e:error(e&&typeof e==="object"&&"code"in e&&e.code==="SQLITE_FULL"?"monitor_storage_pressure":e&&typeof e==="object"&&"code"in e&&["SQLITE_BUSY","SQLITE_LOCKED"].includes(String(e.code))?"monitor_writer_busy":"monitor_commit_failed");
  }finally{try{await db.close();}catch{throw error(committed||commitUncertain?"monitor_commit_unknown":"monitor_store_unavailable");}}
 },maintenance);}
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
  return {id:uuid(row.id),scopeId:scope(row.scope),agentId:row.agent_id===null?null:uuid(row.agent_id),rule:rule(row.rule),status:String(row.status),category:String(row.category??"condition"),parentIncidentId:monitorUuid(row.parent_id)?row.parent_id:null,diagnosis:row.rule==="upstream_route_failure" && typeof row.summary_json==="string" ? projectProviderRouteDiagnosis(JSON.parse(row.summary_json)) : row.rule==="observation_unavailable" && typeof row.summary_json==="string" ? projectMonitorOwnershipDiagnosis(JSON.parse(row.summary_json)) : retainedDiagnosis(row.summary_json),
   firstSeenAtMs:number(row.first_seen),lastSeenAtMs:number(row.last_seen),resolvedAtMs:nullableTime(row.resolved_at),revision:number(row.revision),acknowledged:number(row.acknowledged)===1,snoozeUntilMs:nullableTime(row.snooze_until)};
 }
 function getEvent(row:Row){const allowed=["collector_started","observation_gap","collector_stopped","scope_changed","ownership_changed","incident_opened","incident_resolved","incident_ack","incident_snooze","execution_failure_observed","source_conflict","notification_decided","notification_exported","notification_export_unknown"];
  if(!allowed.includes(String(row.kind)))throw error("monitor_store_invalid");return {seq:number(row.seq),eventId:uuid(row.id),collectorEpoch:uuid(row.epoch),kind:String(row.kind),scopeId:scope(row.scope),agentId:row.agent_id===null?null:uuid(row.agent_id),incidentId:row.incident_id===null?null:uuid(row.incident_id),observedAtMs:number(row.at_ms),previousHarness:harness(row.before_harness),currentHarness:harness(row.after_harness),observationIntervalStartMs:nullableTime(row.interval_start), ...(typeof row.detail_json === "string" ? { notification: projectNotification(JSON.parse(row.detail_json)) } : {})};
 }
 async function notificationDecisions(db:MonitorSqlite,changes:ReturnType<typeof getEvent>[],at:number,enabled=true){
  const result:Array<{eventId:string;incidentId:string;deliveryKey:string;decision:"emit"|"suppress";reason:"new_occurrence"|"acknowledged"|"snoozed"|"aggregated";channel:"local_only"}>=[];
  for(const e of changes){if(!e.incidentId||!["incident_opened","execution_failure_observed"].includes(e.kind))continue;const row=await db.first("SELECT * FROM incidents WHERE id=?",[e.incidentId]);if(!row)continue;
   const chosen=chooseNotification({acknowledged:row.acknowledged===1,snoozeUntilMs:row.snooze_until===null?null:Number(row.snooze_until),nowMs:at,parentIncidentId:monitorUuid(row.parent_id)?row.parent_id:null});
   try { await captureIncidentEvidence(db,e.incidentId,at,{detailMs:retentionMs,summaryMs,prepareNotification:enabled&&chosen.decision==="emit",maxDatabaseBytes}); }
   catch (failure) {
    if (!(failure instanceof BoxRuntimeError) || !["monitor_storage_pressure","monitor_evidence_revisions_protected","monitor_evidence_alias_budget"].includes(failure.message)) throw failure;
    await db.run("UPDATE observation_maintenance SET pressure_state='storage_pressure' WHERE singleton=1");
    // The incident remains durable. No ready notice may claim a missing snapshot.
    continue;
   }
   if(!enabled)continue; // Evidence survives; notification policy never controls domain operations.
   const decision={eventId:e.eventId,incidentId:e.incidentId,deliveryKey:sha256Text(`${e.incidentId}:${e.eventId}:local-v1`),...chosen};
   result.push(decision);
   await db.run("INSERT INTO events(id,epoch,kind,scope,agent_id,incident_id,at_ms,detail_json) VALUES(?,?,'notification_decided',?,?,?,?,?)",[randomUUID(),e.collectorEpoch,e.scopeId,e.agentId,e.incidentId,at,canonicalJson({...decision,ruleVersion:"monitor-local-v1"})]);
  }return result;
 }
 const api={
  ...notificationOutbox({rootId,maxDatabaseBytes,read,mutate}),
  path:file,
  async initialize(){return admission("monitor-initialize",async()=>{
   await mkdir(root,{recursive:true,mode:0o700});await privateMonitorDirectory(resolve(root));
   const reopen=async()=>{
    await privateMonitorDirectory(directory);
    if(!await lstat(file).catch(e=>{if(!missing(e))throw e;return null;}))throw error("monitor_store_unavailable");
    return read(async db=>{const m=await meta(db);return {databaseId:uuid(m.database_id),created:false};});
   };
   const existingOwner=await lstat(directory).catch(e=>{if(!missing(e))throw e;return null;});
   if(existingOwner)return reopen();
   try{await mkdir(directory,{mode:0o700});}
   catch(e){if(e&&typeof e==="object"&&"code"in e&&e.code==="EEXIST")return reopen();throw e;}
   const ownedDirectory=await lstat(directory);
   // Only the creator of a new owner directory can publish its first ledger.
   // A crash or missing file inside an existing owner is not a fresh history.
   // An orderly pre-publication failure can remove only its own empty directory.
   {
    const staging=join(directory,`.observations-init-${randomUUID()}.sqlite`);
    let fresh:MonitorSqlite|undefined,published=false;
    try{
     fresh=await openMonitorSqlite(staging,"create");
     await capMonitorDatabase(fresh,maxDatabaseBytes);
     await fresh.run("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL; BEGIN IMMEDIATE;");
     await fresh.run(SCHEMA+EVIDENCE_SCHEMA+INCIDENT_EVIDENCE_SCHEMA+NOTIFICATION_SCHEMA);const databaseId=randomUUID();
     await fresh.run("INSERT INTO meta(singleton,version,database_id,root_id) VALUES(1,?,?,?)",[VERSION,databaseId,rootId]);
     options.beforePublish?.();await fresh.run("COMMIT");await fresh.close();fresh=undefined;
     const currentDirectory=await lstat(directory);
     if(currentDirectory.dev!==ownedDirectory.dev||currentDirectory.ino!==ownedDirectory.ino)throw error("monitor_store_unavailable");
     try{await link(staging,file);published=true;}
     catch(e){
      if(!(e&&typeof e==="object"&&"code"in e&&e.code==="EEXIST"))throw e;
      return read(async current=>{const m=await meta(current);return {databaseId:uuid(m.database_id),created:false};});
     }
     await unlink(staging);const parent=await open(directory,"r");try{await parent.sync();}finally{await parent.close();}
     const ownerParent=await open(resolve(root),"r");try{await ownerParent.sync();}finally{await ownerParent.close();}
     options.afterRename?.();return {databaseId,created:true};
    }catch(e){
     await fresh?.run("ROLLBACK").catch(()=>{});
     throw e instanceof BoxRuntimeError?e:error(published?"monitor_commit_unknown":"monitor_initialization_failed");
    }finally{
     await fresh?.close();
     const currentDirectory=await lstat(directory).catch(()=>null);
     if(currentDirectory?.dev===ownedDirectory.dev&&currentDirectory.ino===ownedDirectory.ino){
      await unlink(staging).catch(()=>{});
      if(!published)await rmdir(directory).catch(()=>{}); // Never recursive; preserve every other entry.
     }
    }
   }
  });},
  async begin(epoch:string,at:number,agentIds:string[]){
   if(!monitorUuid(epoch)||number(at)===0)throw error("monitor_invalid_epoch");const ids=monitorTargets(agentIds,true),owner=await processStart(process.pid);
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
  async record(epoch:string,sampleNumber:number,sample:MonitorSample,notificationsMode?:"off"){
   if(!monitorUuid(epoch)||!monitorUuid(sample.sampleId)||!Number.isSafeInteger(sampleNumber)||sampleNumber<1||!Array.isArray(sample.agents)||sample.agents.length>MONITOR_POLICY.maxTargets||!Number.isSafeInteger(sample.startedAtMs)||sample.startedAtMs<1||sample.completedAtMs<sample.startedAtMs)throw error("monitor_invalid_sample");
   return mutate(async db=>{const current=await meta(db),digest=sha256Text(canonicalJson(sample));if(current.epoch!==epoch||current.running!==1)throw error("monitor_epoch_changed");
    if(sampleNumber===current.last_number&&sample.sampleId===current.last_sample_id&&digest===current.last_digest)return {duplicate:true,sampleNumber,events:[] as ReturnType<typeof getEvent>[],notifications:[]};
    const previousSeq=await lastSequence(db);if(sampleNumber!==number(current.last_number)+1||sample.completedAtMs<number(current.heartbeat))throw error("monitor_stale_sample");const at=number(sample.completedAtMs);
    if(sample.failure||!sample.scopeId){
     await incident(db,epoch,rootId,null,"observation_unavailable",true,at);
     const diagnosis=projectMonitorOwnershipDiagnosis({version:1,source:"monitor_ownership_read",observedAtMs:at,
      failure:sample.failure??"scope_unavailable",readObservation:sample.readObservation});
     // Reuse this condition's bounded summary, in the existing sample transaction.
     // A newer uninstrumented failure must not inherit an earlier read's subcode.
     await db.run("UPDATE incidents SET summary_json=? WHERE scope=? AND agent_id IS NULL AND rule='observation_unavailable' AND status='open' AND occurrence_key=''",
      [diagnosis?canonicalJson(diagnosis):null,rootId]);
     await db.run("UPDATE observations SET latest_success=0,last_attempt=? WHERE scope IS ?",[at,current.current_scope as string|null]);
    }
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
    const notifications=await notificationDecisions(db,events,at,notificationsMode!=="off");
    return {duplicate:false,sampleNumber,events:(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previousSeq])).map(getEvent),notifications};
   });
  },
  async snapshot(now=Date.now()){return read(async db=>{const m=await meta(db),epoch=m.epoch===null?null:uuid(m.epoch),sid=m.current_scope===null?null:scope(m.current_scope),cursor=await lastSequence(db);
   const rows=await db.all("SELECT w.agent_id AS watched_id,o.* FROM watched w LEFT JOIN observations o ON o.agent_id=w.agent_id AND o.scope IS ? ORDER BY w.agent_id",[sid]);
   const observationHealth=await db.first("SELECT pressure_state,dropped_events,rejected_batches,last_state FROM observation_maintenance WHERE singleton=1");
   return {observationHealth,schemaVersion:number(m.version),databaseId:uuid(m.database_id),collectorEpoch:epoch,source:"local_observations_not_authority",scopeId:sid,cursor:`${m.database_id}:${epoch??"none"}:${cursor}`,lastHeartbeatMs:nullableTime(m.heartbeat),collectorRecordedRunning:m.running===1,lastObservedGatewayEpoch:typeof m.gateway_epoch==="string"?m.gateway_epoch:null,admissionAuthority:false,productionAccepted:false,notificationMode:"local_only",storage:{engine:"sqlite-disk",journalMode:"delete",lifetimeEventLimit:null},
    agents:rows.map(row=>row.state===null?{agentId:uuid(row.watched_id),lastKnown:null,lastAttemptMs:nullableTime(m.heartbeat),lastSuccessMs:null,freshness:"unavailable" as const}:{agentId:uuid(row.agent_id),lastKnown:{state:String(row.state),serverHarness:harness(row.server_harness),localHarness:harness(row.local_harness)},lastAttemptMs:number(row.last_attempt),lastSuccessMs:nullableTime(row.last_success),freshness:monitorFreshness(nullableTime(row.last_success),now,m.running===1&&row.latest_success===1)})};});},
  async incidentEvidence(incidentId:string,revision?:number,view:EvidenceView="local-diagnostic"){
   if(!monitorUuid(incidentId)||(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))||!["local-diagnostic","bot-diagnostic","public-summary"].includes(view))throw error("monitor_invalid_evidence_selector");
   return read(async db=>{return readIncidentEvidence(db,incidentId,revision,view);});
  },
  async resolveIncident(selector:{agentId?:string;stepId?:string;trayId?:string}){
   if((selector.stepId!==undefined&&(!observationId(selector.stepId)||!monitorUuid(selector.agentId)))||(selector.trayId!==undefined&&!observationId(selector.trayId))||Number(selector.stepId!==undefined)+Number(selector.trayId!==undefined)!==1)throw error("monitor_invalid_evidence_selector");
   return read(async db=>{const rows=await db.all("SELECT DISTINCT i.id FROM incidents i JOIN incident_evidence l ON l.incident_id=i.id JOIN evidence e ON e.ref=l.event_ref WHERE (? IS NULL OR e.agent_id=?) AND (? IS NULL OR e.step_id=?) AND (? IS NULL OR e.tray_id=?) LIMIT 2",[selector.agentId??null,selector.agentId??null,selector.stepId??null,selector.stepId??null,selector.trayId??null,selector.trayId??null]);
    if(rows.length!==1)throw error(rows.length?"monitor_incident_ambiguous":"monitor_incident_not_found");return String(rows[0]!.id);});
  },
  async captureIncident(incidentId:string,now=Date.now()){
   if(!monitorUuid(incidentId)||!Number.isSafeInteger(now)||now<1)throw error("monitor_invalid_evidence_selector");
   return mutate(db=>captureIncidentEvidence(db,incidentId,now,{detailMs:retentionMs,summaryMs,maxDatabaseBytes}));
  },
  async evidenceLease(input:{incidentId:string;revision:number;durationMs:number;nowMs:number}){
   if(!monitorUuid(input.incidentId)||!Number.isSafeInteger(input.revision)||input.revision<1||!Number.isSafeInteger(input.durationMs)||input.durationMs<1||input.durationMs>OBSERVATION_RETENTION.leaseMaxTotalMs||!Number.isSafeInteger(input.nowMs)||input.nowMs<1)throw error("monitor_invalid_evidence_lease");
   return mutate(async db=>{
    const row=await db.first("SELECT * FROM incident_snapshots WHERE incident_id=? AND revision=?",[input.incidentId,input.revision]);
    if(!row||row.tier!=="detail"||Number(row.expires_at)<=input.nowMs)throw error("monitor_evidence_expired");
    const existing=await db.first("SELECT * FROM evidence_leases WHERE incident_id=? AND revision=?",[input.incidentId,input.revision]);
    const last=await db.first("SELECT last_at FROM observation_maintenance WHERE singleton=1");
    if(input.nowMs<Math.max(Number(row.created_at),Number(row.lease_origin_at??0),Number(existing?.created_at??0),Number(last?.last_at??0)))throw error("monitor_evidence_clock_unavailable");
    const origin=row.lease_origin_at===null?input.nowMs:Number(row.lease_origin_at);
    const expiresAtMs=Math.min(Math.max(Number(existing?.expires_at??0),input.nowMs+input.durationMs),origin+OBSERVATION_RETENTION.leaseMaxTotalMs,Number(row.summary_expires_at));
    if(expiresAtMs<=input.nowMs)throw error("monitor_evidence_lease_exhausted");
    const leases=await db.first("SELECT COALESCE(SUM(reserved_bytes),0) AS n,COUNT(*) AS count FROM evidence_leases WHERE expires_at>?",[input.nowMs]);
    const active=existing&&Number(existing.expires_at)>input.nowMs;
    const reserved=Number(leases?.n??0)-(active?Number(existing.reserved_bytes):0),bytes=Number(row.logical_bytes);
    if(!active&&Number(leases?.count??0)>=OBSERVATION_RETENTION.maxActiveLeases)throw error("monitor_evidence_lease_budget");
    const fileBytes=(await stat(file)).size;
    if(fileBytes+reserved+bytes>OBSERVATION_RETENTION.maxBytes-OBSERVATION_RETENTION.reserveBytes)throw error("monitor_storage_pressure");
    await db.run("UPDATE incident_snapshots SET lease_origin_at=COALESCE(lease_origin_at,?) WHERE incident_id=? AND revision=?",[origin,input.incidentId,input.revision]);
    // A single shared protection slot per immutable revision. Repeated requests
    // extend within the original lifetime, not append unbounded reservation rows.
    const leaseId=existing?String(existing.id):randomUUID();await db.run("INSERT INTO evidence_leases(id,incident_id,revision,created_at,expires_at,reserved_bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(incident_id,revision) DO UPDATE SET expires_at=excluded.expires_at,reserved_bytes=excluded.reserved_bytes",[leaseId,input.incidentId,input.revision,input.nowMs,expiresAtMs,bytes]);
    return {leaseId,incidentId:input.incidentId,evidenceRevision:input.revision,reservedUntil:expiresAtMs,reservedBytes:bytes};
   });
  },
  async notificationWork(limit=100){
   if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw error("monitor_invalid_limit");
   return read(db=>db.all("SELECT id,incident_id AS incidentId,evidence_revision AS evidenceRevision,state,created_at AS createdAtMs,expires_at AS expiresAtMs,last_reason AS lastReason FROM notification_work ORDER BY created_at DESC LIMIT ?",[limit]));
  },
  async notificationNotice(workId:string){if(!monitorUuid(workId))throw error("notification_invalid_work");return read(db=>noticeForWork(db,workId));},
  async linkedEvidenceIncidents(refs:readonly string[]){
   if(refs.length>64||refs.some(ref=>typeof ref!=="string"||ref.length>512||/[\x00-\x1f]/.test(ref)))throw error("monitor_invalid_evidence_refs");
   return read(async db=>{
    if(!refs.length)return [];
    const rows=await db.all(`SELECT DISTINCT i.id AS incident_id,w.id AS work_id,w.evidence_revision,w.state,
      (SELECT MAX(revision) FROM incident_snapshots WHERE incident_id=i.id) AS captured_revision,
      EXISTS(SELECT 1 FROM events e WHERE e.incident_id=i.id AND e.kind='notification_export_unknown') AS export_unknown,
      EXISTS(SELECT 1 FROM notification_attempts a WHERE a.work_id=w.id AND a.state IN ('reserved','attempting','unknown')) AS attempt_unknown
      FROM incident_evidence l JOIN incidents i ON i.id=l.incident_id LEFT JOIN notification_work w ON w.incident_id=i.id
      WHERE l.event_ref IN (${refs.map(()=>"?").join(",")}) ORDER BY i.id LIMIT 65`,[...refs]);
    if(rows.length>64)throw error("monitor_evidence_receipt_budget");
    return rows.map(row=>({incidentId:uuid(row.incident_id),evidenceRevision:nullableTime(row.evidence_revision??row.captured_revision??null),
      workId:row.work_id?uuid(row.work_id):null,outboxState:row.export_unknown||row.attempt_unknown?"unknown":["preparing","ready","blocked","attempting","unknown","expired","completed","superseded"].includes(String(row.state))?String(row.state):"not_prepared",
      transport:"unavailable" as const,automaticRetry:false as const}));
   });
  },
  async detectUnsettled(input:{nowMs:number;sourceLiveness:ReadonlyMap<string,number>;nativeRuns?:NativeRunHealth;epoch?:string;notifications?:"off"}){
   return mutate(async db=>{const m=await meta(db);if(m.running!==1)throw error("monitor_not_running");
    if(input.epoch!==undefined&&input.epoch!==m.epoch)throw error("monitor_epoch_changed");
    const epoch=uuid(m.epoch),before=await lastSequence(db);
    const result=await detectUnsettledExecutions(db,{rootId,...input,opened:(id,agent)=>event(db,epoch,"execution_failure_observed",rootId,agent,input.nowMs,id)});
    const changes=(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[before])).map(getEvent);
    const notifications=await notificationDecisions(db,changes,input.nowMs,input.notifications!=="off");
    return {...result,changes:(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[before])).map(getEvent),notifications};});
  },
  async incidents(){return read(async db=>{const rows=await db.all("SELECT * FROM incidents ORDER BY first_seen DESC,id LIMIT 201");if(rows.length>MONITOR_POLICY.maxPage)throw error("monitor_use_incident_pagination");return rows.map(getIncident);});},
  async incidentPage(after?:string,limit:number=MONITOR_POLICY.maxPage){if(!Number.isSafeInteger(limit)||limit<1||limit>MONITOR_POLICY.maxPage)throw error("monitor_invalid_limit");return read(async db=>{const m=await meta(db);let before=Number.MAX_SAFE_INTEGER,id="";
   if(after){const p=after.split(":");if(p.length!==5||p[0]!==m.database_id||p[1]!==String(m.epoch??"none")||p[2]!=="incidents"||!/^\d+$/.test(p[3]!)||!Number.isSafeInteger(Number(p[3]))||!monitorUuid(p[4]))throw error("monitor_cursor_invalid");before=Number(p[3]);id=p[4]!;}
   const rows=await db.all("SELECT * FROM incidents WHERE first_seen<? OR(first_seen=? AND id>?) ORDER BY first_seen DESC,id LIMIT ?",[before,before,id,limit+1]),selected=rows.slice(0,limit).map(getIncident),last=selected.at(-1);
   return {databaseId:uuid(m.database_id),collectorEpoch:m.epoch===null?null:uuid(m.epoch),incidents:selected,hasMore:rows.length>limit,cursor:last?`${m.database_id}:${m.epoch??"none"}:incidents:${last.firstSeenAtMs}:${last.id}`:after??null};});},
  async events(after?:string,limit:number=MONITOR_POLICY.maxPage){if(!Number.isSafeInteger(limit)||limit<1||limit>MONITOR_POLICY.maxPage)throw error("monitor_invalid_limit");return read(async db=>{const m=await meta(db);let seq=Number(m.event_floor??0);
   if(after){const p=after.split(":");if(p.length!==3||p[0]!==m.database_id||p[1]!==String(m.epoch??"none")||!/^\d+$/.test(p[2]!))throw error("monitor_cursor_invalid");seq=Number(p[2]);if(!Number.isSafeInteger(seq)||seq>await lastSequence(db))throw error("monitor_cursor_invalid");if(seq<Number(m.event_floor??0))throw error("monitor_cursor_expired");}
   const rows=await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?",[seq,limit+1]),selected=rows.slice(0,limit).map(getEvent);return {entries:selected,hasMore:rows.length>limit,cursor:`${m.database_id}:${m.epoch??"none"}:${selected.at(-1)?.seq??seq}`,retentionFloor:Number(m.event_floor??0)};});},
  async incidentById(databaseId:string,incidentId:string){
   if(!monitorUuid(databaseId)||!monitorUuid(incidentId))throw error("monitor_invalid_management");
   return read(async db=>{const m=await meta(db);if(m.database_id!==databaseId)throw error("monitor_database_changed");
    const row=await db.first("SELECT * FROM incidents WHERE id=?",[incidentId]);return row?getIncident(row):null;});
  },
  async managementReceipt(databaseId:string,requestId:string){
   if(!monitorUuid(databaseId)||!monitorUuid(requestId))throw error("monitor_invalid_management");
   return read(async db=>{if((await meta(db)).database_id!==databaseId)throw error("monitor_database_changed");
    const row=await db.first("SELECT * FROM management WHERE request_id=?",[requestId]);if(!row)return null;
    if(!["ack","snooze"].includes(String(row.action))||typeof row.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(row.fingerprint))throw error("monitor_store_invalid");
    return {incidentId:uuid(row.incident_id),appliedRevision:number(row.revision),action:row.action as "ack"|"snooze",fingerprint:row.fingerprint};});
  },
  async manage(input:{requestId:string;incidentId:string;expectedRevision:number;action:"ack"|"snooze";untilMs?:number;nowMs:number;databaseId?:string},beforeCommit?:()=>Promise<void>){
   if(!monitorUuid(input.requestId)||!monitorUuid(input.incidentId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.expectedRevision>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(input.nowMs)||input.nowMs<1||!["ack","snooze"].includes(input.action)||(input.databaseId!==undefined&&!monitorUuid(input.databaseId)))throw error("monitor_invalid_management");
   if(input.action==="snooze"?!Number.isSafeInteger(input.untilMs):input.untilMs!==undefined)throw error("monitor_invalid_snooze");
   const fingerprint=sha256Text(canonicalJson([input.incidentId,input.expectedRevision,input.action,input.untilMs??null]));
   // Replay is a read, before current revision, snooze expiry, capacity or writer
   // admission. The same checks run again in the write transaction to close races.
   const prior=await read(async db=>{if(input.databaseId!==undefined&&(await meta(db)).database_id!==input.databaseId)throw error("monitor_database_changed");return db.first("SELECT * FROM management WHERE request_id=?",[input.requestId]);});
   const replay=(row:Row)=>{if(row.fingerprint!==fingerprint)throw error("monitor_request_conflict");return {requestId:input.requestId,incidentId:uuid(row.incident_id),appliedRevision:number(row.revision),duplicate:true,repaired:false};};
   if(prior)return replay(prior);
   return mutate(async db=>{
    const m=await meta(db);if(input.databaseId!==undefined&&m.database_id!==input.databaseId)throw error("monitor_database_changed");
    const prior=await db.first("SELECT * FROM management WHERE request_id=?",[input.requestId]);if(prior)return replay(prior);
    if(input.action==="snooze"&&(input.untilMs!<=input.nowMs||input.untilMs!-input.nowMs>MONITOR_POLICY.maxSnoozeMs))throw error("monitor_invalid_snooze");
    if(number((await db.first("SELECT COUNT(*) AS n FROM management"))?.n)>=MONITOR_POLICY.maxManagementReceipts)throw error("monitor_management_full");
    const row=await db.first("SELECT * FROM incidents WHERE id=?",[input.incidentId]);if(!row)throw error("monitor_incident_not_found");if(row.status==="resolved")throw error("monitor_incident_resolved");if(row.revision!==input.expectedRevision)throw error("monitor_revision_conflict");
    // All awaited policy/receipt/revision reads precede current write authority.
    // Refusal rolls back this same transaction before any incident/event write.
    try{await beforeCommit?.();}catch(failure){throw new ManagementCommitRefused(failure);}
    await db.run(input.action==="ack"?"UPDATE incidents SET acknowledged=1,revision=revision+1 WHERE id=?":"UPDATE incidents SET snooze_until=?,revision=revision+1 WHERE id=?",input.action==="ack"?[input.incidentId]:[input.untilMs!,input.incidentId]);const revision=input.expectedRevision+1;
    await db.run("INSERT INTO management(request_id,fingerprint,incident_id,revision,action) VALUES(?,?,?,?,?)",[input.requestId,fingerprint,input.incidentId,revision,input.action]);await event(db,uuid(m.epoch),`incident_${input.action}`,scope(row.scope),row.agent_id===null?null:uuid(row.agent_id),number(input.nowMs),input.incidentId);
    return {requestId:input.requestId,incidentId:input.incidentId,appliedRevision:revision,duplicate:false,repaired:false};}).catch(failure=>{if(failure instanceof ManagementCommitRefused)throw failure.failure;throw failure;});
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
  async evidenceSourceStatus(sourceKey:string){
   if(!monitorScope(sourceKey))throw error("monitor_invalid_source");
   return read(async db=>{
    const cursor=await db.first("SELECT cursor,gap FROM evidence_cursors WHERE source_key=?",[sourceKey]);
    const health=await db.first("SELECT last_sequence,last_event_at,gaps,conflicts FROM source_health WHERE source_key=?",[sourceKey]);
    return {cursor:cursor?String(cursor.cursor):null,gap:cursor?.gap??null,
      lastSequence:health?.last_sequence??null,knownMissingEvents:health?number(health.gaps):null,
      conflicts:health?number(health.conflicts):null,lastEventAtMs:health?.last_event_at??null,
      coverage:health?"observed_window":"not_observed",quietPeriodProven:false};
   });
  },
  async evidenceCursor(sourceKey:string){return read(async db=>{const row=await db.first("SELECT * FROM evidence_cursors WHERE source_key=?",[sourceKey]);return row?{cursor:String(row.cursor),gap:row.gap===null?null:String(row.gap)}:null;});},
  async ingestEvidence(input:{epoch:string;sourceKey:string;expectedCursor:string|null;nextCursor:string;events:unknown[];atMs:number;gap?:string;notifications?:"off";sourceHealth?:unknown}){
   if(!monitorUuid(input.epoch)||!monitorScope(input.sourceKey)||input.nextCursor.length>2048||input.events.length>4096||!Number.isSafeInteger(input.atMs)||input.atMs<1)throw error("monitor_invalid_evidence_batch");
   const safe=input.events.map(value=>{try{return projectControlEvent(value);}catch{return null;}}).filter((x):x is NonNullable<typeof x>=>x!==null),digest=sha256Text(canonicalJson({events:safe,gap:input.gap??null,rejected:input.events.length-safe.length}));
   const skipPressure=async(db:MonitorSqlite)=>{
    const m=await meta(db);if(m.epoch!==input.epoch||m.running!==1)throw error("monitor_epoch_changed");
    const current=await db.first("SELECT cursor,batch_digest FROM evidence_cursors WHERE source_key=?",[input.sourceKey]);
    if(current?.cursor===input.nextCursor&&current.batch_digest===digest)return {duplicate:true,inserted:0,conflicts:0,retirementSkipped:0,droppedEvents:0,storagePressure:true,changes:[] as ReturnType<typeof getEvent>[],notifications:[]};
    if((current?.cursor??null)!==input.expectedCursor)throw error("monitor_source_cursor_conflict");
    await db.run("INSERT INTO evidence_cursors(source_key,cursor,batch_digest,updated_at,gap) VALUES(?,?,?,?,'storage_pressure') ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor,batch_digest=excluded.batch_digest,updated_at=excluded.updated_at,gap=excluded.gap",[input.sourceKey,input.nextCursor,digest,input.atMs]);
    await db.run("UPDATE observation_maintenance SET pressure_state='storage_pressure',dropped_events=MIN(9007199254740991,dropped_events+?),rejected_batches=MIN(9007199254740991,rejected_batches+1) WHERE singleton=1",[input.events.length]);
    return {duplicate:false,inserted:0,conflicts:0,retirementSkipped:0,droppedEvents:input.events.length,storagePressure:true,changes:[] as ReturnType<typeof getEvent>[],notifications:[]};
   };
   return mutate(async db=>{const m=await meta(db);if(m.epoch!==input.epoch||m.running!==1)throw error("monitor_epoch_changed");const current=await db.first("SELECT * FROM evidence_cursors WHERE source_key=?",[input.sourceKey]);
    if(current?.cursor===input.nextCursor&&current.batch_digest===digest)return {duplicate:true,inserted:0,conflicts:0,retirementSkipped:0,droppedEvents:0,storagePressure:false,changes:[] as ReturnType<typeof getEvent>[]};
    const estimate=16*1024+safe.reduce((n,value)=>n+Buffer.byteLength(canonicalJson(value))*8+4096,0);
    if(!(await monitorWriteAdmission(db,maxDatabaseBytes,estimate)).accepted)return skipPressure(db);
    await db.run("UPDATE observation_maintenance SET pressure_state='normal' WHERE singleton=1");
    if((current?.cursor??null)!==input.expectedCursor)throw error("monitor_source_cursor_conflict");const previous=await lastSequence(db);let inserted=0,conflicts=0,retirementSkipped=0;
    if(input.gap||safe.length!==input.events.length){
      await event(db,input.epoch,"observation_gap",rootId,null,input.atMs);
      await recordSourceGap(db,{rootId,sourceKey:input.sourceKey,at:input.atMs,reason:input.gap??"unsupported_schema",opened:(id,agent)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,input.atMs,id)});
    }
    for(const item of safe){const value=item as Record<string,unknown>,payload=canonicalJson(value),hash=sha256Text(payload),source=observationId(value.sourceInstanceId)?value.sourceInstanceId:input.sourceKey;
     const ref=observationId(value.eventId)?`${source}:${value.eventId}`:`legacy:${input.sourceKey}:${hash}`,old=await db.first("SELECT digest FROM evidence WHERE ref=?",[ref]);
     const sequenceConflict=Number.isSafeInteger(value.sourceSequence)?await db.first("SELECT ref,digest FROM evidence WHERE source_key=? AND source_seq=?",[source,Number(value.sourceSequence)]):null;
     if(old||sequenceConflict){if((old&&old.digest!==hash)||(sequenceConflict&&sequenceConflict.ref!==ref)){
       conflicts++;await event(db,input.epoch,"source_conflict",rootId,null,input.atMs);
       await db.run("INSERT INTO source_health(source_key,last_sequence,last_event_at,gaps,conflicts) VALUES(?,NULL,?,0,1) ON CONFLICT(source_key) DO UPDATE SET conflicts=source_health.conflicts+1",[source,input.atMs]);
     }continue;}
     const at=typeof value.at==="string"&&Number.isFinite(Date.parse(value.at))?Date.parse(value.at):input.atMs;
     const retired=await db.first("SELECT through_sequence,through_time FROM evidence_retirement WHERE source_key=?",[source]);
     if(retired&&(Number.isSafeInteger(value.sourceSequence)?Number(value.sourceSequence)<=Number(retired.through_sequence):at<=Number(retired.through_time))){retirementSkipped++;continue;}
     const field=(k:string)=>observationId(value[k])?String(value[k]):null;
     await db.run("INSERT INTO evidence(ref,digest,source_key,source_seq,at_ms,agent_id,step_id,host_generation,tray_id,failure_id,decision_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",[ref,hash,source,Number.isSafeInteger(value.sourceSequence)?Number(value.sourceSequence):null,at,field("agentId"),field("stepId"),field("hostGenerationId"),field("trayId"),field("failureId"),field("decisionId"),payload]);inserted++;
     if(Number.isSafeInteger(value.sourceSequence))await recordSourceSequence(db,source,Number(value.sourceSequence),at);
     await indexExecutionOccurrence(db,{rootId,epoch:input.epoch,value,ref,at,
       opened:(id,agent)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,at,id),
       recovered:id=>event(db,input.epoch,"incident_resolved",rootId,null,at,id)});
     await indexProviderRouteCondition(db,{rootId,value,ref,
       opened:(id,agent)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,at,id),
       recovered:id=>event(db,input.epoch,"incident_resolved",rootId,null,at,id)});
     const intake={rootId,value,ref,at,sourceKey:source,opened:(id:string,agent:string|null)=>event(db,input.epoch,"execution_failure_observed",rootId,agent,at,id)};
     await indexHostHealthCondition(db,{...intake,recovered:id=>event(db,input.epoch,"incident_resolved",rootId,null,at,id)});
     await indexNativeIncident(db,intake);
     await indexExecutionProgress(db,intake);
    }
    if(retirementSkipped)await db.run("UPDATE observation_maintenance SET dropped_events=dropped_events+? WHERE singleton=1",[retirementSkipped]);
    await db.run("INSERT INTO evidence_cursors(source_key,cursor,batch_digest,updated_at,gap) VALUES(?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor,batch_digest=excluded.batch_digest,updated_at=excluded.updated_at,gap=excluded.gap",[input.sourceKey,input.nextCursor,digest,input.atMs,retirementSkipped?"retired_source_window":input.gap??null]);
    const changes=(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previous])).map(getEvent);
    if(input.sourceHealth!==undefined){
      const health=projectControlEvent(input.sourceHealth);
      if(!health||health.name!=="observation_source_health"||health.collectorEpoch!==input.epoch||health.sourceKey!==input.sourceKey
        || Date.parse(health.at)!==input.atMs)throw error("monitor_invalid_source_health");
      const incidentIds=[...new Set(changes.filter(change=>["incident_opened","execution_failure_observed"].includes(change.kind)&&change.incidentId).map(change=>change.incidentId!))];
      if(incidentIds.length){
        const payload=canonicalJson(health),hash=sha256Text(payload),ref=`source-health:${hash}`;
        await db.run("INSERT OR IGNORE INTO evidence(ref,digest,source_key,at_ms,payload) VALUES(?,?,?,?,?)",[ref,hash,input.sourceKey,input.atMs,payload]);
        for(const id of incidentIds)await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)",[id,ref]);
      }
    }
    const notifications=await notificationDecisions(db,changes,input.atMs,input.notifications!=="off");return {duplicate:false,inserted,conflicts,retirementSkipped,droppedEvents:0,storagePressure:false,changes:(await db.all("SELECT * FROM events WHERE seq>? ORDER BY seq",[previous])).map(getEvent),notifications};
   }).catch(failure=>{
    // A file-cap rejection rolled back the entire batch. Use the reserved
    // metadata headroom to acknowledge a gap, never spin replaying the batch.
    if(failure instanceof BoxRuntimeError&&failure.message==="monitor_storage_pressure")return mutate(skipPressure,true);
    throw failure;
   });
  },
  async executionEvidence(selector:{agentId:string;stepId:string}){return read(async db=>{
    if(!observationId(selector.agentId)||!observationId(selector.stepId))throw error("monitor_invalid_trace_selector");
    const closure=await collectIncidentEvidence(db,{id:"execution-query"},selector);
    const values:Record<string,unknown>[]=closure.facts.map(f=>f.value),summaryRows=await db.all("SELECT summary_json FROM incidents WHERE rule='execution_failure' AND json_extract(summary_json,'$[0].agentId')=? AND json_extract(summary_json,'$[0].stepId')=? LIMIT 33",[selector.agentId,selector.stepId]);
    let summaryUsed=false;
    if(!values.length)for(const row of summaryRows.slice(0,32)){try{const summary=JSON.parse(String(row.summary_json));if(Array.isArray(summary))for(const event of summary){const safe=projectControlEvent(event);if(safe){values.push(safe);summaryUsed=true;}}}catch{/* malformed summary is not evidence */}}
    return {events:values,source:"monitor_materialized_journal",summaryUsed,truncated:closure.truncated||summaryRows.length>32,retentionFloor:Number((await meta(db)).evidence_floor??0)};
  });},
  async alertTrace(selector:AlertTraceSelector){return read(async db=>{
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
    const retired=await retireObservationDetails(db,now,retentionMs);
    if(!retired.mayExpire)return {removedEvidence:0,remainingEvidence:before,pressure:before>eventTarget,lifetimeEventLimit:null,managementRetained:true,retention:retired};
    // Small incremental batches. Active conditions/management facts are not
    // deleted to meet a count. A target is housekeeping pressure, not admission.
    const expired=await db.all("SELECT id FROM incidents WHERE category='occurrence' AND acknowledged=0 AND id NOT IN(SELECT incident_id FROM management) AND id NOT IN(SELECT parent_id FROM incidents WHERE parent_id IS NOT NULL) AND last_seen<? AND (snooze_until IS NULL OR snooze_until<?) LIMIT 1000",[cutoff,now]);
    for(const row of expired){await db.run("DELETE FROM incident_evidence WHERE incident_id=?",[uuid(row.id)]);await db.run("DELETE FROM incidents WHERE id=?",[uuid(row.id)]);}
    const obsolete=await db.all("SELECT ref,seq,source_key,source_seq,at_ms FROM evidence WHERE (at_ms<? OR ?=1) AND ref NOT IN (SELECT event_ref FROM incident_evidence) AND ref NOT IN (SELECT event_ref FROM snapshot_links) ORDER BY seq LIMIT 1000",[cutoff,before>eventTarget?1:0]);
    for(const row of obsolete){
      await db.run("INSERT INTO evidence_retirement(source_key,through_sequence,through_time) VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence),through_time=MAX(through_time,excluded.through_time)",[String(row.source_key),row.source_seq===null?-1:Number(row.source_seq),Math.min(Number(row.at_ms),now)]);
      await db.run("DELETE FROM evidence WHERE ref=?",[String(row.ref)]);
    }
    const floor=obsolete.at(-1)?.seq;if(floor!==undefined)await db.run("UPDATE meta SET evidence_floor=MAX(evidence_floor,?)",[Number(floor)]);
    const eventFloor=await db.first("SELECT MAX(seq) AS n FROM (SELECT seq FROM events WHERE at_ms<? AND (incident_id IS NULL OR incident_id NOT IN(SELECT id FROM incidents WHERE status='open')) ORDER BY seq LIMIT 1000)",[cutoff]);
    if(eventFloor?.n!==null&&eventFloor?.n!==undefined){await db.run("DELETE FROM events WHERE seq<=? AND at_ms<? AND (incident_id IS NULL OR incident_id NOT IN(SELECT id FROM incidents WHERE status='open'))",[number(eventFloor.n),cutoff]);await db.run("UPDATE meta SET event_floor=MAX(event_floor,?)",[number(eventFloor.n)]);}
    // A short page-reclamation slice, never a full-image rewrite or a GET side effect.
    await db.run("PRAGMA incremental_vacuum(128)");
    const after=number((await db.first("SELECT COUNT(*) AS n FROM evidence"))?.n);return {removedEvidence:before-after,remainingEvidence:after,pressure:after>eventTarget,lifetimeEventLimit:null,managementRetained:true,retention:retired,physical:await sqlitePhysicalUsage(db)};
  },true);},
  async storageHealth(){return read(async db=>{
   const m=await meta(db),info=await stat(file),physical=await sqlitePhysicalUsage(db),auxiliary=await monitorAuxiliaryUsage(file);
   const health=await db.first("SELECT pressure_state,dropped_events,rejected_batches,last_at,last_state FROM observation_maintenance WHERE singleton=1");
   return {engine:"sqlite-disk",schemaVersion:m.version,scope:"monitor_database_only",installationBudgetEnforced:false,
    fileBytes:info.size,allocatedFilesystemBytes:info.blocks*512,physical,auxiliary,totalObservedBytes:info.size+auxiliary.bytes,
    growthGuard:{maxDatabaseBytes,source:"runtime_default_or_explicit_store_policy",existingOversize:info.size>maxDatabaseBytes},
    health,lifetimeEventLimit:null,sources:await db.all("SELECT * FROM source_health ORDER BY source_key LIMIT 200")};
  });},
 };
 return api;
}
export type MonitorStore=ReturnType<typeof openMonitorStore>;

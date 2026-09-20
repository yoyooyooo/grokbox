import {randomUUID} from "node:crypto";
import {canonicalJson,sha256Text} from "@grokbox/runtime-kernel/hash";
import {projectHostHealth,hostHealthConditions,projectHostRuntimeEvidence,hostRuntimeCondition,projectHostWitnessEvidence,hostWitnessCondition,hostWitnessDetectorCondition} from "@grokbox/runtime-kernel/host-health";
import type {MonitorSqlite} from "./monitor-sqlite.node.ts";
/** Runs inside the ORIGINAL evidence/incident/outbox transaction. There is no
 * second collector, incident database, native operation or notification writer. */
export async function indexHostHealthCondition(db:MonitorSqlite,input:{rootId:string;value:unknown;ref:string;at:number;
  opened:(id:string,agent:null)=>Promise<void>;recovered:(id:string)=>Promise<void>}){
  const disk=projectHostHealth(input.value), runtime=projectHostRuntimeEvidence(input.value), witness=projectHostWitnessEvidence(input.value), v=disk??runtime??witness;if(!v)return;
  const before=await db.first("SELECT source_seq FROM evidence WHERE source_key=? AND ref<>? AND json_extract(payload,'$.name')=? ORDER BY source_seq DESC LIMIT 1",[v.sourceInstanceId,input.ref,v.name]);
  // Old A arriving after B cannot repair B, even after A->B->A bytes repeat.
  if(before&&Number(before.source_seq)>=v.sourceSequence)return;
  const compileReceipt = runtime?.observation.receipt ?? witness?.observation.snapshot?.compilation;
  if(compileReceipt){
    // Re-reading a restored marker is a new observation, not a new compile.
    // Preserve the immutable attempt time so an older positive/negative marker
    // cannot undo a later attempt merely by gaining a higher observation seq.
    const newest=await db.first("SELECT json_extract(payload,'$.observation.receipt.at') AS attempted_at, json_extract(payload,'$.observation.receipt.observationId') AS attempt FROM evidence WHERE source_key=? AND ref<>? AND json_extract(payload,'$.name')='host_runtime_health' AND json_extract(payload,'$.observation.receipt.at') IS NOT NULL ORDER BY attempted_at DESC LIMIT 1",[v.sourceInstanceId,input.ref]);
    const r=compileReceipt;
    if(newest&&(String(newest.attempted_at)>r.at||String(newest.attempted_at)===r.at&&newest.attempt!==r.observationId))return;
  }
  if (witness?.observation.snapshot) {
    const s = witness.observation.snapshot;
    const latest = await db.first("SELECT MAX(json_extract(payload,'$.observation.snapshot.sequence')) AS sequence FROM evidence WHERE source_key=? AND ref<>? AND json_extract(payload,'$.name')='host_capability_health' AND json_extract(payload,'$.observation.snapshot.compilation.observationId')=?", [v.sourceInstanceId,input.ref,s.compilation.observationId]);
    if (latest?.sequence != null && Number(latest.sequence) >= s.sequence) return;
  }
  const conditions=disk?hostHealthConditions(disk):witness?[{cause:"attachment",result:hostWitnessCondition(witness)},{cause:"witness-reader",result:hostWitnessDetectorCondition(witness)}]:[{cause:"compilation",result:hostRuntimeCondition(runtime!)}];
  for(const condition of conditions){
    const key=sha256Text(canonicalJson(["host-health",v.installationId,disk?.contractRevision??"host-runtime-v1",condition.cause]));
    const row=await db.first("SELECT id,last_seen FROM incidents WHERE scope=? AND rule='host_patch_health' AND occurrence_key=? AND status='open'",[input.rootId,key]);
    if(condition.result==="failed"){
      let id=row?String(row.id):randomUUID();
      if(!row){await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,NULL,'host_patch_health','open',?,?,1,?,'condition',?)",
        [id,input.rootId,runtime?.observation.receipt?Date.parse(runtime.observation.receipt.at):input.at,input.at,key,canonicalJson([v])]);await input.opened(id,null);}
      else await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?),summary_json=? WHERE id=?",[input.at,canonicalJson([v]),id]);
      await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)",[id,input.ref]);
    }else if(condition.result==="passed"&&row){
      await db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=MAX(last_seen,?),revision=revision+1 WHERE id=?",[input.at,input.at,String(row.id)]);
      await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)",[String(row.id),input.ref]);await input.recovered(String(row.id));
    }
    // Unsupported analysis, missing profile and withdrawn intent are not repair.
  }
}

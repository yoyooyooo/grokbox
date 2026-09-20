import {randomUUID} from "node:crypto";
import {canonicalJson,sha256Text} from "@grokbox/runtime-kernel/hash";
import {projectHostHealth,hostHealthConditions} from "@grokbox/runtime-kernel/host-health";
import type {MonitorSqlite} from "./monitor-sqlite.node.ts";
/** Runs inside the ORIGINAL evidence/incident/outbox transaction. There is no
 * second collector, incident database, native operation or notification writer. */
export async function indexHostHealthCondition(db:MonitorSqlite,input:{rootId:string;value:unknown;ref:string;at:number;
  opened:(id:string,agent:null)=>Promise<void>;recovered:(id:string)=>Promise<void>}){
  const v=projectHostHealth(input.value);if(!v)return;
  const before=await db.first("SELECT source_seq FROM evidence WHERE source_key=? AND ref<>? AND json_extract(payload,'$.name')='host_patch_health' ORDER BY source_seq DESC LIMIT 1",[v.sourceInstanceId,input.ref]);
  // Old A arriving after B cannot repair B, even after A->B->A bytes repeat.
  if(before&&Number(before.source_seq)>=v.sourceSequence)return;
  for(const condition of hostHealthConditions(v)){
    const key=sha256Text(canonicalJson(["host-health",v.installationId,v.contractRevision,condition.cause]));
    const row=await db.first("SELECT id,last_seen FROM incidents WHERE scope=? AND rule='host_patch_health' AND occurrence_key=? AND status='open'",[input.rootId,key]);
    if(condition.result==="failed"){
      let id=row?String(row.id):randomUUID();
      if(!row){await db.run("INSERT INTO incidents(id,scope,agent_id,rule,status,first_seen,last_seen,revision,occurrence_key,category,summary_json) VALUES(?,?,NULL,'host_patch_health','open',?,?,1,?,'condition',?)",
        [id,input.rootId,input.at,input.at,key,canonicalJson([v])]);await input.opened(id,null);}
      else await db.run("UPDATE incidents SET last_seen=MAX(last_seen,?),summary_json=? WHERE id=?",[input.at,canonicalJson([v]),id]);
      await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)",[id,input.ref]);
    }else if(condition.result==="passed"&&row){
      await db.run("UPDATE incidents SET status='resolved',resolved_at=?,last_seen=MAX(last_seen,?),revision=revision+1 WHERE id=?",[input.at,input.at,String(row.id)]);
      await db.run("INSERT OR IGNORE INTO incident_evidence(incident_id,event_ref) VALUES(?,?)",[String(row.id),input.ref]);await input.recovered(String(row.id));
    }
    // Unsupported analysis, missing profile and withdrawn intent are not repair.
  }
}

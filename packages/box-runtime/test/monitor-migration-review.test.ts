import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import initialize from "sql.js/dist/sql-asm.js";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";

const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",SCOPE="b".repeat(64);
async function legacy() {
  const root=await mkdtemp(join(tmpdir(),"monitor-retired-contract-")),directory=join(root,"observability"),file=join(directory,"observations.sqlite");
  await mkdir(directory,{mode:0o700});
  const SQL=await initialize(),db=new SQL.Database(),databaseId=randomUUID(),epoch=randomUUID(),incident=randomUUID(),request=randomUUID();
  db.run(`PRAGMA user_version=1;
    CREATE TABLE meta(singleton INTEGER PRIMARY KEY,version INTEGER,database_id TEXT,root_id TEXT,epoch TEXT,running INTEGER,current_scope TEXT,gateway_epoch TEXT,heartbeat INTEGER,last_number INTEGER,last_sample_id TEXT,last_digest TEXT);
    CREATE TABLE watched(agent_id TEXT PRIMARY KEY);
    CREATE TABLE observations(scope TEXT,agent_id TEXT,state TEXT,server_id TEXT,server_harness TEXT,local_harness TEXT,last_attempt INTEGER,last_success INTEGER,latest_success INTEGER,PRIMARY KEY(scope,agent_id));
    CREATE TABLE incidents(id TEXT PRIMARY KEY,scope TEXT,agent_id TEXT,rule TEXT,status TEXT,first_seen INTEGER,last_seen INTEGER,resolved_at INTEGER,revision INTEGER,acknowledged INTEGER,snooze_until INTEGER);
    CREATE UNIQUE INDEX one_open_incident ON incidents(scope,COALESCE(agent_id,''),rule) WHERE status='open';
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,epoch TEXT,kind TEXT,scope TEXT,agent_id TEXT,incident_id TEXT,at_ms INTEGER,before_harness TEXT,after_harness TEXT,interval_start INTEGER);
    CREATE TABLE management(request_id TEXT PRIMARY KEY,fingerprint TEXT,incident_id TEXT,revision INTEGER,action TEXT);
  `);
  db.run("INSERT INTO meta VALUES(1,1,?,?,?,0,?,NULL,1000,0,NULL,NULL)",[databaseId,sha256Text(canonicalJson(["grokbox-observability-v1",resolve(root)])),epoch,SCOPE]);
  db.run("INSERT INTO watched VALUES(?)",[AGENT]);
  db.run("INSERT INTO incidents VALUES(?,?,?,'ownership_conflict','open',1000,1001,NULL,2,1,9000000)",[incident,SCOPE,AGENT]);
  const fingerprint=sha256Text(canonicalJson([incident,1,"ack",null]));
  db.run("INSERT INTO management VALUES(?,?,?,2,'ack')",[request,fingerprint,incident]);
  await writeFile(file,db.export(),{mode:0o600});db.close();
  return {root,directory,file,databaseId,incident,request,close:()=>rm(root,{recursive:true,force:true})};
}

test("actual v1 layout is retained but neither queries nor initialization can make it current",async()=>{
  const f=await legacy();try{
    const store=openMonitorStore(f.root),before=await readFile(f.file),names=await readdir(f.directory);
    await expect(store.snapshot()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    await expect(store.incidents()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    await expect(store.begin(randomUUID(),2000,[AGENT])).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    await expect(store.initialize()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    expect(await readFile(f.file)).toEqual(before);expect(await readdir(f.directory)).toEqual(names);
  }finally{await f.close();}
});

test("a former management receipt cannot trigger an upgrade or a new acknowledgement",async()=>{
  const f=await legacy();let publications=0;try{
    const store=openMonitorStore(f.root,{beforePublish(){publications++;},afterRename(){publications++;}}),before=await readFile(f.file);
    await expect(store.manage({requestId:f.request,incidentId:f.incident,expectedRevision:1,action:"ack",nowMs:2001})).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    await expect(store.initialize()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    expect(publications).toBe(0);expect(await readFile(f.file)).toEqual(before);
    const db=await openMonitorSqlite(f.file,"read");
    try{expect(await db.first("SELECT revision,acknowledged,snooze_until FROM incidents")).toEqual({revision:2,acknowledged:1,snooze_until:9000000});}
    finally{await db.close();}
  }finally{await f.close();}
});

for(const name of ["writer.lock","collector.lock"])test(`retired ${name} is never parsed, stolen or removed to upgrade a database`,async()=>{
  const f=await legacy();try{
    const path=join(f.directory,name),bytes="2147483647\n";
    await writeFile(path,bytes,{mode:0o600});const before=await readFile(f.file),names=(await readdir(f.directory)).sort();
    await expect(openMonitorStore(f.root).initialize()).rejects.toThrow("monitor_store_schema_or_root_mismatch");
    expect(await readFile(f.file)).toEqual(before);expect(await readFile(path,"utf8")).toBe(bytes);
    expect((await readdir(f.directory)).sort()).toEqual(names);
  }finally{await f.close();}
});

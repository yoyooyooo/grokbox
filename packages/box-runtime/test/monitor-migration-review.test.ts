import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import initialize from "sql.js/dist/sql-asm.js";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";

const AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",SCOPE="b".repeat(64);
async function legacy() {
  const root=await mkdtemp(join(tmpdir(),"monitor-migrate-review-")),directory=join(root,"observability"),file=join(directory,"observations.sqlite");
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

test("v1 migration is explicit and retains incident acknowledgement and management idempotency",async()=>{
  const f=await legacy();try{
    const store=openMonitorStore(f.root),before=await readFile(f.file);
    expect((await store.snapshot()).storage.migrationRequired).toBe(true);
    expect(await readFile(f.file)).toEqual(before);
    await expect(store.begin(randomUUID(),2000,[AGENT])).rejects.toThrow("monitor_migration_required");
    const receipt=await store.initialize();expect(receipt).toMatchObject({migrated:true,created:false,databaseId:f.databaseId});
    expect((await store.incidents())[0]).toMatchObject({id:f.incident,acknowledged:true,revision:2,snoozeUntilMs:9000000});
    expect(await store.manage({requestId:f.request,incidentId:f.incident,expectedRevision:1,action:"ack",nowMs:2001})).toMatchObject({duplicate:true,appliedRevision:2});
    const backups=(await readdir(f.directory)).filter(name=>name.startsWith("observations-v1-"));expect(backups).toHaveLength(1);
    expect(await readFile(join(f.directory,backups[0]))).toEqual(before);
  }finally{await f.close();}
});

test("rollback during legacy schema migration preserves the old database for a later confirmed retry",async()=>{
  const f=await legacy();let refuse=true;try{
    const store=openMonitorStore(f.root,{beforePublish(){if(refuse)throw Error("injected migration failure");}}),before=await readFile(f.file);
    await expect(store.initialize()).rejects.toThrow();expect(await readFile(f.file)).toEqual(before);
    expect((await store.snapshot()).storage.migrationRequired).toBe(true);
    refuse=false;expect((await store.initialize()).migrated).toBe(true);
  }finally{await f.close();}
});

test("committed migration with lost acknowledgement reports unknown instead of claiming nothing changed",async()=>{
  const f=await legacy();try{
    const store=openMonitorStore(f.root,{afterRename(){throw Error("lost migration receipt");}});
    await expect(store.initialize()).rejects.toThrow("monitor_commit_unknown");
    expect((await openMonitorStore(f.root).snapshot()).storage.migrationRequired).toBe(false);
  }finally{await f.close();}
});

test("a legacy collector marker prevents migration and is never removed on a guessed timeout",async()=>{
  const f=await legacy();try{
    await writeFile(join(f.directory,"collector.lock"),"synthetic-old-owner\n",{mode:0o600});const before=await readFile(f.file);
    await expect(openMonitorStore(f.root).initialize()).rejects.toThrow("monitor_legacy_collector_requires_stop");
    expect(await readFile(f.file)).toEqual(before);expect(await readFile(join(f.directory,"collector.lock"),"utf8")).toBe("synthetic-old-owner\n");
  }finally{await f.close();}
});

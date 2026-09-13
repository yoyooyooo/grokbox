import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMonitorSample, MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = 1789200000000;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sample(at: number, serverHarness: "box"|"temporal" = "box", localHarness: "box"|"temporal" = "box", scopeId = "a".repeat(64)) {
  return makeMonitorSample({ sampleId: randomUUID(), agentIds: [ID], startedAtMs: at, completedAtMs: at+1,
    response: { snapshot: ownedOwnershipSnapshot([ID],{nowMs:at,scopeId,serverHarness,localHarness}), gateway:{pid:42,startedAt:100} } });
}
async function fixture(beforePublish?: () => void) {
  const root = await mkdtemp(join(tmpdir(),"gbox-monitor-")), store = openMonitorStore(root,{beforePublish}), epoch = randomUUID();
  await store.initialize(); await store.begin(epoch,BASE,[ID]);
  return {root,store,epoch,close:()=>rm(root,{recursive:true,force:true})};
}

test("real SQLite image, bounded pure reads and explicit initialization", async () => {
  const root = await mkdtemp(join(tmpdir(),"gbox-monitor-read-"));
  const store = openMonitorStore(root);
  try {
    await expect(store.snapshot()).rejects.toThrow("monitor_not_initialized");
    expect(existsSync(join(root,"observability"))).toBe(false);
    expect((await store.initialize()).created).toBe(true);
    const before = await readFile(store.path), info = await stat(store.path);
    expect(before.subarray(0,16).toString()).toBe("SQLite format 3\u0000");
    expect(info.mode & 0o777).toBe(0o600);
    expect((await store.initialize()).created).toBe(false);
    await store.snapshot(); await store.events(); await store.incidents();
    expect(hash(await readFile(store.path))).toBe(hash(before));
    expect((await stat(store.path)).mtimeMs).toBe(info.mtimeMs);
    expect(existsSync(join(root,"models.json"))).toBe(false);
    expect(existsSync(join(root,"state/desired.json"))).toBe(false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("baseline conflict opens once, ack is durable and duplicate intentions do not repair it", async () => {
  const f = await fixture();
  try {
    const s = sample(BASE+10,"temporal");
    await f.store.record(f.epoch,1,s);
    expect((await f.store.record(f.epoch,1,s)).duplicate).toBe(true);
    await f.store.record(f.epoch,2,sample(BASE+20,"temporal"));
    let incidents = await f.store.incidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({rule:"ownership_conflict",status:"open",revision:1,acknowledged:false});
    const request={requestId:randomUUID(),incidentId:incidents[0]!.id,expectedRevision:1,action:"ack" as const,nowMs:BASE+21};
    const ack=await f.store.manage(request);
    expect(ack).toMatchObject({appliedRevision:2,duplicate:false,repaired:false});
    const cold = openMonitorStore(f.root);
    expect(await cold.manage(request)).toMatchObject({appliedRevision:2,duplicate:true});
    expect((await cold.incidents())[0]).toMatchObject({status:"open",acknowledged:true});
    await expect(cold.manage({...request,requestId:randomUUID()})).rejects.toThrow("monitor_revision_conflict");
    await expect(cold.manage({...request,action:"snooze",untilMs:BASE+1000})).rejects.toThrow("monitor_request_conflict");
    await f.store.record(f.epoch,3,sample(BASE+30));
    incidents=await cold.incidents();
    expect(incidents.find(i=>i.rule==="ownership_conflict")).toMatchObject({status:"resolved",acknowledged:true});
    await expect(cold.manage({...request,requestId:randomUUID(),expectedRevision:3})).rejects.toThrow("monitor_incident_resolved");
    await f.store.record(f.epoch,4,sample(BASE+40,"temporal"));
    const reopened=(await cold.incidents()).filter(i=>i.rule==="ownership_conflict" && i.status==="open");
    expect(reopened).toHaveLength(1); expect(reopened[0]!.id).not.toBe(request.incidentId);
    expect(reopened[0]!.acknowledged).toBe(false);
  } finally { await f.close(); }
});

test("read failure retains last known ownership and never resolves a live conflict", async () => {
  const f=await fixture();
  try {
    await f.store.record(f.epoch,1,sample(BASE+10,"temporal"));
    const unavailable=makeMonitorSample({sampleId:randomUUID(),agentIds:[ID],startedAtMs:BASE+20,completedAtMs:BASE+21});
    await f.store.record(f.epoch,2,unavailable);
    const status=await f.store.snapshot(BASE+22);
    expect(status).toMatchObject({admissionAuthority:false,productionAccepted:false});
    expect(status.agents[0]).toMatchObject({lastKnown:{state:"conflict",serverHarness:"temporal"},lastSuccessMs:BASE+10,freshness:"unavailable"});
    const incidents=await f.store.incidents();
    expect(incidents.filter(i=>i.status==="open").map(i=>i.rule).sort()).toEqual(["observation_unavailable","ownership_conflict"]);
    expect((await f.store.events()).entries.some(e=>e.kind==="ownership_changed")).toBe(false);
  } finally { await f.close(); }
});

test("observed changes have an interval, scoped account changes do not forge a migration", async () => {
  const f=await fixture();
  try {
    await f.store.record(f.epoch,1,sample(BASE+10));
    await f.store.record(f.epoch,2,sample(BASE+20,"temporal","temporal"));
    const changes=(await f.store.events()).entries.filter(e=>e.kind==="ownership_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({previousHarness:"box",currentHarness:"temporal",observationIntervalStartMs:BASE+10,observedAtMs:BASE+21});
    await f.store.record(f.epoch,3,sample(BASE+30,"box","box","b".repeat(64)));
    expect((await f.store.events()).entries.filter(e=>e.kind==="ownership_changed")).toHaveLength(1);
    expect((await f.store.snapshot(BASE+32)).scopeId).toBe("b".repeat(64));
    expect((await f.store.events()).entries.some(e=>e.kind==="scope_changed")).toBe(true);
  } finally { await f.close(); }
});

test("epoch restart invalidates cursor and late callback; no restored observation is automatically fresh", async () => {
  const f=await fixture();
  try {
    await f.store.record(f.epoch,1,sample(BASE+10));
    const cursor=(await f.store.snapshot(BASE+12)).cursor;
    const next=randomUUID();
    await f.store.begin(next,BASE+20,[ID,OTHER]);
    await expect(f.store.events(cursor)).rejects.toThrow("monitor_cursor_invalid");
    await expect(f.store.record(f.epoch,2,sample(BASE+25))).rejects.toThrow("monitor_epoch_changed");
    const snapshot=await f.store.snapshot(BASE+22);
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.agents.every(a=>a.freshness==="unavailable")).toBe(true);
    expect(snapshot.agents.find(a=>a.agentId===OTHER)?.lastKnown).toBeNull();
    expect((await f.store.events()).entries.some(e=>e.kind==="observation_gap")).toBe(true);
  } finally { await f.close(); }
});

test("SQLite commit failure publishes nothing and retains the previous complete image", async () => {
  let fail=false;
  const f=await fixture(()=>{if(fail)throw new Error("owned_disk_failure_secret");});
  try {
    await f.store.record(f.epoch,1,sample(BASE+10));
    const before=hash(await readFile(f.store.path)); fail=true;
    await expect(f.store.record(f.epoch,2,sample(BASE+20,"temporal"))).rejects.toThrow("monitor_commit_failed");
    expect(hash(await readFile(f.store.path))).toBe(before);
    expect((await f.store.incidents()).length).toBe(0);
    fail=false;
    await f.store.record(f.epoch,2,sample(BASE+20,"temporal"));
    expect((await f.store.incidents()).some(i=>i.rule==="ownership_conflict")).toBe(true);
  } finally { await f.close(); }
});

test("held writer lock refuses rather than stomping the current database", async () => {
  const f=await fixture();
  try {
    const before=hash(await readFile(f.store.path));
    await writeFile(join(f.root,"observability/writer.lock"),"owned-test-lock",{flag:"wx"});
    await expect(f.store.record(f.epoch,1,sample(BASE+10))).rejects.toThrow("monitor_writer_busy");
    expect(hash(await readFile(f.store.path))).toBe(before);
    expect((await f.store.snapshot()).agents[0]!.lastKnown).toBeNull();
  } finally { await f.close(); }
});

for (const bad of ["corrupt","symlink"] as const) {
  test(`existing ${bad} DB is never silently recreated by init or GET`,async()=>{
    const f=await fixture();
    try {
      await rm(f.store.path);
      const poison=Buffer.from("SECRET_SENTINEL_NOT_DATABASE");
      if(bad==="corrupt")await writeFile(f.store.path,poison,{mode:0o600});
      else {await writeFile(join(f.root,"target"),poison,{mode:0o600});await symlink(join(f.root,"target"),f.store.path);}
      await expect(f.store.initialize()).rejects.toThrow();
      await expect(f.store.snapshot()).rejects.toThrow();
      expect(await readFile(f.store.path)).toEqual(poison);
    }finally{await f.close();}
  });
}

test("retained observations become stale and snooze expires independently of active state",async()=>{
  const f=await fixture();
  try{
    await f.store.record(f.epoch,1,sample(BASE+10,"temporal"));
    const incident=(await f.store.incidents())[0]!;
    await f.store.manage({requestId:randomUUID(),incidentId:incident.id,expectedRevision:1,action:"snooze",nowMs:BASE+11,untilMs:BASE+111});
    expect((await f.store.incidents())[0]).toMatchObject({status:"open",acknowledged:false,snoozeUntilMs:BASE+111});
    expect((await f.store.snapshot(BASE+MONITOR_POLICY.staleAfterMs+20)).agents[0]!.freshness).toBe("stale");
    await expect(f.store.events(`${(await f.store.snapshot()).databaseId}:${f.epoch}:999999`)).rejects.toThrow("monitor_cursor_invalid");
  }finally{await f.close();}
});

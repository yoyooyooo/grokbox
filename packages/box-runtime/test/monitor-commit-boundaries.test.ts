import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMonitorSample } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",BASE=1789200000000;
function sample(at:number,completion:number,serverHarness:"box"|"temporal"="box") {
  return makeMonitorSample({sampleId:randomUUID(),agentIds:[ID],startedAtMs:at,completedAtMs:completion,
    response:{snapshot:ownedOwnershipSnapshot([ID],{nowMs:at,serverHarness}),gateway:{pid:42,startedAt:100}}});
}

test("the last successful evidence time is query observation, not a slower response arrival",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gbox-monitor-time-")),db=openMonitorStore(root),epoch=randomUUID();
  try {
    await db.initialize();await db.begin(epoch,BASE,[ID]);
    await db.record(epoch,1,sample(BASE+10,BASE+9000));
    expect((await db.snapshot(BASE+9001)).agents[0]!.lastSuccessMs).toBe(BASE+10);
    const changed=await db.record(epoch,2,sample(BASE+10000,BASE+11000,"temporal"));
    expect(changed.events.find(e=>e.kind==="ownership_changed")).toMatchObject({observationIntervalStartMs:BASE+10,observedAtMs:BASE+11000});
    expect((await db.snapshot(BASE+11001)).lastObservedGatewayEpoch).toBe("42:100");
    const stale=sample(BASE+9999,BASE+11002,"box");
    await expect(db.record(epoch,3,stale)).rejects.toThrow("monitor_stale_sample");
    expect((await db.snapshot(BASE+11003)).agents[0]!.lastKnown?.serverHarness).toBe("temporal");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("uncertain directory sync retains the committed operation identity without doubling management effects",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gbox-monitor-unknown-"));let fail=false;
  const db=openMonitorStore(root,{afterRename:()=>{if(fail)throw new Error("owned_directory_sync_failure");}}),epoch=randomUUID();
  try {
    await db.initialize();await db.begin(epoch,BASE,[ID]);await db.record(epoch,1,sample(BASE+10,BASE+11,"temporal"));
    const incident=(await db.incidents())[0]!;
    const request={requestId:randomUUID(),incidentId:incident.id,expectedRevision:1,action:"ack" as const,nowMs:BASE+12};
    fail=true;
    await expect(db.manage(request)).rejects.toThrow("monitor_commit_unknown");
    fail=false;
    const cold=openMonitorStore(root);
    expect(await cold.manage(request)).toMatchObject({duplicate:true,appliedRevision:2,repaired:false});
    expect((await cold.incidents())[0]).toMatchObject({status:"open",acknowledged:true,revision:2});
    expect((await cold.events()).entries.filter(e=>e.kind==="incident_ack")).toHaveLength(1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("event and incident pagination is bounded and never silently truncates the traversal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gbox-monitor-pages-")),db=openMonitorStore(root),epoch=randomUUID();
  try {
    await db.initialize();await db.begin(epoch,BASE,[ID]);
    await db.record(epoch,1,sample(BASE+10,BASE+11));
    await db.record(epoch,2,sample(BASE+20,BASE+21,"temporal"));
    const before=await readFile(db.path);
    const page1=await db.incidentPage(undefined,1);expect(page1.hasMore).toBe(true);expect(page1.incidents).toHaveLength(1);
    const page2=await db.incidentPage(page1.cursor!,1);expect(page2.hasMore).toBe(false);expect(page2.incidents).toHaveLength(1);
    expect(page1.incidents[0]!.id).not.toBe(page2.incidents[0]!.id);
    const all=await db.events();let cursor:string|undefined,hasMore=true;const ids:string[]=[];
    while(hasMore){const page=await db.events(cursor,1);ids.push(...page.entries.map(e=>e.eventId));cursor=page.cursor;hasMore=page.hasMore;}
    expect(ids).toEqual(all.entries.map(e=>e.eventId));expect(new Set(ids).size).toBe(ids.length);
    expect(await readFile(db.path)).toEqual(before);
    await db.finish(epoch,BASE+29);
    await db.begin(randomUUID(),BASE+30,[ID]);
    await expect(db.incidentPage(page1.cursor!)).rejects.toThrow("monitor_cursor_invalid");
  } finally {await rm(root,{recursive:true,force:true});}
});

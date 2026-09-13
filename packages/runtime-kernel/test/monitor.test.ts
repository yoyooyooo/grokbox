import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeMonitorSample, monitorDelay, monitorFreshness, monitorTargets, MONITOR_POLICY } from "../src/monitor.ts";

const ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",at=1789200000000;
function input(){return {sampleId:randomUUID(),agentIds:[ID],startedAtMs:at,completedAtMs:at+100,
  response:{gateway:{pid:42,startedAt:100},snapshot:{schemaVersion:3,source:"Host.official-client/ListGrokBotAgents",state:"observed",
    observedAt:new Date(at).toISOString(),completedAt:new Date(at+100).toISOString(),serverObservedAt:new Date(at).toISOString(),
    scope:{id:"a".repeat(64),stable:true},localMigrationWindow:{before:{kind:"inactive"},after:{kind:"inactive"}},
    localExecution:{before:{allowed:true,bound:true},after:{allowed:true,bound:true}},agents:[{
      agentId:ID,serverEvidence:"found",server:{agentId:ID,serverId:"42",harness:"box",secret:"PRIVATE_SENTINEL"},
      local:{before:{serverId:"42",harness:"box"},after:{serverId:"42",harness:"box"},stable:true},
    }],secret:"PRIVATE_SENTINEL"}}};}

test("sample projects only stable scoped finite ownership and does not expose raw native payload",()=>{
  const result=makeMonitorSample(input());
  expect(result.failure).toBeNull();expect(result.agents[0]).toMatchObject({state:"confirmed_box",serverHarness:"box"});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});
for(const bad of ["scope","old-bridge","old-time","future-time","gateway"] as const){
  test(`monitor does not install ${bad} observations`,()=>{
    const i=input();
    if(bad==="scope")i.response.snapshot.scope.stable=false;
    if(bad==="old-bridge")i.response.snapshot.schemaVersion=1;
    if(bad==="old-time")i.response.snapshot.serverObservedAt=new Date(at-MONITOR_POLICY.readTimeoutMs-1).toISOString();
    if(bad==="future-time")i.response.snapshot.serverObservedAt=new Date(at+101).toISOString();
    if(bad==="gateway")i.response.gateway.pid=0;
    expect(makeMonitorSample(i).failure).not.toBeNull();
  });
}
test("missing rows are unconfirmed, never a fabricated ownership deletion",()=>{
  const i=input();i.response.snapshot.agents=[];
  const result=makeMonitorSample(i);
  expect(result.agents[0]).toMatchObject({state:"unconfirmed",serverHarness:null});
});
test("target capacity, monotone bounded backoff and freshness are independent of admission",()=>{
  expect(monitorTargets([ID,ID])).toEqual([ID]);
  expect(()=>monitorTargets([])).toThrow();expect(()=>monitorTargets(["PRIVATE_SENTINEL"])).toThrow();
  expect(monitorDelay(30000,0,0)).toBe(30000);expect(monitorDelay(30000,1,0)).toBe(60000);
  expect(monitorDelay(30000,100,1)).toBe(300000);expect(()=>monitorDelay(100,0,0)).toThrow();
  expect(monitorFreshness(at,at+90001,true)).toBe("stale");
  expect(monitorFreshness(at,at+1,false)).toBe("unavailable");
  expect(monitorFreshness(at,at+1,true)).toBe("fresh");
});

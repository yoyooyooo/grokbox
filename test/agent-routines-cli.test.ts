import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { captureCli } from "./helpers.ts";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { LocalDaemonClient } from "../packages/cli/src/daemon/client.ts";
import { boundedGatewayBody } from "../packages/cli/src/gateway-automation.ts";
import { setupFixture, SETUP_BOT, SETUP_OWNER } from "../apps/web/test/setup-fixture.ts";

// Normal source/packed CLI journeys, CAS, independent readback and native
// failure recovery now execute through the actual management entry point in
// notification-setup.test.ts. This file guards the retired routes and transport.
const retired=[
  ...["list","show","enable","disable","delete","apply","outcome","reconcile"].map(action=>["agents","routines",action,SETUP_BOT]),
  ...["list","show","blueprint","verify","bind"].map(action=>["ops","targets",action,"default"]),
];
test("retired native Routine and target commands refuse locally instead of forwarding to another writer",async()=>{
  const f=await setupFixture("https://retired-routines.example.test");
  try{
    const before=f.calls.length;
    for(const args of retired){
      const result=await captureCli(args,{configDir:f.root,boxRuntimeRoot:f.root,env:{},discoveryPath:f.discoveryPath});
      expect(result.code).not.toBe(0);expect(result.stdout).toBe("");
    }
    expect(f.calls.length).toBe(before);
    const entry=ensurePackedCli();
    for(const args of [retired[0]!,retired[5]!,retired.at(-1)!]){
      const child=spawn("node",[entry,...args],{cwd:f.root,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_SETUP_CREDENTIAL:SETUP_OWNER}});
      let out="",err="";child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);
      const timer=setTimeout(()=>child.kill("SIGKILL"),10000),[code,signal]=await once(child,"close");clearTimeout(timer);
      expect(signal).toBeNull();expect(code).not.toBe(0);expect(out).toBe("");expect(err).not.toContain(SETUP_OWNER);
    }
    expect(f.calls.length).toBe(before);
  }finally{await f.close();}
},15000);

test("legacy daemon has no Routine read/write/provision RPC or stale collector capability",async()=>{
  const f=await setupFixture("https://retired-routine-rpc.example.test");let daemon:Awaited<ReturnType<typeof startDaemonHost>>|undefined;
  try{
    const socket=join(f.root,"legacy.sock"),deps={...createProductionDeps(),configDir:f.root,boxRuntimeRoot:f.root,env:{},discoveryPath:f.discoveryPath,daemonSocket:socket,agentDataRoot:join(f.root,"absent-native-state"),transport:"local" as const};
    daemon=await startDaemonHost(deps,socket);const client=new LocalDaemonClient(socket,2000),handshake=await client.handshake();
    for(const name of ["grok.routines.read","grok.routines.write","grok.routines.provision","grok.monitor.service"])expect(handshake.capabilities).not.toContain(name);
    await expect(client.call("agentRoutines" as never,{command:{action:"delete",agentId:SETUP_BOT,routineId:"one",confirmed:true,expectedRevision:"a".repeat(64)}})).rejects.toBeDefined();
    await expect(client.call("routineProvision" as never,{command:{action:"outcome",agentId:SETUP_BOT,operationId:"one"}})).rejects.toBeDefined();
    expect(f.calls.filter(c=>c.method.includes("Automation"))).toHaveLength(0);
  }finally{await daemon?.close();await f.close();}
});

test("stream body is bounded before JSON parsing, including missing length and invalid UTF-8",async()=>{
  let cancelled=0,sent=0;const body=new ReadableStream<Uint8Array>({pull(c){sent++;c.enqueue(new Uint8Array(2048));},cancel(){cancelled++;}});
  await expect(boundedGatewayBody(new Response(body),4096)).rejects.toBeDefined();expect(cancelled).toBe(1);expect(sent).toBeLessThanOrEqual(5);
  await expect(boundedGatewayBody(new Response(new Uint8Array([0xff])),32)).rejects.toBeDefined();
  await expect(boundedGatewayBody(new Response("small",{headers:{"content-length":"5000000"}}),32)).rejects.toBeDefined();
});

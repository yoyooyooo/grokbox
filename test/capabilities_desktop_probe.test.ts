import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { captureCli, parseJson } from "./helpers.ts";
for(const transport of ["local","auto","daemon","gateway"] as const)test(`retired ${transport} Profile no longer probes or promises desktop authority`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-capability-"));let calls=0;
  try{await writeProfileFile(root,"selected",{version:1,transport,...(transport==="daemon"?{server_url:"https://daemon.example.test",daemon_token_ref:"env:SYNTHETIC_TOKEN"}:{})});
    const result=await captureCli(["profile","capabilities","selected","--json"],{configDir:root,env:{},fetch:Object.assign(async()=>{calls++;throw Error("no_desktop_probe");},{preconnect:()=>undefined}),skillsDir:join(import.meta.dir,"../skills")});
    expect(result.code,result.stderr).toBe(0);const data=(parseJson(result.stdout) as {data:{capabilities:Record<string,unknown>}}).data;
    expect(data.capabilities).not.toHaveProperty("host.desktop.read");expect(data.capabilities).not.toHaveProperty("host.desktop.reap");expect(calls).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});

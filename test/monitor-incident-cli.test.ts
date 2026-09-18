import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../packages/box-runtime/src/internal/io/monitor-store.node.ts";
import { captureCli, parseJson } from "./helpers.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now = Date.now();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "monitor-evidence-cli-")), store = openMonitorStore(root), epoch = randomUUID();
  await store.initialize(); await store.begin(epoch, now, [agentId]);
  await store.ingestEvidence({ epoch, sourceKey: "b".repeat(64), expectedCursor: null, nextCursor: "one", atMs: now, events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(now).toISOString(), hostGenerationId: "host-secret-identity", mode: "route", agentId, turnId: "turn-private", stepId: "step-private", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", raw: "PRIVATE_SENTINEL" } }] });
  const incidentId = (await store.incidents())[0]!.id;
  const deps = { configDir: join(root,"client"), boxRuntimeRoot: root, env: {}, transport: "local" as const, discoveryPath: join(root,"NO_GATEWAY"), daemonSocket: join(root,"NO_DAEMON"), stdinIsTTY: true };
  return { root, store, incidentId, deps, close: () => rm(root,{recursive:true,force:true}) };
}

test("the actual notice command exports its frozen revision without Gateway or any DB writes", async () => {
  const f = await fixture();
  try {
    const work = (await f.store.notificationWork())[0]!;
    const notice = await f.store.notificationNotice(String(work.id));
    const before = await readFile(f.store.path);
    const result = await captureCli(notice.commands[0]!.argv.slice(1), f.deps);
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { incidentId: f.incidentId, evidenceRevision: 1, state: "available", replayAuthorized: false } });
    expect(await readFile(f.store.path)).toEqual(before);
    expect(result.stdout).not.toContain("PRIVATE_SENTINEL");
  } finally { await f.close(); }
});
test("public export keeps structural cause but no real IDs, source digests or free text", async () => {
  const f = await fixture();
  try {
    const result = await captureCli(["runtime","monitor","incident",f.incidentId,"--view","public-summary","--json"],f.deps);
    expect(result.code,result.stderr).toBe(0);
    expect(result.stdout).toContain("undeclared_tool");
    for(const value of [agentId,f.incidentId,"host-secret-identity","turn-private","step-private","PRIVATE_SENTINEL"]) expect(result.stdout).not.toContain(value);
    expect(parseJson(result.stdout)).toMatchObject({data:{view:"public-summary",replayAuthorized:false}});
  } finally { await f.close(); }
});
test("capture and lease are separate explicit writes, not side effects of GET", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.store.path);
    const denied = await captureCli(["runtime","monitor","capture","--incident",f.incidentId],f.deps);
    expect(denied.code).not.toBe(0);expect(await readFile(f.store.path)).toEqual(before);
    const captured = await captureCli(["runtime","monitor","capture","--step","step-private","--agent",agentId,"--confirm"],f.deps);
    expect(captured.code,captured.stderr).toBe(0);expect(parseJson(captured.stdout)).toMatchObject({data:{revision:1,duplicate:true}});
    const leased = await captureCli(["runtime","monitor","evidence","lease",f.incidentId,"--revision","1","--duration-ms","1000","--confirm"],f.deps);
    expect(leased.code,leased.stderr).toBe(0);expect(parseJson(leased.stdout)).toMatchObject({data:{incidentId:f.incidentId,evidenceRevision:1}});
  } finally { await f.close(); }
});
test("actual packed Node CLI reads the same frozen evidence without model, Gateway or storage writes", async () => {
  const f=await fixture();
  try{
    const before=await readFile(f.store.path),names=await readdir(join(f.root,"observability"));
    const args=[ensurePackedCli(),"runtime","monitor","incident",f.incidentId,"--evidence-revision","1","--json"];
    const child=spawn("node",args,{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.deps.configDir,GROKBOX_BOX_RUNTIME_ROOT:f.root},stdio:["ignore","pipe","pipe"],timeout:10000});
    let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("close",resolve);child.once("error",reject);});
    expect(code,stderr).toBe(0);
    expect(JSON.parse(stdout).data).toEqual(await f.store.incidentEvidence(f.incidentId,1));
    expect(await readFile(f.store.path)).toEqual(before);expect(await readdir(join(f.root,"observability"))).toEqual(names);
  }finally{await f.close();}
},15000);

test("storage status is read-only and does not claim to enforce the whole installation budget", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.store.path), names = await readdir(join(f.root, "observability"));
    const result = await captureCli(["runtime", "storage", "status", "--json"], f.deps);
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { scope: "monitor_database_only", installationBudgetEnforced: false,
      growthGuard: { maxDatabaseBytes: 128 * 1024 * 1024 }, auxiliary: { bytes: 0, unavailable: [] } } });
    expect(await readFile(f.store.path)).toEqual(before); expect(await readdir(join(f.root, "observability"))).toEqual(names);
    const missing = await captureCli(["runtime", "storage", "status"], { ...f.deps, boxRuntimeRoot: join(f.root, "missing-root") });
    expect(missing.code).not.toBe(0); expect(await readdir(join(f.root, "observability"))).toEqual(names);
  } finally { await f.close(); }
});

test("missing monitor query never initializes a database; a remote Gateway cannot join local evidence", async () => {
  const root=await mkdtemp(join(tmpdir(),"monitor-missing-"));
  try{
    const before=await readdir(root);
    const result=await captureCli(["runtime","monitor","incident",randomUUID()],{configDir:root,boxRuntimeRoot:join(root,"durable"),env:{},transport:"local",stdinIsTTY:true});
    expect(result.code).not.toBe(0);expect(await readdir(root)).toEqual(before);
    const remote=await captureCli(["runtime","monitor","incident",randomUUID()],{configDir:root,boxRuntimeRoot:join(root,"durable"),env:{},transport:"local",gatewayServerUrl:"http://127.0.0.1:1",stdinIsTTY:true});
    expect(remote.code).not.toBe(0);expect(remote.stderr+remote.stdout).toContain("runtime_local_only");expect(await readdir(root)).toEqual(before);
  }finally{await rm(root,{recursive:true,force:true});}
});

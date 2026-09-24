import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectPid } from "../../src/internal/process/linux.node.ts";
import { createLiveH3AdoptPorts } from "../../src/internal/process/h3-live.ts";
import { spawnIndependentGuardian } from "../../src/internal/process/guardian-process.ts";
import type { ProcessPort } from "../../src/internal/process/process-port.ts";

const root = process.argv[2]!;
await mkdir(root, { recursive: true });
const victim = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
const victimExit = new Promise<void>(resolve => victim.once("close", () => resolve()));
await new Promise<void>((resolve, reject) => { victim.stdout!.once("data", () => resolve()); victim.once("error", reject); });
const victimIdentity = inspectPid(victim.pid!)!;
assert(victimIdentity);
const inspectOwned = (pid: number) => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!)) return null; }
  catch { return null; }
  return inspectPid(pid);
};
const port: ProcessPort = { inspect: inspectOwned, list: () => [], signal: () => { throw Error("fixture leaf cannot signal"); } };
async function until(predicate: () => boolean | Promise<boolean>) {
  const start = Date.now();
  while (!await predicate()) { assert(Date.now() - start < 4000, "owned fixture did not settle"); await delay(10); }
}
const results: string[] = [];
try {
  for (const scenario of ["delayed-gateway", "postcompile-exit", "guardian-expiry", "injector-death"] as const) {
    const dir = join(root, scenario); await mkdir(dir);
    const markerPath = join(dir, "marker.json"), gatewayPath = join(dir, "gateway.json"), specPath = join(dir, "spec.json");
    const hostPath = join(dir, "host-main.cjs");
    const fixtureSecret = "fixture-output-must-stay-discarded";
    await writeFile(hostPath, `const fs=require('node:fs');
const stat=fs.readFileSync('/proc/self/stat','utf8');
const start=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
fs.writeFileSync(process.env.MARKER,JSON.stringify({operationId:'original',pid:process.pid,start,mode:'identity',transformed:true,compiled:true,modeld:false}));
process.stdout.write('${fixtureSecret}');process.stderr.write('${fixtureSecret}');
${scenario === "delayed-gateway" ? "setTimeout(()=>fs.writeFileSync(process.env.GATEWAY,JSON.stringify({pid:process.pid})),150);setInterval(()=>{},1000);" : scenario === "postcompile-exit" ? "setTimeout(()=>process.exit(17),100);" : "setInterval(()=>{},1000);"}
`);
    await writeFile(specPath, JSON.stringify({ execPath: process.execPath, argv: [hostPath], env: {
      GROKBOX_OPERATION_ID: "original", MARKER: markerPath, GATEWAY: gatewayPath,
    } }));
    const ports = createLiveH3AdoptPorts({ markerPath, gatewayPath, overlayPath: specPath, preloadNeedle: "fixture-preload",
      execPath: process.execPath, processes: port, waitMs: 2000 });
    const helper = await ports.spawnTempSupervisor();
    assert(helper); assert.equal(ports.tempSpawned?.(), true);
    let child: { pid: number; start: number } | undefined;
    let guardian: Awaited<ReturnType<typeof spawnIndependentGuardian>> | undefined;
    try {
      await until(() => { const evidence = ports.childEvidence?.(); if (!evidence) return false; child = evidence; return !!inspectOwned(evidence.pid); });
      await until(async () => { try { await readFile(markerPath); return true; } catch { return false; } });
      if (scenario === "guardian-expiry" || scenario === "injector-death") {
        guardian = await spawnIndependentGuardian({ frozen: [victimIdentity], deadlineMs: scenario === "guardian-expiry" ? 250 : 2000, stateDir: dir, execPath: process.execPath });
        assert(guardian.armed); victim.kill("SIGSTOP");
        if (scenario === "injector-death") guardian.killInjector();
      }
      const start = Date.now(), ready = await ports.waitReady(child!.pid, guardian?.signal);
      if (scenario === "delayed-gateway") assert.equal(ready?.pid, child!.pid);
      else assert.equal(ready, null);
      if (scenario === "postcompile-exit") {
        await until(() => ports.childEvidence?.()?.exitCode === 17);
        assert(Date.now() - start < 1500, "exit should end readiness before its independent timeout");
      }
      if (scenario === "guardian-expiry" || scenario === "injector-death") {
        assert.equal(guardian!.end(), scenario === "guardian-expiry" ? "expired" : "lost"); assert(Date.now() - start < 1500);
        await until(() => readFileSync(`/proc/${victim.pid}/stat`, "utf8").split(") ")[1]![0] !== "T");
        await until(() => !inspectOwned(guardian!.injectorPid!));
        const { readdir } = await import("node:fs/promises");
        const name = (await readdir(dir)).find(name => name.endsWith(".result.json"));
        assert(name); const release = JSON.parse(await readFile(join(dir, name), "utf8"));
        assert.equal(release.reason, scenario === "guardian-expiry" ? "expired" : "owner-ended"); assert.deepEqual(release.continued, [{ pid: victimIdentity.pid, start: victimIdentity.start }]);
      }
      const receipt = await readFile(`${specPath}.child.json`, "utf8");
      assert(!receipt.includes(fixtureSecret)); assert(receipt.length < 1024);
      results.push(scenario);
    } finally {
      guardian?.release(); guardian?.dispose();
      if (child && inspectOwned(child.pid)?.start === child.start) {
        process.kill(child.pid, "SIGTERM"); await until(() => !inspectOwned(child!.pid));
      }
      if (inspectOwned(helper.pid)?.start === helper.start) process.kill(helper.pid, "SIGTERM");
      await until(() => !inspectOwned(helper.pid));
    }
  }
} finally { victim.kill("SIGCONT"); victim.kill("SIGTERM"); await victimExit; }
console.log(JSON.stringify({ cases: results, isolated: true, rawOutputCaptured: false }));

import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { liveControlResourcesLayer, readControllerOperation } from "../../src/internal/roots/controller-program.node.ts";
import { runTransientAdoptOperation } from "../../src/internal/process/transient-adopt.ts";
import { FakeProcessTree } from "../fake-tree.ts";
import { identitiesMatch, type ProcessIdentity } from "../../src/internal/process/process-port.ts";
import { inspectPid, roleOf } from "../../src/internal/process/linux.node.ts";
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
        let name: string | undefined;
        await until(async () => { name = (await readdir(dir)).find(name => name.endsWith(".result.json")); return name !== undefined; });
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
  // Delayed child shutdown exercises the operation owner, not fixture-only cleanup.
  const dir = join(root, "delayed-cleanup"); await mkdir(dir);
  const markerPath = join(dir, "marker.json"), specPath = join(dir, "spec.json"), termPath = join(dir, "term-received");
  const hostPath = join(dir, "host-main.cjs");
  await writeFile(hostPath, `const fs=require('node:fs');let stopping=false;
process.on('SIGTERM',()=>{if(!stopping){stopping=true;fs.writeFileSync(process.env.TERM,'received');setTimeout(()=>process.exit(0),1000);}});
const stat=fs.readFileSync('/proc/self/stat','utf8');const start=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
fs.writeFileSync(process.env.MARKER,JSON.stringify({operationId:'original',pid:process.pid,start,mode:'identity',transformed:true,compiled:true,modeld:false}));setInterval(()=>{},1000);`);
  await writeFile(specPath, JSON.stringify({ execPath: process.execPath, argv: [hostPath], env: { GROKBOX_OPERATION_ID: "original", GROKBOX_BOX_RUNTIME_ROOT: dir, GROKBOX_HOST_BUNDLE: hostPath, GROKBOX_PRELOAD_MODE: "identity", MARKER: markerPath, TERM: termPath } }));
  const tree = new FakeProcessTree(); tree.nextPid = 900000001;
  const wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }); tree.spawn("host", { parent: supervisor });
  let helper: ProcessIdentity | null = null, host: ProcessIdentity | null = null;
  let guardian: Awaited<ReturnType<typeof spawnIndependentGuardian>> | undefined;
  const processes: ProcessPort = {
    inspect: pid => tree.inspect(pid) ?? inspectOwned(pid),
    list: () => [...tree.list(), ...[helper, host].flatMap(row => row ? [inspectOwned(row.pid)].filter((value): value is ProcessIdentity => value !== null) : [])],
    signal: (expected, signal) => {
      if (tree.inspect(expected.pid)) return tree.signal(expected, signal);
      assert([helper, host].some(row => row?.pid === expected.pid && row.start === expected.start), "only fixture-owned identities may be signaled");
      if (!identitiesMatch(expected, inspectOwned(expected.pid))) return { ok: false, reason: "identity-mismatch" };
      process.kill(expected.pid, signal); return { ok: true };
    },
  };
  const classify = (row: ProcessIdentity) => {
    const role = tree.roles().find(item => item.pid === row.pid)?.role;
    return role === "wrapper" || role === "supervisor" || role === "host" ? role : roleOf(row);
  };
  const ports = createLiveH3AdoptPorts({ markerPath, gatewayPath: join(dir, "gateway.json"), overlayPath: specPath,
    preloadNeedle: "fixture", execPath: process.execPath, processes, classify, waitMs: 2000 });
  try {
    const layer = liveControlResourcesLayer({ inspect: () => ({ ok: true, reason: null, strategy: "transient" }), adopt: async () =>
      runTransientAdoptOperation({ operationId: "original", ephemeralRoot: dir, processes, classify,
        reviewedProfile: { profileId: "fixture", sourceSha256: "a".repeat(64), transformedSourceSha256: "b".repeat(64), slices: [] },
        diskSha: () => "a".repeat(64), now: Date.now,
        readMarker: () => { try { return JSON.parse(readFileSync(markerPath, "utf8")); } catch { return null; } },
        readGatewayPid: ports.readGatewayPid, waitGone: ports.waitHostGone, waitReady: ports.waitReady,
        childEvidence: ports.childEvidence, tempSpawned: ports.tempSpawned, markerPath, preloadSha256: "d".repeat(64), creationEvidence: ports.creationEvidence,
        spawnTempSupervisor: async signal => { helper = await ports.spawnTempSupervisor(signal); return helper; },
        waitNewHost: async () => { await until(() => { const row = ports.childEvidence?.(); host = row ? inspectOwned(row.pid) : null; return host !== null; }); return host; },
        armGuardian: async () => { guardian = await spawnIndependentGuardian({ frozen: [victimIdentity], operationId: "original", deadlineMs: 250, stateDir: dir, execPath: process.execPath });
          assert(guardian.armed); return { ok: true, release: guardian.release, signal: guardian.signal, end: guardian.end, continued: guardian.continued, owners: guardian.owners, dispose: guardian.dispose }; },
        hasGrokboxPreload: row => row.pid === host?.pid,
      }) });
    const request = { intent: "apply" as const, confirmed: true, operationId: "original", boxRoot: dir, strategy: "transient" as const };
    const receipt = await Effect.runPromise(runControllerOperation(request).pipe(Effect.provide(layer)));
    assert.equal(receipt.reason, "guardian-ownership-ended");
    await until(async () => { try { await readFile(termPath); return true; } catch { return false; } });
    assert(host && inspectOwned((host as ProcessIdentity).pid), "counterexample requires a still-live child after operation completion");
    const row = readControllerOperation(dir, "original");
    assert.equal(row?.state, "unknown");
    const diagnostic = JSON.parse(JSON.stringify(row?.prefix?.diagnostic));
    assert.equal(diagnostic.cleanup?.find((item: { role: string }) => item.role === "host")?.outcome, "unproven", "delayed exit must be durable, not mistaken for joined cleanup");
    assert.deepEqual(receipt.diagnostic, row?.prefix?.diagnostic);
    const journal = JSON.parse(await readFile(join(dir, "state", "adopt-op.json"), "utf8"));
    assert.deepEqual(journal.failure, row?.prefix?.diagnostic);
    assert.equal(journal.creation.operationId, "original");
    assert.equal(journal.creation.launch.rootDigest, sha256Text(dir));
    assert.equal(journal.creation.launch.targetDigest, sha256Text(hostPath));
    assert.equal(journal.creation.launch.argvDigest, sha256Text(canonicalJson([process.execPath, hostPath])));
    assert.equal(journal.creation.launch.uid, process.getuid!());
    assert.equal(journal.creation.launch.mode, "identity");
    assert.deepEqual(journal.creation.host, { pid: (host as unknown as ProcessIdentity).pid, start: (host as unknown as ProcessIdentity).start });
    assert.deepEqual(journal.creation.tempSupervisor, { pid: (helper as unknown as ProcessIdentity).pid, start: (helper as unknown as ProcessIdentity).start });
    assert.deepEqual(journal.creation.guardian, guardian!.owners()!.guardian);
    assert.deepEqual(journal.creation.holder, guardian!.owners()!.holder);
    await until(() => !inspectOwned((host as unknown as ProcessIdentity).pid));
    assert.deepEqual(readControllerOperation(dir, "original"), row, "late fixture exit must not rewrite unknown as success");
    assert.equal((await Effect.runPromise(runControllerOperation(request).pipe(Effect.provide(layer)))).reason, "uncertain-operation");
    results.push("delayed-cleanup");
  } finally {
    guardian?.release(); guardian?.dispose();
    for (const identity of [host, helper] as Array<ProcessIdentity | null>) {
      if (identity && inspectOwned(identity.pid)?.start === identity.start) process.kill(identity.pid, "SIGTERM");
      if (identity) await until(() => !inspectOwned(identity.pid));
    }
  }
} finally { victim.kill("SIGCONT"); victim.kill("SIGTERM"); await victimExit; }
console.log(JSON.stringify({ cases: results, isolated: true, rawOutputCaptured: false }));

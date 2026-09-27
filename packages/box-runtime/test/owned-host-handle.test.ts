import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { pinOwnedHost, type RetirementTarget } from "../src/internal/process/owned-host-handle.node.ts";
import { readNativeHostIdle } from "../src/internal/io/management-gateway.node.ts";
import { acquireAdvisoryGate, type AdvisoryGate } from "../src/internal/io/advisory-gate.node.ts";
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

async function ownedChild(withGates = true, holdTermination = false) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-pidfd-owned-")), file = join(root, "owned-host.cjs"), operationId = "owned-kernel-handle";
  const termFile = join(root, "term-received");
  await writeFile(file, holdTermination
    ? `process.on("SIGTERM",()=>require("node:fs").writeFileSync(${JSON.stringify(termFile)},"term")); process.stdin.on("data",()=>process.exit(0)); process.stdout.write("ready\\n"); setInterval(()=>{},1000);`
    : 'process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  const child = spawn("node", [file], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH,
    GROKBOX_OPERATION_ID: operationId, GROKBOX_PRELOAD_MODE: "route", GROKBOX_BOX_RUNTIME_ROOT: root, GROKBOX_HOST_BUNDLE: file } });
  child.stdin.on("error", () => {});
  const joined = new Promise<void>(resolve => child.once("close", () => resolve()));
  const gatePaths = ["controller", "identity", "modeld"].map(name => join(root, `${name}.gate`));
  const gates: AdvisoryGate[] = [];
  try {
    if (withGates) for (const path of gatePaths) {
      const gate = await acquireAdvisoryGate(path); if (!gate) throw Error("fixture gate unavailable"); gates.push(gate);
    }
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(Error("child exited before ready"))); });
    const pid = child.pid!, stat = await readFile(`/proc/${pid}/stat`, "utf8"), argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0$/, "").split("\0");
    const target: RetirementTarget = { pid, start: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]), uid: process.getuid!(), operationId, mode: "route",
      rootDigest: sha256Text(root), targetDigest: sha256Text(file), exeDigest: sha256Text(await readlink(`/proc/${pid}/exe`)), argvDigest: sha256Text(JSON.stringify(argv)) };
    return { child, target, joined, root, termFile, gatePaths, descriptors: gates.flatMap(gate => [...gate.descriptors()]), close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (holdTermination) child.stdin.end("exit\n"); else child.kill("SIGTERM");
      }
      await joined; for (const gate of gates) await gate.release();
    } };
  } catch (error) {
    if (holdTermination) child.stdin.end("exit\n"); else child.kill("SIGTERM");
    await joined; for (const gate of gates) await gate.release(); throw error;
  }
}

const nativeTest = test.skipIf(process.platform !== "linux");
nativeTest("kernel handle sends one SIGTERM and observes the exact child exit", async () => {
  const f = await ownedChild(); const handle = await pinOwnedHost(f.target, new AbortController().signal, f.descriptors);
  try {
    expect(await handle.terminate()).toEqual({ signaled: true, exitObserved: true });
    await expect(handle.terminate()).rejects.toThrow("retirement-handle-unavailable");
    await f.joined; expect(f.child.exitCode).toBe(0);
  } finally { await handle.close(); await f.close(); }
});

nativeTest("closing a pinned handle without the command never signals the Host", async () => {
  const f = await ownedChild();
  try {
    const handle = await pinOwnedHost(f.target, new AbortController().signal, f.descriptors); await handle.close();
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});

for (const field of ["start", "operationId", "argvDigest"] as const) nativeTest(`kernel handle rejects changed ${field} before signaling`, async () => {
  const f = await ownedChild();
  try {
    const changed = { ...f.target, [field]: field === "start" ? f.target.start + 1 : "wrong" } as RetirementTarget;
    await expect(pinOwnedHost(changed, new AbortController().signal, f.descriptors)).rejects.toThrow();
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});

nativeTest("a pinned child that already exited cannot cause another signal", async () => {
  const f = await ownedChild(); const handle = await pinOwnedHost(f.target, new AbortController().signal, f.descriptors);
  try {
    f.child.kill("SIGTERM"); await f.joined;
    expect(await handle.terminate()).toEqual({ signaled: false, exitObserved: false });
  } finally { await handle.close(); await f.close(); }
});

nativeTest("controller death after dispatch cannot release any gate while the helper can signal", async () => {
  const f = await ownedChild(false, true);
  const entry = join(f.root, "controller.mjs"), plan = join(f.root, "plan.json");
  await writeFile(plan, JSON.stringify({ target: f.target, gates: f.gatePaths }));
  await copyFile(new URL("../src/internal/process/helpers/owned-host-retirement.py", import.meta.url), join(f.root, "owned-host-retirement.py"));
  await build({ stdin: { contents: `
    import {readFileSync} from 'node:fs';
    import {acquireAdvisoryGate} from ${JSON.stringify(new URL("../src/internal/io/advisory-gate.node.ts", import.meta.url).pathname)};
    import {pinOwnedHost} from ${JSON.stringify(new URL("../src/internal/process/owned-host-handle.node.ts", import.meta.url).pathname)};
    const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
    const gates=[]; for(const path of plan.gates){const gate=await acquireAdvisoryGate(path);if(!gate)throw Error('gate');gates.push(gate);}
    const handle=await pinOwnedHost(plan.target,new AbortController().signal,gates.flatMap(g=>g.descriptors()));
    const children=readFileSync('/proc/self/task/'+process.pid+'/children','utf8').trim().split(/\\s+/).map(Number);
    if(children.length!==1)throw Error('children');
    process.stdout.write(JSON.stringify({event:'pinned',pid:children[0]})+'\\n');
    process.stdin.once('data',()=>{const work=handle.terminate();void work.catch(()=>{});setImmediate(()=>process.stdout.write(JSON.stringify({event:'dispatched'})+'\\n'));});
    `, resolveDir: import.meta.dir, sourcefile: "owned-retirement-controller.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: entry, logLevel: "silent" });
  const controller = spawn("node", [entry, plan], { stdio: ["pipe", "pipe", "ignore"] });
  controller.stdin.on("error", () => {});
  const closed = new Promise<void>(resolve => controller.once("close", () => resolve()));
  let helperPid: number | undefined, dispatch!: () => void, pinned!: () => void, buffer = "";
  const ready = new Promise<void>(resolve => { pinned = resolve; }), sent = new Promise<void>(resolve => { dispatch = resolve; });
  controller.stdout.on("data", chunk => {
    buffer += chunk.toString(); let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const row = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (row.event === "pinned") { helperPid = row.pid; pinned(); }
      if (row.event === "dispatched") dispatch();
    }
  });
  const deadline = async (work: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("fixture deadline")), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await deadline(ready); process.kill(helperPid!, "SIGSTOP");
    controller.stdin.write("dispatch\n"); await deadline(sent);
    controller.kill("SIGKILL"); await closed;
    for (const path of f.gatePaths) { const gate = await acquireAdvisoryGate(path); if (gate) await gate.release(); expect(gate).toBeNull(); }
    process.kill(helperPid!, "SIGCONT");
    await deadline((async () => { const until = Date.now() + 4500; while (Date.now() < until) { try { await readFile(f.termFile); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } } throw Error("signal not observed"); })());
    for (const path of f.gatePaths) { const gate = await acquireAdvisoryGate(path); if (gate) await gate.release(); expect(gate).toBeNull(); }
    f.child.stdin.end("exit\n"); await f.joined;
    await deadline((async () => {
      const until = Date.now() + 4500;
      while (Date.now() < until) {
        const gates = await Promise.all(f.gatePaths.map(path => acquireAdvisoryGate(path)));
        const ready = gates.every(Boolean); for (const gate of gates) await gate?.release();
        if (ready) return; await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error("gates did not release");
    })());
  } finally {
    if (helperPid) try { process.kill(helperPid, "SIGCONT"); } catch {}
    if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
    await closed; await f.close();
  }
}, 20000);

for (const scenario of ["idle", "busy", "missing", "wrong-pid", "credential-change", "redirect"] as const) test(`retirement native idle reader: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-idle-native-")), path = join(root, "gateway.json");
  let requests = 0;
  const source = { scheme: "http", host: "127.0.0.1", port: 0, pid: 400, startedAt: 500, token: "owned-test-token" };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
    requests++; expect(new URL(request.url).pathname).toBe("/api/getHostStatus"); expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer owned-test-token");
    if (scenario === "credential-change") await writeFile(path, JSON.stringify({ ...source, token: "changed-test-token" }));
    if (scenario === "redirect") return new Response(null, { status: 302, headers: { location: "/forbidden" } });
    return Response.json(scenario === "missing" ? {} : { isBusy: scenario === "busy" });
  } });
  source.port = server.port!; await writeFile(path, JSON.stringify(source), { mode: 0o600 });
  try {
    const call = readNativeHostIdle(path, scenario === "wrong-pid" ? 401 : 400, new AbortController().signal);
    if (scenario === "idle") expect(await call).toMatchObject({ pid: 400, startedAt: 500 });
    else await expect(call).rejects.toThrow();
    expect(requests).toBe(scenario === "wrong-pid" ? 0 : 1);
  } finally { server.stop(true); }
});

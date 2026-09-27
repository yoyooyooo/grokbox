import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { pinOwnedHost, type RetirementTarget } from "../src/internal/process/owned-host-handle.node.ts";
import { readNativeHostIdle } from "../src/internal/io/management-gateway.node.ts";

async function ownedChild() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-pidfd-owned-")), file = join(root, "owned-host.cjs"), operationId = "owned-kernel-handle";
  await writeFile(file, 'process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  const child = spawn("node", [file], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH,
    GROKBOX_OPERATION_ID: operationId, GROKBOX_PRELOAD_MODE: "route", GROKBOX_BOX_RUNTIME_ROOT: root, GROKBOX_HOST_BUNDLE: file } });
  const joined = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(Error("child exited before ready"))); });
    const pid = child.pid!, stat = await readFile(`/proc/${pid}/stat`, "utf8"), argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0$/, "").split("\0");
    const target: RetirementTarget = { pid, start: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]), uid: process.getuid!(), operationId, mode: "route",
      rootDigest: sha256Text(root), targetDigest: sha256Text(file), exeDigest: sha256Text(await readlink(`/proc/${pid}/exe`)), argvDigest: sha256Text(JSON.stringify(argv)) };
    return { child, target, joined, close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await joined; } };
  } catch (error) { child.kill("SIGTERM"); await joined; throw error; }
}

const nativeTest = test.skipIf(process.platform !== "linux");
nativeTest("kernel handle sends one SIGTERM and observes the exact child exit", async () => {
  const f = await ownedChild(); const handle = await pinOwnedHost(f.target, new AbortController().signal);
  try {
    expect(await handle.terminate()).toEqual({ signaled: true, exitObserved: true });
    await expect(handle.terminate()).rejects.toThrow("retirement-handle-unavailable");
    await f.joined; expect(f.child.exitCode).toBe(0);
  } finally { await handle.close(); await f.close(); }
});

nativeTest("closing a pinned handle without the command never signals the Host", async () => {
  const f = await ownedChild();
  try {
    const handle = await pinOwnedHost(f.target, new AbortController().signal); await handle.close();
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});

for (const field of ["start", "operationId", "argvDigest"] as const) nativeTest(`kernel handle rejects changed ${field} before signaling`, async () => {
  const f = await ownedChild();
  try {
    const changed = { ...f.target, [field]: field === "start" ? f.target.start + 1 : "wrong" } as RetirementTarget;
    await expect(pinOwnedHost(changed, new AbortController().signal)).rejects.toThrow();
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});

nativeTest("a pinned child that already exited cannot cause another signal", async () => {
  const f = await ownedChild(); const handle = await pinOwnedHost(f.target, new AbortController().signal);
  try {
    f.child.kill("SIGTERM"); await f.joined;
    expect(await handle.terminate()).toEqual({ signaled: false, exitObserved: false });
  } finally { await handle.close(); await f.close(); }
});

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

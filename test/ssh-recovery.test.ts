import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureInstalledDaemonThroughSsh, remoteEnsureInstalledDaemonCommand } from "../packages/cli/src/daemon/ssh-recovery.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await check()) return; await pause(10); }
  throw Error("owned_service_did_not_settle");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-ssh-recovery-")), config = join(root, ".grokbox"), binary = join(config, "runtime/bin/grokbox");
  for (const relative of ["runtime/bin", "daemon", "run"]) await mkdir(join(config, relative), { recursive: true, mode: 0o700 });
  await writeFile(join(config, "config.json"), "{\"owned\":true}\n", { mode: 0o600 });
  // A synthetic installed service, not a fake result of the recovery adapter.
  // The original shell really performs its checks and launches this Node process.
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const home=process.env.HOME,root=path.join(home,'.grokbox'),args=process.argv.slice(2);
if(args.join(' ')==='daemon status')process.exit(fs.existsSync(path.join(home,'ready'))?0:1);
if(args.join(' ')!=='daemon serve')process.exit(8);
fs.appendFileSync(path.join(home,'starts'),String(process.pid)+'\\n',{mode:0o600});
const server=net.createServer(socket=>socket.end());
server.listen(path.join(root,'run/daemon.sock'),()=>fs.writeFileSync(path.join(home,'ready'),'ready',{mode:0o600}));
process.once('SIGTERM',()=>server.close(()=>{fs.rmSync(path.join(home,'ready'),{force:true});fs.writeFileSync(path.join(home,'stopped'),'stopped',{mode:0o600});}));
`, { mode: 0o700 });
  const base = createProductionDeps(), commands: string[][] = [];
  const deps = { ...base, runCommand: async (argv: readonly string[]) => {
    commands.push([...argv]);
    expect(argv.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "explicit-test-host"]);
    expect(argv.length).toBe(7);
    const child = spawn("sh", ["-c", argv[6]!], { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += String(b)); child.stderr.on("data", b => stderr += String(b));
    const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
    try { const [code] = await once(child, "close"); return { code: Number(code), stdout, stderr }; }
    finally { clearTimeout(timer); }
  } };
  return { root, config, binary, deps, commands,
    close: async () => {
      const starts = await readFile(join(root, "starts"), "utf8").catch(() => "");
      for (const id of starts.trim().split("\n").filter(Boolean)) {
        const pid = Number(id); if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) throw Error("unowned_cleanup_pid");
        try { process.kill(pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      if (starts) await until(() => readFile(join(root, "stopped"), "utf8").then(v => v === "stopped", () => false));
      await rm(root, { recursive: true, force: true });
    } };
}

test("real recovery shell observes an already healthy installation without starting or replacing anything", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "ready"), "already-running");
    expect(await ensureInstalledDaemonThroughSsh(f.deps, "explicit-test-host")).toEqual({ changed: false });
    expect(await readFile(join(f.root, "starts"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(f.config, "config.json"), "utf8")).toBe("{\"owned\":true}\n");
  } finally { await f.close(); }
});

test("real recovery shell starts only the installed executable and a second ensure does not duplicate it", async () => {
  const f = await fixture();
  try {
    expect(await ensureInstalledDaemonThroughSsh(f.deps, "explicit-test-host")).toEqual({ changed: true });
    const starts = await readFile(join(f.root, "starts"), "utf8");
    expect(starts.trim().split("\n")).toHaveLength(1);
    expect(await readFile(join(f.config, "daemon/daemon.pid"), "utf8")).toBe(starts);
    expect(await ensureInstalledDaemonThroughSsh(f.deps, "explicit-test-host")).toEqual({ changed: false });
    expect(await readFile(join(f.root, "starts"), "utf8")).toBe(starts);
    expect(await readFile(join(f.config, "config.json"), "utf8")).toBe("{\"owned\":true}\n");
  } finally { await f.close(); }
}, 15000);

test("an existing live but unhealthy PID is preserved and a missing executable is not bootstrapped", async () => {
  const f = await fixture();
  try {
    const pidFile = join(f.config, "daemon/daemon.pid"); await writeFile(pidFile, String(process.pid));
    await expect(ensureInstalledDaemonThroughSsh(f.deps, "explicit-test-host")).rejects.toMatchObject({ code: "recover_unavailable", failureCode: "daemon_process_unhealthy" });
    expect(await readFile(pidFile, "utf8")).toBe(String(process.pid));
    await rm(f.binary);
    await expect(ensureInstalledDaemonThroughSsh(f.deps, "explicit-test-host")).rejects.toMatchObject({ code: "recover_unavailable", failureCode: "daemon_install_required" });
    expect(await readFile(join(f.root, "starts"), "utf8").catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

test("the generic SSH adapter rejects unsafe addressing and unknown completion, never inferring success", async () => {
  const f = await fixture();
  try {
    await expect(ensureInstalledDaemonThroughSsh(f.deps, "-oProxyCommand=unexpected")).rejects.toThrow();
    expect(f.commands).toEqual([]);
    const deps = { ...f.deps, runCommand: async () => ({ code: 0, stdout: "not-an-outcome\n", stderr: "" }) };
    await expect(ensureInstalledDaemonThroughSsh(deps, "explicit-test-host")).rejects.toMatchObject({ code: "recover_failed", failureCode: "daemon_ensure_invalid" });
    expect(remoteEnsureInstalledDaemonCommand()).not.toContain("sudo");
  } finally { await f.close(); }
});

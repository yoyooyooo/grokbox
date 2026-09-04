import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec } from "../src/commands/exec.ts";
import { writeProfileFile } from "../src/config/profile.ts";
import type { DaemonProcessConfig } from "../src/daemon/config.ts";
import { validateDaemonConfig } from "../src/daemon/config.ts";
import { LocalDaemonClient } from "../src/daemon/client.ts";
import { GovernedFilesystem } from "../src/daemon/filesystem.ts";
import { JobManager } from "../src/daemon/jobs.ts";
import { ProcessAuthority } from "../src/daemon/process.ts";
import { startDaemonHost, type DaemonHost } from "../src/daemon/host.ts";
import { createProductionDeps } from "../src/deps.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery, type MockGateway } from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const describeLinux = process.platform === "linux" ? describe : describe.skip;
function data<T>(stdout: string): T { return (parseJson(stdout) as { data: T }).data; }
let host: DaemonHost | undefined;
let gateway: MockGateway | undefined;
afterEach(async () => {
  await host?.close().catch(() => undefined);
  gateway?.stop();
  host = undefined;
  gateway = undefined;
});

async function nodeExecutable(): Promise<string> {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is unavailable in PATH.");
  return await realpath(node);
}

async function fixture(maxOutputBytes = 2 * 1024 * 1024) {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-jobs-config-"));
  const root = await mkdtemp(join(tmpdir(), "grokbox-jobs-root-"));
  const socket = join(configDir, "run", "daemon.sock");
  const executable = await nodeExecutable();
  gateway = await startMockGateway();
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const processConfig: DaemonProcessConfig = {
    cwdRoots: ["workspace"], defaultCwdRoot: "workspace",
    executables: [{ name: "node", path: executable }], environment: ["VISIBLE"],
    maxConcurrent: 1, maxQueued: 4, maxRuntimeMs: 120_000, maxOutputBytes,
  };
  host = await startDaemonHost(
    { ...createProductionDeps(), configDir, discoveryPath }, socket, undefined,
    [{ name: "workspace", path: root, operations: ["exec"] }], processConfig,
  );
  await writeProfileFile(configDir, "jobs", {
    version: 1,
    transport: "daemon",
    daemon_socket: socket,
    gateway_discovery: discoveryPath,
  });
  const run = async (argv: string[]) => await captureCli(["--profile", "jobs", ...argv], { configDir, skillsDir });
  return { configDir, root, socket, discoveryPath, processConfig, run };
}

async function terminal(run: (argv: string[]) => ReturnType<typeof captureCli>, jobId: string) {
  for (let count = 0; count < 400; count += 1) {
    const shown = await run(["jobs", "show", jobId]);
    const value = data<{ state: string }>(shown.stdout);
    if (!["queued", "running"].includes(value.state)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Job did not terminate");
}

describeLinux("structured execution and durable Jobs", () => {
  test("process config is strict and requires exec-admitted cwd roots", () => {
    const base = {
      version: 1,
      filesystem: { roots: [{ name: "workspace", path: "/tmp/workspace", operations: ["exec"] }] },
      process: {
        cwdRoots: ["workspace"], defaultCwdRoot: "workspace",
        executables: [{ name: "node", path: process.execPath }], environment: ["CI"],
        maxConcurrent: 1, maxQueued: 2, maxRuntimeMs: 1000, maxOutputBytes: 1024,
      },
    };
    expect(validateDaemonConfig(base).process?.executables[0]?.name).toBe("node");
    expect(() => validateDaemonConfig({ ...base, process: { ...base.process, surprise: true } })).toThrow();
    expect(() => validateDaemonConfig({ ...base, filesystem: { roots: [{ ...base.filesystem.roots[0], operations: ["read"] }] } })).toThrow();
    expect(() => validateDaemonConfig({ ...base, process: { ...base.process, environment: ["NODE_OPTIONS"] } })).toThrow();
    expect(() => validateDaemonConfig({ ...base, process: { ...base.process, executables: [...base.process.executables, ...base.process.executables] } })).toThrow();
  });

  test("Gateway-only execution fails before argv and environment handling", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-jobs-gateway-"));
    await writeProfileFile(configDir, "gateway", { version: 1, transport: "gateway", gateway_discovery: "/missing" });
    const result = await captureCli(
      ["--profile", "gateway", "exec", "run", "--env", "not-an-assignment", "--", "node"],
      { configDir, skillsDir },
    );
    expect(result.code).not.toBe(0);
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("capability_unavailable");
  });

  test("capabilities are policy-aware and structured argv is literal with bounded binary logs", async () => {
    const f = await fixture();
    const handshake = await new LocalDaemonClient(f.socket, 5_000).handshake();
    expect(handshake.capabilities).toContain("host.process.run");
    expect(handshake.capabilities).toContain("host.process.manage");
    expect(handshake.capabilities).not.toContain("host.process.shell");
    expect(handshake.filesystemRoots).toEqual([{ name: "workspace", operations: ["exec"] }]);

    const script = "process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(process.argv[1]);";
    const submitted = await f.run(["exec", "run", "--detach", "--env", "VISIBLE=yes", "--", "node", "-e", script, "literal;$(no-expand)"]);
    expect(submitted.code, submitted.stderr).toBe(0);
    const created = data<{ jobId: string; state: string; command: { argumentCount: number } }>(submitted.stdout);
    expect(created.command.argumentCount).toBe(3);
    const done = await terminal(f.run, created.jobId);
    expect(done.state).toBe("succeeded");

    const logs = await f.run(["jobs", "logs", created.jobId]);
    expect(logs.code).toBe(0);
    const content = logs.stdout.trim().split("\n").map((line) => parseJson(line) as { contentBase64: string; stream: string });
    expect(Buffer.concat(content.filter((event) => event.stream === "stdout").map((event) => Buffer.from(event.contentBase64, "base64")))).toEqual(Buffer.from([0, 255, 10]));
    expect(Buffer.concat(content.filter((event) => event.stream === "stderr").map((event) => Buffer.from(event.contentBase64, "base64"))).toString()).toBe("literal;$(no-expand)");
    expect(await readFile(join(f.configDir, "jobs", created.jobId, "state.json"), "utf8")).not.toContain(script);

    const foreground = await f.run(["--timeout-ms", "5000", "exec", "run", "--", "node", "-e", "process.exit(0)"]);
    expect(foreground.code, foreground.stderr).toBe(0);
    expect(data<{ state: string }>(foreground.stdout).state).toBe("succeeded");
  });

  test("submission identity is idempotent and RPC schemas reject destructive extras", async () => {
    const f = await fixture();
    const daemon = new LocalDaemonClient(f.socket, 5_000);
    const authority = await daemon.handshake();
    const jobId = randomUUID();
    const params = {
      jobId, cwd: "workspace:/", argv: ["node", "-e", "process.stdout.write('stable')"],
      environment: {}, runTimeoutMs: 5_000, output: "capture", shell: false,
      expectedDaemonGeneration: authority.daemonGeneration,
      waitMs: 0,
    };
    const first = (await daemon.call("jobSubmit", params)).result as { jobId: string };
    const duplicate = (await daemon.call("jobSubmit", params)).result as { jobId: string };
    expect(first.jobId).toBe(jobId);
    expect(duplicate.jobId).toBe(jobId);
    await expect(daemon.call("jobSubmit", { ...params, argv: ["node", "-e", "process.exit(1)"] })).rejects.toMatchObject({ code: "job_conflict" });
    await expect(daemon.call("jobSubmit", {
      ...params,
      jobId: randomUUID(),
      expectedDaemonGeneration: "22222222-2222-4222-8222-222222222222",
    })).rejects.toMatchObject({ code: "operation_outcome_unknown" });
    await expect(daemon.call("jobCancel", { jobId, cancelOperationId: randomUUID(), extra: true })).rejects.toMatchObject({ code: "gateway_bad_request" });
    await terminal(f.run, jobId);
    const left = await daemon.call("jobLogsRead", { jobId, offset: 0, limitBytes: 262_144, waitMs: 0 });
    const right = await daemon.call("jobLogsRead", { jobId, offset: 0, limitBytes: 262_144, waitMs: 0 });
    expect(left.result).toEqual(right.result);
    const movedRoot = `${f.root}-moved`;
    await rename(f.root, movedRoot);
    try {
      expect(((await daemon.call("jobSubmit", params)).result as { jobId: string }).jobId).toBe(jobId);
    } finally {
      await rename(movedRoot, f.root);
    }
  });

  test("submission recovery never replays against a changed daemon generation", async () => {
    const methods: string[] = [];
    let handshakes = 0;
    const handshake = (daemonGeneration: string) => ({
      protocolMajor: 1, daemonVersion: "0.0.1", daemonPid: 1, startedAt: 1, daemonGeneration,
      capabilities: ["host.process.run", "host.process.manage"], filesystemRoots: [],
      gateway: { pid: 2, startedAt: 2 },
    });
    const submittedAuthorities: string[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: { expectedDaemonGeneration?: string } };
      methods.push(request.method);
      if (request.method === "handshake") {
        handshakes += 1;
        return Response.json({
          ok: true,
          result: handshake(handshakes <= 2
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222"),
        });
      }
      if (request.method === "jobSubmit") {
        submittedAuthorities.push(request.params?.expectedDaemonGeneration ?? "");
        throw new TypeError("lost response");
      }
      return Response.json({
        ok: false,
        error: { code: "job_not_found", message: "not found", retryable: false },
      }, { status: 400 });
    }) as typeof globalThis.fetch;
    const deps = {
      ...createProductionDeps(),
      transport: "daemon" as const,
      daemonServerUrl: "https://daemon.invalid",
      daemonToken: "test-token",
      fetch,
      stdout: { write() {} },
      stderr: { write() {} },
    };
    await expect(runExec(deps, ["node", "-e", "process.exit(0)"], { detach: true }))
      .rejects.toMatchObject({ code: "operation_outcome_unknown" });
    expect(methods.filter((method) => method === "jobSubmit")).toHaveLength(1);
    expect(submittedAuthorities).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(methods.at(-1)).toBe("jobShow");
  });

  test("failed queued cancellation rollback retriggers scheduling", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-jobs-rollback-config-"));
    const root = await mkdtemp(join(tmpdir(), "grokbox-jobs-rollback-root-"));
    const executable = await nodeExecutable();
    const policy: DaemonProcessConfig = {
      cwdRoots: ["workspace"], defaultCwdRoot: "workspace",
      executables: [{ name: "node", path: executable }], environment: [],
      maxConcurrent: 1, maxQueued: 2, maxRuntimeMs: 10_000, maxOutputBytes: 1024,
    };
    const filesystem = await GovernedFilesystem.create([{ name: "workspace", path: root, operations: ["exec"] }], Date.now);
    const manager = await JobManager.create(configDir, await ProcessAuthority.create(policy), filesystem, Date.now);
    const runningId = randomUUID();
    const queuedId = randomUUID();
    const request = (jobId: string, script: string) => ({
      jobId, cwd: "workspace:/", argv: ["node", "-e", script], environment: {},
      runTimeoutMs: 10_000, output: "discard" as const, shell: false,
    });
    try {
      await manager.submit(request(runningId, "setTimeout(()=>{},100)"));
      expect((await manager.submit(request(queuedId, "process.exit(0)"))).state).toBe("queued");
      const internal = manager as unknown as { persist(job: { jobId: string; state: string }): Promise<void> };
      const persist = internal.persist.bind(manager);
      let entered!: () => void;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      internal.persist = async (job) => {
        if (job.jobId === queuedId && job.state === "cancelled") {
          entered();
          await blocked;
          throw new Error("injected persistence failure");
        }
        await persist(job);
      };
      const cancellation = manager.cancel(queuedId, randomUUID());
      await pending;
      for (let count = 0; count < 100 && ["queued", "running"].includes(manager.show(runningId).state); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(manager.show(runningId).state).toBe("succeeded");
      expect(manager.show(queuedId).state).toBe("cancelled");
      release();
      await expect(cancellation).rejects.toThrow("injected persistence failure");
      for (let count = 0; count < 100 && ["queued", "running"].includes(manager.show(queuedId).state); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(manager.show(queuedId).state).toBe("succeeded");
    } finally {
      await manager.close();
      await filesystem.close();
    }
  });

  test("three concurrent cancellations await each replacement persistence generation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-jobs-cancel-queue-config-"));
    const root = await mkdtemp(join(tmpdir(), "grokbox-jobs-cancel-queue-root-"));
    const executable = await nodeExecutable();
    const policy: DaemonProcessConfig = {
      cwdRoots: ["workspace"], defaultCwdRoot: "workspace",
      executables: [{ name: "node", path: executable }], environment: [],
      maxConcurrent: 1, maxQueued: 2, maxRuntimeMs: 10_000, maxOutputBytes: 1024,
    };
    const filesystem = await GovernedFilesystem.create([{ name: "workspace", path: root, operations: ["exec"] }], Date.now);
    const manager = await JobManager.create(configDir, await ProcessAuthority.create(policy), filesystem, Date.now);
    const runningId = randomUUID();
    const queuedId = randomUUID();
    const request = (jobId: string, script: string) => ({
      jobId, cwd: "workspace:/", argv: ["node", "-e", script], environment: {},
      runTimeoutMs: 10_000, output: "discard" as const, shell: false,
    });
    try {
      await manager.submit(request(runningId, "setTimeout(()=>{},1000)"));
      await manager.submit(request(queuedId, "process.exit(0)"));
      const internal = manager as unknown as { persist(job: { jobId: string; state: string }): Promise<void> };
      const persist = internal.persist.bind(manager);
      const gates = Array.from({ length: 2 }, () => {
        let markEntered!: () => void;
        let release!: () => void;
        return {
          entered: new Promise<void>((resolve) => { markEntered = resolve; }),
          blocked: new Promise<void>((resolve) => { release = resolve; }),
          markEntered: () => markEntered(),
          release: () => release(),
        };
      });
      let attempt = 0;
      internal.persist = async (job) => {
        if (job.jobId === queuedId && job.state === "cancelled" && attempt < gates.length) {
          const gate = gates[attempt++]!;
          gate.markEntered();
          await gate.blocked;
          throw new Error(`injected persistence failure ${attempt}`);
        }
        await persist(job);
      };
      const first = manager.cancel(queuedId, randomUUID()).then(() => undefined, (error: Error) => error);
      await gates[0]!.entered;
      let secondSettled = false;
      let thirdSettled = false;
      const second = manager.cancel(queuedId, randomUUID()).then(
        () => undefined,
        (error: Error) => error,
      ).finally(() => { secondSettled = true; });
      const third = manager.cancel(queuedId, randomUUID()).finally(() => { thirdSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondSettled).toBe(false);
      expect(thirdSettled).toBe(false);
      gates[0]!.release();
      expect((await first)?.message).toContain("failure 1");
      await gates[1]!.entered;
      expect(thirdSettled).toBe(false);
      gates[1]!.release();
      expect((await second)?.message).toContain("failure 2");
      expect((await third).state).toBe("cancelled");
      for (let count = 0; count < 100 && ["queued", "running"].includes(manager.show(runningId).state); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await manager.close();
      await filesystem.close();
    }
  });

  test("queueing, cancellation, timeout, truncation, and shell refusal stay authoritative", async () => {
    const f = await fixture(1024);
    const shell = await f.run(["exec", "run", "--shell", "--", "echo forbidden"]);
    expect(shell.code).not.toBe(0);
    expect((parseJson(shell.stderr) as { error: { code: string } }).error.code).toBe("capability_unavailable");

    const noisy = await f.run(["exec", "run", "--detach", "--", "node", "-e", "process.stdout.write('x'.repeat(100000)); setTimeout(()=>{},10000)"]);
    expect(noisy.code, noisy.stderr).toBe(0);
    const noisyJob = data<{ jobId: string }>(noisy.stdout);
    const queued = await f.run(["exec", "run", "--detach", "--run-timeout-ms", "200", "--", "node", "-e", "setTimeout(()=>{},10000)"]);
    const queuedJob = data<{ jobId: string; state: string }>(queued.stdout);
    expect(queuedJob.state).toBe("queued");
    let truncated = false;
    for (let count = 0; count < 100; count += 1) {
      const current = data<{ logs: { truncated: boolean } }>((await f.run(["jobs", "show", noisyJob.jobId])).stdout);
      if (current.logs.truncated) { truncated = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(truncated).toBe(true);
    const cancelled = await f.run(["jobs", "cancel", noisyJob.jobId]);
    expect(cancelled.code).toBe(0);
    const firstCancel = data<{ cancelOperationId: string }>(cancelled.stdout);
    const repeatedCancel = await f.run(["jobs", "cancel", noisyJob.jobId]);
    expect(repeatedCancel.code).toBe(0);
    expect(data<{ cancelOperationId: string }>(repeatedCancel.stdout).cancelOperationId).toBe(firstCancel.cancelOperationId);
    expect(data<{ state: string }>((await f.run(["jobs", "show", queuedJob.jobId])).stdout).state).toBe("queued");
    expect((await terminal(f.run, noisyJob.jobId)).state).toBe("cancelled");
    const timed = await terminal(f.run, queuedJob.jobId) as { state: string; reason: string };
    expect(timed).toMatchObject({ state: "failed", reason: "timeout" });
  }, 15_000);

  test("graceful shutdown terminates the process group and persists interrupted", async () => {
    const f = await fixture();
    const executable = f.processConfig.executables[0]!.path;
    const script = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(${JSON.stringify(executable)},['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('grandchild.pid',String(c.pid));setInterval(()=>{},1000)`;
    const submitted = await f.run(["exec", "run", "--detach", "--", "node", "-e", script]);
    const created = data<{ jobId: string }>(submitted.stdout);
    let grandchildPid = 0;
    for (let count = 0; count < 100; count += 1) {
      try { grandchildPid = Number(await readFile(join(f.root, "grandchild.pid"), "utf8")); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(grandchildPid).toBeGreaterThan(0);
    await host!.close(); host = undefined;
    host = await startDaemonHost(
      { ...createProductionDeps(), configDir: f.configDir, discoveryPath: f.discoveryPath }, f.socket, undefined,
      [{ name: "workspace", path: f.root, operations: ["exec"] }], f.processConfig,
    );
    expect(data<{ state: string }>((await f.run(["jobs", "show", created.jobId])).stdout).state).toBe("interrupted");
    let alive = true;
    for (let count = 0; count < 100; count += 1) {
      try { process.kill(grandchildPid, 0); } catch { alive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive).toBe(false);
  }, 15_000);

  test("a prior-generation nonterminal record restarts as unknown", async () => {
    const f = await fixture();
    await host!.close(); host = undefined;
    const jobId = "11111111-1111-4111-8111-111111111111";
    const corruptId = "22222222-2222-4222-8222-222222222222";
    const dir = join(f.configDir, "jobs", jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "state.json"), JSON.stringify({
      jobId, state: "running", createdAt: Date.now(), cwd: "workspace:/",
      command: { executable: "node", argumentCount: 0, shell: false }, output: "capture", runTimeoutMs: 1000,
      logs: { bytes: 0, nextOffset: 0, truncated: false }, fingerprint: "a".repeat(64), daemonGeneration: "old",
    }), { mode: 0o600 });
    const corruptDir = join(f.configDir, "jobs", corruptId);
    await mkdir(corruptDir, { recursive: true, mode: 0o700 });
    await writeFile(join(corruptDir, "state.json"), "{not-json", { mode: 0o600 });
    host = await startDaemonHost(
      { ...createProductionDeps(), configDir: f.configDir, discoveryPath: f.discoveryPath }, f.socket, undefined,
      [{ name: "workspace", path: f.root, operations: ["exec"] }], f.processConfig,
    );
    const shown = await f.run(["jobs", "show", jobId]);
    expect(shown.code).toBe(0);
    expect(data(shown.stdout)).toMatchObject({ state: "unknown", reason: "daemon_restart" });
    const recovered = await f.run(["events", "--once", "--sources", "job"]);
    expect(recovered.code, recovered.stderr).toBe(0);
    const recoveredEvent = parseJson(recovered.stdout) as {
      event: { source: string; payload: { jobId: string; state: string; reason: string } };
    };
    expect(recoveredEvent.event).toMatchObject({
      source: "job",
      payload: { jobId, state: "unknown", reason: "daemon_restart" },
    });
    const corrupt = await f.run(["jobs", "show", corruptId]);
    expect(corrupt.code).toBe(0);
    expect(data(corrupt.stdout)).toMatchObject({ state: "unknown", reason: "corrupt_state" });
  });
});

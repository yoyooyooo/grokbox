import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { publishConfigFile, publishLayoutAliases } from "../packages/box-runtime/src/runtime.ts";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { defaultConfig, validateConfig } from "../packages/runtime-kernel/src/config.ts";
import { openMonitorStore } from "../packages/box-runtime/src/internal/io/monitor-store.node.ts";
import { appendHostJournal } from "../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GENERATION = "b".repeat(64), TOKEN = "owned-monitor-test-token";
const INSTALLATION = "11111111-1111-4111-8111-111111111111", MANAGEMENT_TOKEN = "synthetic-installed-monitor-management-token";
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, predicate: (v: T) => boolean, budget = 8000) {
  const deadline = performance.now() + budget;
  let last: T | undefined;
  do { last = await read(); if (predicate(last)) return last; await delay(20); } while (performance.now() < deadline);
  throw Error(`owned_monitor_packed_deadline: ${JSON.stringify(last)}`);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "monitor-installed-node-")), root = join(directory, "durable"), run = join(directory, "host-run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const discovery = join(directory, "gateway.json"), startedAtMs = Date.now() - 1000;
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1700000000000, isBusy: false });
    calls.push(path);
    if (path === "/api/listAgents") return Response.json([]);
    if (path === "/api/getHostStatus") {
      const body = await request.json() as { grokboxOwnershipAgentIds: string[] };
      const ids = body.grokboxOwnershipAgentIds;
      return Response.json({ grokboxOwnership: { ...ownedOwnershipSnapshot(ids),
        runObservation: { schemaVersion: 1, source: "native_run_observer", hostGenerationId: GENERATION,
          observedAtMs: Date.now(), startedAtMs, targetIds: ids, coverage: "observed_window", droppedTasks: 0, taskLimit: 256, tasks: [] } } });
    }
    return new Response("unexpected native operation", { status: 404 });
  } });
  await writeFile(discovery, JSON.stringify({ scheme: "http", host: "127.0.0.1", port: server.port, pid: 4242, startedAt: 1700000000000, token: TOKEN }), { mode: 0o600 });
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); if (!address || typeof address === "string") throw Error("fixture_port_missing");
  const port = address.port; await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const document = validateConfig({ ...defaultConfig(),
    client: { currentProfile: "default", profiles: { default: { transport: "local", gatewayDiscovery: discovery,
      serverUrl: `http://127.0.0.1:${port}`, installationId: INSTALLATION, daemonTokenRef: "env:TEST_MONITOR_MANAGEMENT_TOKEN" } } },
    daemon: { network: { host: "127.0.0.1", port } }, ops: { observation: { enabled: false }, notifications: { mode: "off" } } });
  await publishConfigFile(join(root, "config.json"), document);
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: INSTALLATION, role: "box", root,
    daemon: { tokenSha256: createHash("sha256").update(MANAGEMENT_TOKEN).digest("hex") } });
  await publishLayoutAliases(root, root, INSTALLATION);
  const entry = ensurePackedCli();
  // Deliberately no GROKBOX_RUN_ROOT. The installed canonical intent must own it.
  const env = { PATH: process.env.PATH, HOME: directory, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root,
    TEST_MONITOR_MANAGEMENT_TOKEN: MANAGEMENT_TOKEN, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" };
  const execute = async (args: string[]) => {
    const child = spawn("node", [entry, ...args, ...(args[0] === "runtime" ? ["--json"] : [])], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(stdout + stderr).not.toContain(TOKEN); expect(stdout + stderr).not.toContain(MANAGEMENT_TOKEN);
    return { code, stdout, stderr, data: stdout ? JSON.parse(stdout).data : undefined };
  };
  const launch = () => {
    const child = spawn("node", [entry, "system", "service", "run", "server", "--root", root, "--native-discovery", discovery, "--port", String(port)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => { output = (output + chunk).slice(-32768); }); child.stderr!.on("data", chunk => { output = (output + chunk).slice(-32768); });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    return { child, exit, output: () => output };
  };
  const append = async (logRoot: string, step: string) => {
    await appendHostJournal(logRoot, { name: "host_stream_rejected", schemaVersion: 2, at: new Date().toISOString(),
      hostGenerationId: GENERATION, mode: "route", agentId: AGENT, turnId: `turn-${step}`, stepId: step,
      stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }, { configurationRoot: root });
  };
  return { directory, root, run, execute, launch, append, calls,
    close: async () => { server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}
async function stop(owner: { child: ChildProcess; exit: Promise<number | null> }, signal: NodeJS.Signals = "SIGTERM") {
  if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill(signal);
  const timer = setTimeout(() => owner.child.kill("SIGKILL"), 8000);
  try { await owner.exit; } finally { clearTimeout(timer); }
}

test("installed Node management collector survives command exit and SIGKILL replacement with persistent exact cursors and no notice when off", async () => {
  const f = await fixture(); let owner: ReturnType<typeof f.launch> | undefined;
  try {
    const before = await readdir(f.root);
    const absent = await f.execute(["system", "service", "get", "server"]);
    expect(absent.code).not.toBe(0); expect(await readdir(f.root)).toEqual(before);
    const preview = await f.execute(["runtime", "monitor", "install", "--run-root", f.run, "--agents", AGENT]);
    expect(preview.code, preview.stderr).toBe(0); expect(preview.data.state).toBe("preview");
    expect(await readdir(f.root)).toEqual(before);
    const installed = await f.execute(["runtime", "monitor", "install", "--run-root", f.run, "--agents", AGENT,
      "--expect-revision", preview.data.expectedRevision, "--operation-id", randomUUID(), "--confirm"]);
    expect(installed.code, installed.stderr).toBe(0); expect(installed.data.serviceStarted).toBe(false);
    await f.append(f.run, "host-first"); await f.append(f.root, "control-first");
    owner = f.launch();
    await until(() => f.execute(["system", "service", "get", "server"]), v => v.code === 0 && v.data.observation.state === "running");
    const store = openMonitorStore(f.root);
    const initial = await until(() => store.incidents(), rows => rows.filter(r => r.rule === "execution_failure").length === 2);
    const firstEpoch = (await store.snapshot()).collectorEpoch;
    expect(await store.notificationWork()).toEqual([]);
    // This new writer event occurs after both install/status commands exited.
    await f.append(f.run, "host-after-caller-exit");
    await until(() => store.incidents(), rows => rows.filter(r => r.rule === "execution_failure").length === 3);
    await stop(owner, "SIGKILL"); owner = undefined;
    owner = f.launch();
    const reopened = await until(() => f.execute(["system", "service", "get", "server"]), v => v.code === 0 && v.data.observation.state === "running");
    expect(reopened.data.observation.collectorEpoch).not.toBe(firstEpoch);
    const records = await store.incidents();
    expect(records.filter(r => r.rule === "execution_failure")).toHaveLength(3);
    expect(records.map(r => r.id)).toEqual(expect.arrayContaining(initial.map(r => r.id)));
    expect(await store.notificationWork()).toEqual([]);
    await stop(owner); owner = undefined;
    expect((await store.snapshot()).collectorRecordedRunning).toBe(false);
    const bytes = await readFile(store.path); await delay(100); expect(await readFile(store.path)).toEqual(bytes);
    expect(f.calls.every(path => ["/api/getHostStatus", "/api/listAgents"].includes(path))).toBe(true);
  } finally { if (owner) await stop(owner); await f.close(); }
}, 30000);

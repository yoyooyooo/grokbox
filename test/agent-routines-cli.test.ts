import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli } from "./helpers.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { startDaemonHost, type DaemonHost } from "../packages/cli/src/daemon/host.ts";
import { LocalDaemonClient } from "../packages/cli/src/daemon/client.ts";
import { boundedGatewayBody } from "../packages/cli/src/gateway-automation.ts";
import { spawn } from "node:child_process";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { defaultConfig, validateConfig } from "../packages/runtime-kernel/src/config.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TOKEN = "fixture-routine-auth";
export async function routineFixture(mode: "local" | "daemon" = "local") {
  const directory = await mkdtemp(join(tmpdir(), "routine-cli-")), discoveryPath = join(directory, "discovery.json"), daemonSocket = join(directory, "daemon.sock");
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let rows = [{ id: "notify", name: "Notify", prompt: "PRIVATE_PROMPT", trigger: { type: "webhook" }, isEnabled: false,
    createdAt: 100, lastRunAt: null, filePath: "/PRIVATE/STORE", webhookKey: "PRIVATE_KEY" }];
  let loseMutation = false, badRead = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "denied" }, { status: 401 });
    if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1700000000000, isBusy: false });
    const body = await request.json() as Record<string, unknown>; calls.push({ path, body });
    if (path === "/api/listAgents") return Response.json([]);
    if (path === "/api/getAgentAutomations") return badRead ? new Response("PRIVATE_NATIVE_FAILURE") : Response.json(rows);
    if (body.id !== AGENT || body.automationId !== "notify") return new Response("bad identity", { status: 400 });
    if (path === "/api/setAgentAutomationEnabled") rows = rows.map(row => ({ ...row, isEnabled: body.isEnabled as boolean }));
    else if (path === "/api/deleteAgentAutomation") rows = [];
    else return new Response("unexpected method", { status: 404 });
    return loseMutation ? new Response("PRIVATE_LOST_ACK", { status: 500 }) : Response.json(rows);
  } });
  await writeFile(discoveryPath, JSON.stringify({ scheme: "http", host: "127.0.0.1", port: server.port, pid: 4242, startedAt: 1700000000000, token: TOKEN }), { mode: 0o600 });
  await mkdir(join(directory, "config"), { mode: 0o700 });
  const deps = { ...createProductionDeps(), configDir: join(directory, "config"), boxRuntimeRoot: join(directory, "durable"), discoveryPath, daemonSocket,
    env: {}, agentDataRoot: join(directory, "missing-native-state"), transport: "local" as const };
  const { stdout: _stdout, stderr: _stderr, ...commandDeps } = deps;
  let daemon: DaemonHost | undefined;
  if (mode === "daemon") daemon = await startDaemonHost(deps, daemonSocket);
  return { directory, deps, calls, daemonSocket,
    run: (args: string[]) => captureCli(["agents", "routines", ...args, "--json"], { ...commandDeps, transport: mode }),
    rows: () => rows, loseMutation: () => { loseMutation = true; }, breakRead: () => { badRead = true; },
    close: async () => { await daemon?.close(); server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}
const result = (r: Awaited<ReturnType<Awaited<ReturnType<typeof routineFixture>>["run"]>>) => { expect(r.code, r.stderr).toBe(0); return JSON.parse(r.stdout).data; };

for (const mode of ["local", "daemon"] as const) test(`${mode}: real CLI reads then changes one exact Routine with no credential or invoke calls`, async () => {
  const f = await routineFixture(mode);
  try {
    const initial = result(await f.run(["list", AGENT]));
    expect(initial.routines).toHaveLength(1); expect(initial.coverage.complete).toBe(false);
    for (const secret of [TOKEN, "PRIVATE_PROMPT", "PRIVATE_KEY", "PRIVATE/STORE"]) expect(JSON.stringify(initial)).not.toContain(secret);
    const shown = result(await f.run(["show", AGENT, "notify"]));
    const enabled = result(await f.run(["enable", AGENT, "notify", "--expect-revision", shown.routines[0].revision, "--confirm"]));
    expect(enabled.state).toBe("requested_state_observed"); expect(f.rows()[0]!.isEnabled).toBe(true);
    const disabled = result(await f.run(["disable", AGENT, "notify", "--expect-revision", enabled.afterRevision, "--confirm"]));
    expect(disabled.state).toBe("requested_state_observed");
    const removed = result(await f.run(["delete", AGENT, "notify", "--expect-revision", disabled.afterRevision, "--confirm"]));
    expect(removed).toMatchObject({ state: "absent_in_returned_window", inFlightRunsCancelled: false, nativeCompareAndSwap: false, webhookInvoked: false });
    expect(f.calls.filter(c => c.path === "/api/setAgentAutomationEnabled").map(c => c.body)).toEqual([
      { id: AGENT, automationId: "notify", isEnabled: true }, { id: AGENT, automationId: "notify", isEnabled: false }]);
    expect(f.calls.every(c => ["/api/getAgentAutomations", "/api/setAgentAutomationEnabled", "/api/deleteAgentAutomation", "/api/listAgents"].includes(c.path))).toBe(true);
  } finally { await f.close(); }
}, 10000);

for (const mode of ["local", "daemon"] as const) test(`${mode}: a lost native acknowledgement remains unknown and never repeats the write`, async () => {
  const f = await routineFixture(mode);
  try {
    const original = result(await f.run(["show", AGENT, "notify"])); f.loseMutation();
    const response = await f.run(["enable", AGENT, "notify", "--expect-revision", original.routines[0].revision, "--operation-id", "lost-once", "--confirm"]);
    expect(response.code).not.toBe(0); expect(response.stderr).toContain("operation_outcome_unknown");
    expect(response.stderr).not.toContain("PRIVATE_LOST_ACK");
    expect(f.calls.filter(c => c.path === "/api/setAgentAutomationEnabled")).toHaveLength(1);
    expect(f.rows()[0]!.isEnabled).toBe(true);
  } finally { await f.close(); }
});

test("missing confirmation and stale revision never reach native writes", async () => {
  const f = await routineFixture();
  try {
    expect((await f.run(["enable", AGENT, "notify", "--expect-revision", "a".repeat(64)])).code).not.toBe(0);
    expect((await f.run(["enable", AGENT, "notify", "--expect-revision", "a".repeat(64), "--confirm"])).code).not.toBe(0);
    expect((await f.run(["show", "not-an-id", "notify"])).code).not.toBe(0);
    expect(f.calls.filter(c => c.path !== "/api/getAgentAutomations")).toHaveLength(0);
  } finally { await f.close(); }
});

test("direct daemon calls cannot bypass confirmation/revision validation or add arbitrary parameters", async () => {
  const f = await routineFixture("daemon");
  try {
    const client = new LocalDaemonClient(f.daemonSocket, 1000);
    expect((await client.handshake()).capabilities).toContain("grok.routines.read");
    await expect(client.call("agentRoutines", { command: { action: "delete", agentId: AGENT, routineId: "notify" } })).rejects.toBeDefined();
    await expect(client.call("agentRoutines", { command: { action: "list", agentId: AGENT }, url: "https://private.invalid" })).rejects.toBeDefined();
    expect(f.calls.filter(c => c.path.includes("Automation"))).toHaveLength(0);
  } finally { await f.close(); }
});

test("invalid native output is not copied into error messages or treated as an empty list", async () => {
  const f = await routineFixture();
  try {
    f.breakRead(); const response = await f.run(["list", AGENT]);
    expect(response.code).not.toBe(0); expect(response.stdout).toBe(""); expect(response.stderr).not.toContain("PRIVATE_NATIVE_FAILURE");
  } finally { await f.close(); }
});

test("actual packed Node CLI resolves the configured native target and round-trips a precise Routine mutation", async () => {
  const f = await routineFixture();
  try {
    const document = validateConfig({ ...defaultConfig(), client: { currentProfile: "default", profiles: { default: {
      transport: "local", gatewayDiscovery: f.deps.discoveryPath,
    } } } });
    await writeFile(join(f.deps.configDir, "config.json"), JSON.stringify(document), { mode: 0o600 });
    const entry = ensurePackedCli();
    const run = async (args: string[]) => {
      const child = spawn("node", [entry, "agents", "routines", ...args, "--json"], {
        cwd: f.directory, env: { PATH: process.env.PATH, HOME: f.directory,
          GROKBOX_CONFIG_DIR: f.deps.configDir, GROKBOX_BOX_RUNTIME_ROOT: f.deps.boxRuntimeRoot,
          GROKBOX_RUN_ROOT: join(f.directory, "isolated-run") }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      expect(code, stderr).toBe(0);
      expect(stdout + stderr).not.toContain("PRIVATE_PROMPT"); expect(stdout + stderr).not.toContain(TOKEN);
      return JSON.parse(stdout).data;
    };
    const before = await run(["show", AGENT, "notify"]);
    const after = await run(["enable", AGENT, "notify", "--expect-revision", before.routines[0].revision, "--confirm", "--operation-id", "packed-once"]);
    expect(after).toMatchObject({ state: "requested_state_observed", operationId: "packed-once", webhookInvoked: false });
    const shown = await run(["list", AGENT]); expect(shown.routines[0].enabled).toBe(true);
    expect(f.calls.filter(c => c.path === "/api/setAgentAutomationEnabled")).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);

test("stream body is bounded before JSON parsing, including missing length and invalid UTF-8", async () => {
  let cancelled = 0, sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { sent++; controller.enqueue(new Uint8Array(2048)); }, cancel() { cancelled++; } });
  await expect(boundedGatewayBody(new Response(body), 4096)).rejects.toBeDefined();
  expect(cancelled).toBe(1); expect(sent).toBeLessThanOrEqual(5);
  await expect(boundedGatewayBody(new Response(new Uint8Array([0xff])), 32)).rejects.toBeDefined();
  await expect(boundedGatewayBody(new Response("small", { headers: { "content-length": "5000000" } }), 32)).rejects.toBeDefined();
});

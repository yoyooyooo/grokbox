import { expect, test } from "bun:test";
import { readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { captureCli } from "./helpers.ts";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { startDaemonHost, type DaemonHost } from "../packages/cli/src/daemon/host.ts";
import { LocalDaemonClient } from "../packages/cli/src/daemon/client.ts";
import { automaticFixture, MODEL, tick } from "../packages/box-runtime/test/fixtures/automatic-notice.ts";

async function packed(root: string, args: string[]) {
  const child = spawn("node", [ensurePackedCli(), ...args, "--json"], { cwd: root,
    env: { PATH: process.env.PATH, HOME: root, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  return { code, stdout, stderr };
}
const args = (workId: string) => ["ops", "targets", "activate", "default", "--from-work", workId, "--expect-binding-revision", "1",
  "--expect-model-revision", MODEL, "--operation-id", "activate", "--confirm-receiver", "--confirm"];

test("CLI never derives receiver attestation from HTTP success, and validates required flags before side effects", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(), capsule = await readFile(join(f.root, "state/ops-pairing/bindings.json")); let network = 0;
    const deps = { configDir: f.root, boxRuntimeRoot: f.root, env: {}, fetch: (async () => { network++; throw Error("unexpected-network"); }) as unknown as typeof fetch };
    const missing = args(seed.workId).filter(v => v !== "--confirm-receiver");
    const result = await captureCli([...missing, "--json"], deps);
    expect(result.code).not.toBe(0); expect(network).toBe(0); expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(capsule);
    const child = await packed(f.root, missing); expect(child.code).not.toBe(0); expect(child.stdout).toBe("");
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(capsule);
  } finally { await f.close(); }
}, 15000);

test("actual Node replays the durable authorization operation without renewing it or reading native state", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const path = join(f.root, "state/ops-pairing/bindings.json"), before = await readFile(path);
    const replay = await packed(f.root, args(seed.workId));
    expect(replay.code, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ data: { state: "authorized", duplicate: true, notificationSent: false, nativeTurnObserved: false } });
    expect(await readFile(path)).toEqual(before); expect(f.requests).toHaveLength(1);
    expect(replay.stdout + replay.stderr).not.toContain("PRIVATE_TEST_KEY");
    const status = await packed(f.root, ["ops", "targets", "show", "default"]);
    expect(status.code, status.stderr).toBe(0); expect(JSON.parse(status.stdout).data.bindings[0].automaticAuthorization.state).toBe("authorized");
  } finally { await f.close(); }
}, 15000);

test("an existing daemon owns the idle worker; original handshake shape stays compatible and reads start no services", async () => {
  const f = await automaticFixture(); let daemon: DaemonHost | undefined;
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const discoveryPath = join(f.root, "gateway.json"), socket = join(f.root, "run/daemon.sock");
    await writeFile(discoveryPath, JSON.stringify({ scheme: "http", host: "127.0.0.1", port: 32001, pid: 4242, startedAt: 1700000000000, token: "PRIVATE_GATEWAY_TEST_KEY" }), { mode: 0o600 });
    let nativeRequests = 0;
    const deps = { ...createProductionDeps(), configDir: f.root, boxRuntimeRoot: f.root, env: {}, daemonSocket: socket, discoveryPath,
      fetch: (async () => { nativeRequests++; throw Error("no-fresh-work-needs-network"); }) as unknown as typeof fetch };
    const before = await readFile(f.store.path);
    daemon = await startDaemonHost(deps, socket);
    const client = new LocalDaemonClient(socket, 2000);
    expect((await client.handshake()).capabilities).toContain("grok.notifications.worker.read");
    for (let n = 0; n < 50; n++) {
      const current = await client.call("getOpsNotificationWorker", {});
      if ((current.result as { cycles: number }).cycles > 0) break;
      await tick(5);
    }
    const observed = await packed(f.root, ["ops", "notifications", "worker"]);
    expect(observed.code, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout)).toMatchObject({ data: { owner: "daemon-lifetime", state: "waiting",
      lastCycle: { state: "idle", reason: "no_fresh_work" }, automaticDiagnosis: false, automaticIssue: false, serviceInstallation: "not_proven" } });
    expect(nativeRequests).toBe(0); expect(f.requests).toHaveLength(1); expect(await readFile(f.store.path)).toEqual(before);
    await daemon.close(); daemon = undefined;
    const names = await readdir(join(f.root, "run")); expect(names).not.toContain("daemon.sock");
  } finally { await daemon?.close(); await f.close(); }
}, 15000);

test("worker status refuses an absent daemon instead of silently starting one or initializing storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-status-"));
  try {
    const result = await captureCli(["ops", "notifications", "worker", "--json"], { boxRuntimeRoot: root, configDir: root, env: {}, daemonSocket: join(root, "absent.sock") });
    expect(result.code).not.toBe(0); expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("retired activation syntax cannot bypass the management consent entry, with or without its old attestation flag", async () => {
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

test("actual Node refuses retired activation, disable and unbind writers while preserving prior consent", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const path = join(f.root, "state/ops-pairing/bindings.json"), before = await readFile(path);
    for (const command of [args(seed.workId), ["ops", "targets", "disable", "default", "--expect-binding-revision", "2", "--confirm"],
      ["ops", "targets", "unbind", "default", "--expect-binding-revision", "2", "--confirm"]]) {
      const replay = await packed(f.root, command);
      expect(replay.code).not.toBe(0); expect(replay.stdout).toBe("");
      expect(await readFile(path)).toEqual(before); expect(f.requests).toHaveLength(1);
      expect(replay.stdout + replay.stderr).not.toContain("PRIVATE_TEST_KEY");
    }
    const status = await packed(f.root, ["ops", "targets", "show", "default"]);
    expect(status.code).not.toBe(0); expect(status.stdout).toBe("");
    expect((await f.owner.record("default"))!.automatic).toBeDefined();
  } finally { await f.close(); }
}, 15000);

test("the legacy daemon no longer advertises or starts a notification worker", async () => {
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
    expect((await client.handshake()).capabilities).not.toContain("grok.notifications.worker.read");
    await tick(40);
    const observed = await packed(f.root, ["ops", "notifications", "worker"]);
    expect(observed.code).not.toBe(0);
    expect(nativeRequests).toBe(0); expect(f.requests).toHaveLength(1); expect(await readFile(f.store.path)).toEqual(before);
    await daemon.close(); daemon = undefined;
    const names = await readdir(join(f.root, "run")); expect(names).not.toContain("daemon.sock");
  } finally { await daemon?.close(); await f.close(); }
}, 15000);

test("management notification status refuses an absent installation instead of starting a service", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-status-"));
  try {
    const result = await captureCli(["notification", "status"], { boxRuntimeRoot: root, configDir: root, env: {}, daemonSocket: join(root, "absent.sock") });
    expect(result.code).not.toBe(0); expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { captureCli } from "./helpers.ts";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { defaultConfig, validateConfig } from "../packages/runtime-kernel/src/config.ts";
import { openMonitorStore } from "../packages/box-runtime/src/internal/io/monitor-store.node.ts";

const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", MODEL = "c".repeat(64);
const I = "11111111-1111-4111-8111-111111111111", DB = "22222222-2222-4222-8222-222222222222";
const command = (workId: string) => ["notification", "send", `notification:${I}:${DB}:${workId}`, "--receiver", `receiver:${I}:${DB}:${TARGET}`,
  "--request-id", randomUUID(), "--expect-revision", "1", "--expect-model-revision", MODEL];

test("send exposes no arbitrary URL/key/body channel and validates confirmation before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "notice-cli-")); let requests = 0;
  try {
    const before = await readdir(root);
    const base = command(randomUUID());
    for (const args of [base, [...base, "--confirm", "--url", "https://untrusted.invalid"], [...base, "--confirm", "--key", "PRIVATE"], [...base, "--confirm", "--body", "PRIVATE"]]) {
      const response = await captureCli(args, { boxRuntimeRoot: root, configDir: join(root, "config"), discoveryPath: "/dev/null", env: {},
        fetch: Object.assign(async () => { requests++; throw Error("unexpected_network"); }, { preconnect: () => { requests++; } }) });
      expect(response.code).not.toBe(0);
    }
    expect(requests).toBe(0); expect(await readdir(root)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source and packed Node send require the management installation and never fall back to local outbox or Gateway writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "notice-cli-node-")); let requests = 0;
  try {
    const config = validateConfig({ ...defaultConfig(), ops: { targets: { default: { agentId: TARGET, routineKey: "ops-notice" } } } });
    await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    const store = openMonitorStore(root), epoch = randomUUID(), now = Date.now();
    await store.initialize(); await store.begin(epoch, now, [SUBJECT]);
    await store.ingestEvidence({ epoch, sourceKey: "d".repeat(64), expectedCursor: null, nextCursor: "one", atMs: now,
      events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(now).toISOString(), mode: "route", hostGenerationId: "e".repeat(64),
        agentId: SUBJECT, stepId: "one", turnId: "one", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }] });
    const workId = String((await store.notificationWork())[0]!.id), before = await readFile(store.path);
    const args = [...command(workId), "--confirm"];
    const result = await captureCli(args, { boxRuntimeRoot: root, configDir: join(root, "config"), discoveryPath: "/dev/null", env: {},
      fetch: Object.assign(async () => { requests++; throw Error("unexpected_network"); }, { preconnect: () => { requests++; } }) });
    expect(result.code).not.toBe(0); expect(requests).toBe(0);
    const child = spawn("node", [ensurePackedCli(), ...args], { cwd: root,
      env: { PATH: process.env.PATH, HOME: root, GROKBOX_CONFIG_DIR: join(root, "config"), GROKBOX_BOX_RUNTIME_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit).not.toBe(0); expect(out + err).not.toContain("PRIVATE");
    expect(await readFile(store.path)).toEqual(before); expect(await store.notificationDelivery(workId)).toMatchObject({ attempt: null });
    expect(await readdir(join(root, "state")).catch(() => [])).not.toContain("ops-pairing");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

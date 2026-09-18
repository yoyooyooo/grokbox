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

test("send exposes no arbitrary URL/key/body channel and validates confirmation before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "notice-cli-")); let requests = 0;
  try {
    const before = await readdir(root);
    const base = ["ops", "notifications", "send", randomUUID(), "--expect-binding-revision", "1", "--expect-model-revision", MODEL, "--json"];
    for (const args of [base, [...base, "--confirm", "--url", "https://untrusted.invalid"], [...base, "--confirm", "--key", "PRIVATE"], [...base, "--confirm", "--body", "PRIVATE"]]) {
      const response = await captureCli(args, { boxRuntimeRoot: root, configDir: join(root, "config"), discoveryPath: "/dev/null", env: {},
        fetch: Object.assign(async () => { requests++; throw Error("unexpected_network"); }, { preconnect: () => { requests++; } }) });
      expect(response.code).not.toBe(0); expect(response.stdout).toBe("");
    }
    expect(requests).toBe(0); expect(await readdir(root)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source and packed Node send refuse unpaired work without creating an attempt, repairing configuration or making network requests", async () => {
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
    const args = ["ops", "notifications", "send", workId, "--expect-binding-revision", "1", "--expect-model-revision", MODEL, "--confirm", "--json"];
    const result = await captureCli(args, { boxRuntimeRoot: root, configDir: join(root, "config"), discoveryPath: "/dev/null", env: {},
      fetch: Object.assign(async () => { requests++; throw Error("unexpected_network"); }, { preconnect: () => { requests++; } }) });
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("capability_unavailable"); expect(requests).toBe(0);
    const child = spawn("node", [ensurePackedCli(), ...args], { cwd: root,
      env: { PATH: process.env.PATH, HOME: root, GROKBOX_CONFIG_DIR: join(root, "config"), GROKBOX_BOX_RUNTIME_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit).not.toBe(0); expect(out).toBe(""); expect(err).toContain("capability_unavailable");
    expect(await readFile(store.path)).toEqual(before); expect(await store.notificationDelivery(workId)).toMatchObject({ attempt: null });
    expect(await readdir(join(root, "state")).catch(() => [])).not.toContain("ops-pairing");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

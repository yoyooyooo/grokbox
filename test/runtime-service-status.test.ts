import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModeldProcess } from "@grokbox/box-runtime/runtime";
import { encodeModeldFrame, decodeModeldFrame } from "../packages/box-runtime/src/internal/wire/modeld-wire.ts";
import { captureCli } from "./helpers.ts";

async function status(root: string, run: string) {
  const result = await captureCli(["runtime", "status", "--json"], {
    configDir: join(root, "config"), boxRuntimeRoot: root, env: { GROKBOX_RUN_ROOT: run },
    transport: "local", discoveryPath: join(root, "no-gateway.json"), daemonSocket: join(root, "no-daemon.sock"),
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).data.facets.modeld;
}

for (const sameRoot of [true, false]) {
  test(`runtime status qualifies its requested root rather than any healthy socket: ${sameRoot ? "same" : "foreign"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-status-root-"));
    const root = join(dir, "owner"), requested = sameRoot ? root : join(dir, "foreign"), run = join(dir, "run");
    const owner = await startModeldProcess({ durableRoot: root, runRoot: run, env: {} });
    try {
      const observed = await status(requested, run);
      expect(observed.gap).toBeNull();
      expect(observed.value).toMatchObject({ ready: sameRoot, scope: sameRoot ? "matched" : "mismatch" });
      expect(observed.value.serviceEpoch).toBe(owner.ensure.kind === "owned" ? owner.ensure.generation : null);
      expect(observed.observedAt).toEqual(expect.any(String));
      expect(existsSync(join(run, "modeld.sock"))).toBe(true);
      expect(existsSync(join(requested, "state/desired.json"))).toBe(false);
    } finally { await owner.stop(); await rm(dir, { recursive: true, force: true }); }
  }, 5000);
}

test("runtime status does not label an older healthy but unqualified service ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-status-legacy-"));
  const server = createServer(socket => socket.on("data", chunk => {
    const decoded = decodeModeldFrame(Buffer.from(chunk));
    if (!decoded || "error" in decoded) return;
    const method = (decoded.value as { method?: unknown }).method;
    socket.end(encodeModeldFrame(method === "health"
      ? { ok: true, method: "health", version: 4, serverGeneration: "77777777-7777-4777-8777-777777777777" }
      : { ok: false, version: 4, error: { code: "unknown_method" } }));
  }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(dir, "modeld.sock"), resolve); });
  try {
    const observed = await status(join(dir, "durable"), dir);
    expect(observed.value).toMatchObject({ ready: null, scope: "unavailable", serviceEpoch: null });
    expect(observed.gap).toBe("unavailable");
    expect(existsSync(join(dir, "modeld.sock"))).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("an invalid run directory is unavailable, not a supposedly absent service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-status-invalid-parent-"));
  const run = join(dir, "not-a-directory");
  await writeFile(run, "owned-foreign-file", { flag: "wx" });
  try {
    const observed = await status(join(dir, "durable"), run);
    expect(observed).toMatchObject({ gap: "unavailable", value: { ready: null, scope: "unavailable", serviceEpoch: null } });
    expect(existsSync(run)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 5000);

test("runtime status reports absence without creating config or a replacement listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-status-empty-"));
  try {
    const observed = await status(join(dir, "durable"), join(dir, "run"));
    expect(observed.value).toMatchObject({ ready: false, scope: "not_observed", serviceEpoch: null });
    expect(existsSync(join(dir, "run"))).toBe(false);
    expect(existsSync(join(dir, "durable/state"))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 5000);

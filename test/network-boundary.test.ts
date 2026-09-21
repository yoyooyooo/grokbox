import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import { readDaemonConfig, writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { validateConfig, defaultConfig } from "@grokbox/runtime-kernel/config";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";

const root = join(import.meta.dir, ".."), temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), "grokbox-network-boundary-")); temps.push(dir); return dir; };

test("retired network control source, flags and helper exports are absent from production", async () => {
  expect(existsSync(join(root, "packages/cli/src/bootstrap.ts"))).toBe(false);
  const forbidden = /\b(?:bootstrapPeerDaemon|inspectTailnetPeer|ensureRecordedServeMapping|DaemonServeConfig|legacyTailnet|tailscale)\b/;
  for (const base of ["packages/cli/src", "packages/server/src", "packages/client/src", "packages/runtime-kernel/src"]) {
    for (const relative of await readdir(join(root, base), { recursive: true })) {
      if (!/\.(?:ts|mjs|cjs)$/.test(relative)) continue;
      const source = await readFile(join(root, base, relative), "utf8");
      expect(forbidden.test(source), `${base}/${relative}`).toBe(false);
    }
  }
  for (const path of ["init", "daemon ensure", "recover"]) {
    const leaf = LEAF_COMMANDS.find(v => v.path.join(" ") === path)!;
    expect(leaf).toBeDefined();
    for (const flag of ["--peer", "--bootstrap", "--legacy-tailnet", "--admit-home-read", "--yes"]) expect(JSON.stringify(leaf.options)).not.toContain(flag);
  }
});

test("old Serve preferences are rejected without silently normalizing or deleting saved configuration", async () => {
  const dir = await temporary();
  await writeDaemonConfig(dir, { version: 1 });
  const path = join(dir, "config.json"), original = JSON.parse(await readFile(path, "utf8"));
  const retired = { ...original, daemon: { ...original.daemon, serve: { httpsPort: 8443, dnsName: "old.invalid", proxyUrl: "http://127.0.0.1:37134" } } };
  const bytes = JSON.stringify(retired) + "\n";
  await writeFile(path, bytes, { mode: 0o600 });
  expect(() => validateConfig(retired)).toThrow();
  await expect(readDaemonConfig(dir)).rejects.toThrow();
  await expect(writeDaemonConfig(dir, { version: 1 })).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(validateConfig(defaultConfig())).toBeDefined();
});

test("failed local health observation cannot replace the current profile selection", async () => {
  const dir = await temporary(), gateway = await startMockGateway();
  try {
    const discovery = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const deps = { configDir: dir, discoveryPath: discovery, env: {}, skillsDir: join(root, "skills"), runCommand: async () => { throw Error("unexpected-command"); } };
    expect((await captureCli(["init", "existing", "--local"], deps)).code).toBe(0);
    const before = await readFile(join(dir, "config.json"), "utf8");
    const failed = await captureCli(["init", "replacement", "--local"], { ...deps, fetch: (async () => { throw Error("synthetic-health-failure"); }) as unknown as typeof fetch });
    expect(failed.code).not.toBe(0);
    expect(await readFile(join(dir, "config.json"), "utf8")).toBe(before);
  } finally { gateway.stop(); }
});

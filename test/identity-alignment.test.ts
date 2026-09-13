import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergedProfile } from "../packages/cli/src/commands/management.ts";
import { GatewayClient } from "../packages/cli/src/gateway.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps, type CliDeps } from "../packages/cli/src/deps.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";

for (const harness of [undefined, "box", "temporal", "unknown"]) {
  test(`ordinary profile update never writes a ${harness ?? "missing"} harness back`, () => {
    const result = mergedProfile({ id: "agent", name: "owned", description: "owned", harness }, { title: "new title" });
    expect(result).toEqual({ name: "owned", description: "owned", title: "new title" });
    expect(result).not.toHaveProperty("harness");
  });
}

test("explicit harness edits fail before even reading Gateway roster", async () => {
  let requests = 0;
  const deny = Object.assign(async () => { requests++; throw Error("network_forbidden"); }, { preconnect: async () => undefined }) as typeof fetch;
  for (const harness of ["box", "temporal"]) {
    const result = await captureCli(["agents", "update", "owned", "--harness", harness], { fetch: deny });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  }
  expect(requests).toBe(0);
});

for (const daemonMode of [false, true]) {
  test(`${daemonMode ? "daemon" : "direct"} typed update refuses harness and omits it on ordinary writes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-identity-write-"));
    const gateway = await startMockGateway({ agents: [{ id: "agent", name: "owned", description: "owned", harness: "temporal", isGroup: false }] });
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const socket = join(dir, "daemon.sock");
    const deps: Partial<CliDeps> = { configDir: dir, discoveryPath, env: {}, transport: daemonMode ? "daemon" : "local", daemonSocket: socket };
    await writeProfileFile(dir, "default", { version: 1, transport: daemonMode ? "daemon" : "local", gateway_discovery: discoveryPath, daemon_socket: socket });
    const daemon = daemonMode ? await startDaemonHost({ ...createProductionDeps(), ...deps, transport: "local" }, socket) : undefined;
    try {
      const result = await captureCli(["agents", "update", "agent", "--title", "new"], deps);
      expect(result.code).toBe(0);
      expect(gateway.requests.filter(r => r.pathname === "/api/updateAgent").map(r => r.body)).toEqual([
        { id: "agent", profile: { name: "owned", description: "owned", title: "new" } },
      ]);
      const count = gateway.requests.length;
      const client = new GatewayClient({ ...createProductionDeps(), ...deps });
      await expect(client.updateAgent({ id: "agent", profile: { harness: "box" } }, 1000)).rejects.toMatchObject({ code: "invalid_usage" });
      expect(gateway.requests).toHaveLength(count);
    } finally { await daemon?.close(); gateway.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

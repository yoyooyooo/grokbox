import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps, type CliDeps } from "../packages/cli/src/deps.ts";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";

// The former happy-path Gateway tests are not compatibility authority. Their
// business assertions now live in packages/server/test/products.node.ts: actual
// Node HTTP + original SQLite + packed CLI prove full profile preservation,
// explicit creation harness, permissions, whole membership validation, lost
// acknowledgements, identity retention and a single deletion cleanup owner.
// This suite proves the old parser/RPC writers cannot still reach those effects.
const retired = [
  ["agents", "create", "--name", "new"], ["agents", "update", "alpha", "--title", "changed"],
  ["agents", "delete", "alpha", "--yes"], ["groups", "create", "--name", "new", "--member", "alpha"],
  ["groups", "update", "group", "--title", "changed"], ["groups", "delete", "group", "--yes"],
  ["groups", "members", "add", "group", "alpha"], ["groups", "members", "remove", "group", "alpha"],
  ["groups", "members", "set", "group", "--member", "alpha"],
];

describe("native product cutover", () => {
  for (const args of retired) test(`retired CLI cannot choose another writer: ${args.join(" ")}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-product-parser-")); let requests = 0, prompts = 0;
    try {
      const result = await captureCli(args, { configDir: root, boxRuntimeRoot: root, env: {}, transport: "local", discoveryPath: join(root, "absent-gateway.json"),
        fetch: Object.assign(async () => { requests++; throw Error("unexpected-network"); }, { preconnect: () => { throw Error("unexpected-preconnect"); } }), confirm: async () => { prompts++; return true; } });
      expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("invalid_usage");
      expect(requests).toBe(0); expect(prompts).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("formal CLI requires an explicit review/submit phase before connection discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-product-phase-")); let requests = 0;
    const file = join(root, "intent.json"); await writeFile(file, JSON.stringify({ requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", profile: { name: "synthetic" }, harness: "box", deferStart: true }));
    try {
      for (const flags of [[], ["--confirm"], ["--preview", "--confirm"], ["--preview", "--accept-non-atomic"], ["--confirm", "--scope-id", "e".repeat(64), "--expect-revision", "f".repeat(64)]]) {
        const result = await captureCli(["bot", "create", "--input", `@${file}`, ...flags], { configDir: root, boxRuntimeRoot: root, env: {},
          fetch: Object.assign(async () => { requests++; throw Error("unexpected-network"); }, { preconnect: () => { throw Error("unexpected-preconnect"); } }) });
        expect(result.code).not.toBe(0); expect(JSON.parse(result.stdout || result.stderr).error.code).toBe("invalid_input");
      }
      expect(requests).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("the real remaining daemon rejects generic product RPCs before native mutation or seat cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-product-daemon-")), socket = join(root, "daemon.sock");
    const gateway = await startMockGateway();
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const deps: CliDeps = { ...createProductionDeps(), configDir: root, boxRuntimeRoot: root, env: {}, discoveryPath, daemonSocket: socket, transport: "local" };
    const host = await startDaemonHost(deps, socket);
    const rpc = (method: string) => new Promise<any>((resolve, reject) => {
      const body = JSON.stringify({ protocolMajor: 1, method, params: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", timeoutMs: 1000 } });
      const req = request({ socketPath: socket, path: "/v1/rpc", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
        let text = ""; response.on("data", bytes => text += bytes); response.on("error", reject); response.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.on("error", reject); req.end(body);
    });
    try {
      expect((await rpc("handshake")).ok).toBe(true);
      for (const method of ["createAgent", "createGroup", "updateAgent", "duplicateAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar", "deleteAgent"]) {
        const reply = await rpc(method); expect(reply.ok).toBe(false); expect(reply.error.code).toBe("gateway_not_found");
        expect(gateway.requests.filter(row => row.pathname === `/api/${method}`)).toHaveLength(0);
      }
    } finally { await host.close(); gateway.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

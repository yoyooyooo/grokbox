import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Original finite-head, absent/unqualified source, offline unknown receipt and
// source-state preservation assertions now run through the formal HTTP/packed
// CLI in context-management.test.ts. Deferred creation is covered through the
// current packed CLI in server/test/created-bot-ownership.node.ts.
test("all retired current-state commands refuse before native transport or storage, including legacy operation flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "retired-state-cli-")), gateway = await startMockGateway({});
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const before = await readdir(root);
    for (const action of ["show", "capture", "initialize", "reset", "recover", "operation", "reconcile", "activate"]) {
      const result = await captureCli(["agents", "state", action, id, "--operation-id", id, "--confirm"], { configDir: root, boxRuntimeRoot: root, env: {}, discoveryPath });
      expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
    }
    for (const args of [["bot", "context", "reset", id], ["bot", "snapshot", "create", "--bot", id], ["bot", "activate", id]]) {
      const result = await captureCli(args, { configDir: root, boxRuntimeRoot: root, env: {}, discoveryPath });
      expect(result.code).not.toBe(0);
    }
    expect(gateway.requests).toHaveLength(0); expect(await readdir(root)).toEqual(before);
  } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); }
});

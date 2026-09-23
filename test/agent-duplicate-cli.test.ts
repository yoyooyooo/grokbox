import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";
import { GatewayClient } from "../packages/cli/src/gateway.ts";

// The active duplicate preview/single-dispatch/original-receipt/401+500/restart
// assertions moved to the formal shared-client Node HTTP + SQLite integration
// suite (packages/server/test/products.node.ts). Do not keep a second public
// creator alive merely to pass the former CLI's positive fixtures.
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId = "c".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "duplicate-retirement-"));
  const gateway = await startMockGateway({ agents: [{ id: sourceId, name: "source", title: "", isGroup: false, harness: "box" }] });
  const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
  const deps = { configDir: join(root, "config"), boxRuntimeRoot: root, discoveryPath, env: {}, transport: "local" as const, skillsDir: join(import.meta.dir, "../skills") };
  return { root, gateway, deps, close: async () => { gateway.stop(); await rm(root, { recursive: true, force: true }); } };
}

for (const args of [[], ["--expect-plan", "d".repeat(64), "--scope-id", scopeId, "--operation-id", sourceId, "--confirm"]]) {
  test(`retired duplicate syntax refuses without native inspection, storage or creation (${args.length ? "confirmed" : "preview"})`, async () => {
    const f = await fixture();
    try {
      const result = await captureCli(["agents", "duplicate", sourceId, ...args, "--json"], f.deps);
      expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("invalid_usage");
      expect(f.gateway.requests).toHaveLength(0); expect(await stat(join(f.root, "continuity")).then(() => true, () => false)).toBe(false);
    } finally { await f.close(); }
  });
}

test("obsolete CLI convenience writers are physically absent, not refusal-only wrappers", () => {
  for (const key of ["createAgent", "createGroup", "deleteAgent", "duplicateAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar"]) {
    expect(Object.hasOwn(GatewayClient.prototype, key)).toBe(false);
  }
});

test("historical original duplication reads cannot bootstrap a native writer or safety store", async () => {
  const f = await fixture();
  try {
    const result = await captureCli(["agents", "operations", "show", randomUUID(), "--scope-id", scopeId, "--json"], f.deps);
    expect(result.code).not.toBe(0); expect(f.gateway.requests).toHaveLength(0);
    expect(await stat(join(f.root, "continuity")).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

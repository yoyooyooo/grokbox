import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery, type MockOptions } from "./helpers.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";
import { runAgentDuplicate } from "../packages/cli/src/commands/agent-duplicate.ts";
import { GatewayClient } from "../packages/cli/src/gateway.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { CliDeps } from "../packages/cli/src/deps.ts";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scopeId = "c".repeat(64);
async function fixture(options: Partial<MockOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "duplicate-cli-"));
  const gateway = await startMockGateway({ agents: [{ id: sourceId, name: "source", description: "PRIVATE_SOURCE_PROFILE", title: "source", isGroup: false, harness: "temporal" }],
    nativeRoutines: [{ id: "daily", name: "daily", prompt: "PRIVATE_ROUTINE_PROMPT", isEnabled: true, trigger: { type: "cron", schedule: "0 8 * * *" } }],
    hostStatus: (body: any) => ({ grokboxOwnership: ownedOwnershipSnapshot(body.grokboxOwnershipAgentIds, { scopeId, nowMs: Date.now(),
      serverHarness: "temporal", localHarness: "temporal" }) }),
    duplicateAgent: () => ({ status: 200, body: { agent: { id: targetId, name: "native copy", secret: "PRIVATE_NATIVE_DETAIL" }, transcript: [] } }), ...options });
  const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
  const deps = { configDir: join(root, "config"), boxRuntimeRoot: root, discoveryPath, env: {}, transport: "local" as const, skillsDir: join(import.meta.dir, "../skills") };
  const preview = async () => {
    const result = await captureCli(["agents", "duplicate", sourceId, "--json"], deps);
    expect(result.code, result.stderr).toBe(0); return { ...result, plan: JSON.parse(result.stdout).data.plan };
  };
  const execute = (revision: string, operationId = randomUUID()) => captureCli(["agents", "duplicate", sourceId,
    "--expect-plan", revision, "--scope-id", scopeId, "--operation-id", operationId, "--confirm", "--json"], deps);
  return { root, gateway, deps, preview, execute, close: async () => { gateway.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("native duplicate CLI previews real reads without writes, prompts or private contents", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview();
    expect(preview.plan).toMatchObject({ source: { harness: "temporal", returnedRoutines: 1, enabledRoutines: 1 }, fullClone: false,
      effects: { routinesAutomaticallyPaused: false, maySelectNewActiveChat: true } });
    expect(preview.stdout).not.toContain("PRIVATE");
    expect(await stat(join(f.root, "continuity")).then(() => true, () => false)).toBe(false);
    expect(f.gateway.requests.some(r => /duplicateAgent|createAgent|sendPrompt|updateAgent|setAgent/.test(r.pathname))).toBe(false);
  } finally { await f.close(); }
});

test("confirmed CLI invokes only duplicateAgent once, stores its ID and labels actual Temporal ownership", async () => {
  const f = await fixture();
  try {
    const { plan } = await f.preview(), operationId = randomUUID();
    const result = await f.execute(plan.revision, operationId);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ result: { targetAgentId: targetId }, operation: { state: "succeeded" },
      target: { state: "confirmed_temporal" }, fullClone: false, sourceDeleted: false, managedModelAssigned: false });
    expect(result.stdout).not.toContain("PRIVATE");
    const calls = f.gateway.requests.filter(r => r.pathname === "/api/duplicateAgent");
    expect(calls).toHaveLength(1); expect(calls[0]!.body).toEqual({ id: sourceId }); expect(calls[0]!.hasAuthorization).toBe(true);
    expect(f.gateway.requests.some(r => /createAgent|sendPrompt|updateAgent|deleteAgent|setAgent/.test(r.pathname))).toBe(false);
    const before = f.gateway.requests.length;
    const repeated = await f.execute(plan.revision, operationId);
    expect(repeated.code, repeated.stderr).toBe(0); expect(JSON.parse(repeated.stdout).data.nativeDispatched).toBe(false);
    expect(f.gateway.requests.length).toBe(before);
    const saved = await captureCli(["agents", "operations", "show", operationId, "--scope-id", scopeId, "--json"], f.deps);
    expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).data.result.targetAgentId).toBe(targetId);
    expect(f.gateway.requests.length).toBe(before);
  } finally { await f.close(); }
});

for (const status of [401, 500]) test(`native duplicate HTTP ${status} is never automatically retried or recreated`, async () => {
  const f = await fixture({ duplicateAgent: () => ({ status, body: { error: "PRIVATE_FAILURE" } }) });
  try {
    const { plan } = await f.preview(), operationId = randomUUID();
    const failed = await f.execute(plan.revision, operationId);
    expect(failed.code).not.toBe(0); expect(JSON.parse(failed.stderr).error.code).toBe("operation_outcome_unknown");
    expect(failed.stderr).not.toContain("PRIVATE_FAILURE");
    expect(f.gateway.requests.filter(r => r.pathname === "/api/duplicateAgent")).toHaveLength(1);
    const again = await f.execute(plan.revision, operationId); expect(again.code).not.toBe(0);
    const another = await f.execute(plan.revision); expect(another.code).not.toBe(0);
    expect(f.gateway.requests.filter(r => r.pathname === "/api/duplicateAgent")).toHaveLength(1);
  } finally { await f.close(); }
});

test("groups and stale plans are rejected without invoking duplication", async () => {
  const group = await fixture({ agents: [{ id: sourceId, name: "group", isGroup: true, memberIds: [] }] });
  try {
    const result = await captureCli(["agents", "duplicate", sourceId, "--json"], group.deps);
    expect(result.code).not.toBe(0); expect(group.gateway.requests.some(r => r.pathname === "/api/duplicateAgent")).toBe(false);
  } finally { await group.close(); }
  const f = await fixture();
  try {
    const result = await f.execute("0".repeat(64)); expect(result.code).not.toBe(0);
    expect(f.gateway.requests.some(r => r.pathname === "/api/duplicateAgent")).toBe(false);
  } finally { await f.close(); }
});

test("changed Gateway generation and expired evidence refuse before the native POST", async () => {
  const f = await fixture();
  try {
    const client = new GatewayClient({ ...createProductionDeps(), ...f.deps });
    await expect(client.duplicateAgent(sourceId, "0".repeat(64), Date.now(), 1000)).rejects.toMatchObject({ reason: "generation_changed" });
    // Use actual discovery representation rather than assuming a host spelling.
    const found = await client.listAgents(1000);
    const exact = sha256Text(canonicalJson([found.discovery.baseUrl, found.discovery.pid, found.discovery.startedAt, sha256Text(found.discovery.token)]));
    await expect(client.duplicateAgent(sourceId, exact, Date.now() - 6000, 1000)).rejects.toMatchObject({ reason: "evidence_expired" });
    const discovery = JSON.parse(await readFile(f.deps.discoveryPath, "utf8"));
    discovery.token = "owned-rotated-token";
    await writeFile(f.deps.discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
    await expect(client.duplicateAgent(sourceId, exact, Date.now(), 1000)).rejects.toMatchObject({ reason: "generation_changed" });
    expect(f.gateway.requests.some(r => r.pathname === "/api/duplicateAgent")).toBe(false);
  } finally { await f.close(); }
});

test("explicit Profiles are refused for both duplicate and existing current-state controls", async () => {
  const f = await fixture();
  try {
    for (const args of [["agents", "duplicate", sourceId], ["bot", "context", "get", sourceId]]) {
      const result = await captureCli(["--profile", "default", ...args, "--json"], f.deps);
      expect(result.code).not.toBe(0); expect(f.gateway.requests).toHaveLength(0);
    }
  } finally { await f.close(); }
});

test("missing confirmation inputs and remote transport refuse before any creation or storage", async () => {
  const deps = new Proxy({} as CliDeps, { get() { throw Error("unexpected-dependency"); } });
  await expect(runAgentDuplicate(deps, sourceId, { confirm: true })).rejects.toMatchObject({ code: "invalid_usage" });
  const f = await fixture();
  try {
    const result = await captureCli(["agents", "duplicate", sourceId, "--json"], { ...f.deps, transport: "gateway", sshHost: "not-used" });
    expect(result.code).not.toBe(0); expect(f.gateway.requests).toHaveLength(0);
    expect(await stat(join(f.root, "continuity")).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

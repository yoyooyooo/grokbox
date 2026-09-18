import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";
import { runAgentState } from "../packages/cli/src/commands/agent-state.ts";
import { openContinuityRecoveryStore } from "../packages/box-runtime/src/runtime.ts";
import type { CliDeps } from "../packages/cli/src/deps.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scopeId = "c".repeat(64);
const head = { agentId: id, scopeId, hostSourceSha: "d".repeat(64), nativeSchema: "owned-cli-v1", hostGeneration: "generation",
  contextRevision: "e".repeat(64), activationEpoch: "native-0", rootHash: null, state: "empty", effects: "clear" };
for (const [action, raw] of [["capture", {}], ["initialize", { operationId, confirm: true }], ["activate", { operationId }],
  ["operation", { operationId }]] as const) {
  test(`state ${action} refuses malformed requests before any dependencies`, async () => {
    let accesses = 0;
    const deps = new Proxy({} as CliDeps, { get() { accesses++; throw Error("unexpected-dependency"); } });
    await expect(runAgentState(deps, action, id, raw)).rejects.toMatchObject({ code: "invalid_usage" });
    expect(accesses).toBe(0);
  });
}

test("CLI state show reads one finite endpoint without initializing CONT or creating a message", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cli-")), durableRoot = join(root, "durable");
  const gateway = await startMockGateway({ currentStateControl: () => ({ ok: true, data: { head, policyRevision: "f".repeat(64), readyToExecute: false } }) });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const result = await captureCli(["agents", "state", "show", id, "--json"], { configDir: join(root, "config"), boxRuntimeRoot: durableRoot,
      env: {}, discoveryPath, transport: "local", skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).data).toMatchObject({ head, readyToExecute: false });
    const calls = gateway.requests.filter(r => r.pathname === "/api/grokboxCurrentStateControl");
    expect(calls).toHaveLength(1); expect(calls[0]?.body).toEqual({ version: 1, action: "head", agentId: id });
    expect(calls[0]?.hasAuthorization).toBe(true);
    expect(gateway.requests.some(r => /sendPrompt|createAgent|updateAgent/.test(r.pathname))).toBe(false);
    expect(await stat(join(durableRoot, "continuity")).then(() => true, () => false)).toBe(false);
  } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); }
});

test("offline operation query needs no Host and preserves unknown safety state", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cli-offline-"));
  try {
    const store = openContinuityRecoveryStore({ durableRoot: root, scopeId }); await store.initialize();
    await store.prepareEffect({ operationId, agentId: id, kind: "initialize", inputDigest: "d".repeat(64), policyRevision: "e".repeat(64), snapshotId: null });
    await store.claimEffect(operationId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "e".repeat(64));
    const result = await captureCli(["agents", "state", "operation", id, "--operation-id", operationId, "--scope-id", scopeId, "--json"],
      { configDir: join(root, "config"), boxRuntimeRoot: root, env: {}, transport: "local", discoveryPath: join(root, "absent-host"), skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ operation: { state: "effect_unknown" }, nativeCurrentChecked: false });
    expect((await store.operation(operationId)).state).toBe("effect_unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deferred Box creation explicitly suppresses introduction and kickstart without claiming an input hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cli-create-"));
  const gateway = await startMockGateway({ createAgentId: id });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const result = await captureCli(["agents", "create", "--name", "owned-ready-target", "--harness", "box", "--defer-start", "--json"],
      { configDir: root, env: {}, discoveryPath, transport: "local", skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code, result.stderr).toBe(0);
    const requests = gateway.requests.filter(r => r.pathname === "/api/createAgent");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ isIntroductionSuppressed: true, isKickstartRequested: false, harness: "box" });
    expect(JSON.parse(result.stdout).data.creation).toMatchObject({ initialStartSuppressionRequested: true, preparationHoldEstablished: false });
    expect(gateway.requests.some(r => /sendPrompt|kickstartAgent/.test(r.pathname))).toBe(false);
  } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); }
});

test("an unqualified Host gives explicit unavailability rather than a false initialized result", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cli-unavailable-"));
  const gateway = await startMockGateway({ currentStateControl: () => ({ ok: false, error: { code: "native_unavailable" } }) });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const result = await captureCli(["agents", "state", "show", id, "--json"], { configDir: root, env: {}, discoveryPath, transport: "local", skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(JSON.parse(result.stderr).error.code).toBe("capability_unavailable");
    expect(gateway.requests.filter(r => r.pathname === "/api/grokboxCurrentStateControl")).toHaveLength(1);
  } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); }
});

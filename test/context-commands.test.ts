import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";
import { runAgentsContext } from "../packages/cli/src/commands/agents.ts";
import type { CliDeps } from "../packages/cli/src/deps.ts";

const A = "00000000-0000-4000-8000-000000000001";
for (const raw of [{}, { operationId: "operation" }, { confirm: true }, { operationId: "bad/path", confirm: true }, { operationId: "operation", confirm: true, session: "bad\n" }]) {
  test(`compact rejects before dependency access: ${JSON.stringify(raw)}`, async () => {
    let accesses = 0;
    const deps = new Proxy({} as CliDeps, { get() { accesses++; throw new Error("dependency_access_forbidden"); } });
    await expect(runAgentsContext(deps, "compact", A, raw)).rejects.toMatchObject({ code: "invalid_usage" });
    expect(accesses).toBe(0);
  });
}

test("context is read-only; explicit compact uses one typed endpoint and preserves empty session/operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cli-"));
  const gateway = await startMockGateway({ contextControl: body => ({ ok: true, data: { request: body, nativeCapability: "ready" } }) });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const deps = { configDir: dir, env: {}, discoveryPath, transport: "local" as const, skillsDir: join(import.meta.dir, "../skills"), stdinIsTTY: true };
    const read = await captureCli(["agents", "context", A, "--session", "", "--json"], deps);
    expect(read.code, read.stderr).toBe(0);
    const compact = await captureCli(["agents", "compact", A, "--session", "", "--operation-id", "context-once", "--confirm", "--json"], deps);
    expect(compact.code, compact.stderr).toBe(0);
    const calls = gateway.requests.filter(request => request.pathname === "/api/grokboxContextControl");
    expect(calls.map(call => call.body)).toEqual([
      { action: "status", agentId: A, sessionId: "" },
      { action: "compact", agentId: A, sessionId: "", operationId: "context-once", confirm: true },
    ]);
    expect(calls.every(call => call.hasAuthorization && !call.hasOrigin)).toBe(true);
    expect(gateway.requests.some(request => /sendPrompt|createAgent|updateAgent|exec/.test(request.pathname))).toBe(false);
  } finally { gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("unknown compact result is not a success and is not retried as a new operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cli-unknown-"));
  const gateway = await startMockGateway({ contextControl: () => ({ ok: false, error: { code: "commit_unknown" } }) });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const result = await captureCli(["agents", "compact", A, "--operation-id", "unknown-operation", "--confirm", "--json"],
      { configDir: dir, env: {}, discoveryPath, transport: "local", skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code).not.toBe(0);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("operation_outcome_unknown");
    expect(result.stderr).toContain("unknown-operation");
    expect(gateway.requests.filter(request => request.pathname === "/api/grokboxContextControl")).toHaveLength(1);
    expect(result.stdout).toBe("");
  } finally { gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

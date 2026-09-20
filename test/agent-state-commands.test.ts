import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, startMockGateway, writeDiscovery } from "./helpers.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Original finite-head, absent/unqualified source, offline unknown receipt and
// source-state preservation assertions now run through the formal HTTP/packed
// CLI in context-management.test.ts. This file keeps retirement and independent
// deferred native creation boundaries; no old direct writer is restored.
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

test("deferred Box creation explicitly suppresses introduction and kickstart without claiming an input hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cli-create-"));
  const gateway = await startMockGateway({ createAgentId: id });
  try {
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const result = await captureCli(["agents", "create", "--name", "owned-ready-target", "--harness", "box", "--defer-start", "--json"],
      { configDir: root, env: {}, discoveryPath, transport: "local", skillsDir: join(import.meta.dir, "../skills") });
    expect(result.code, result.stderr).toBe(0);
    const requests = gateway.requests.filter(r => r.pathname === "/api/createAgent"); expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ isIntroductionSuppressed: true, isKickstartRequested: false, harness: "box" });
    expect(JSON.parse(result.stdout).data.creation).toMatchObject({ initialStartSuppressionRequested: true, preparationHoldEstablished: false });
    expect(gateway.requests.some(r => /sendPrompt|kickstartAgent/.test(r.pathname))).toBe(false);
  } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); }
});

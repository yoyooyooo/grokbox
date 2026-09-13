import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOwnership } from "../packages/cli/src/ownership.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps, type CliDeps } from "../packages/cli/src/deps.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { captureCli, parseJson, writeDiscovery } from "./helpers.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-12T10:00:00.000Z";
function row(agentId: string, serverHarness: string, localHarness: string) {
  return { agentId, serverEvidence: "found", server: { agentId, serverId: "owned-server", harness: serverHarness, viewerIsOwner: true, token: "PRIVATE_SENTINEL" },
    local: { before: { harness: localHarness, serverId: "owned-server" }, after: { harness: localHarness, serverId: "owned-server" }, stable: true } };
}
function snapshot(rows: unknown[]) {
  return { schemaVersion: 1, observedAt: at, completedAt: at, state: "observed", source: "Host.official-client/ListGrokBotAgents",
    localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } }, agents: rows };
}

for (const [server, local, state] of [["box", "box", "confirmed_box"], ["temporal", "temporal", "confirmed_temporal"],
  ["temporal", "box", "conflict"], ["box", "temporal", "conflict"], ["unknown", "box", "unconfirmed"], ["box", "unknown", "unconfirmed"]] as const) {
  test(`ownership ${server}/${local} -> ${state}; no App or production success inferred`, () => {
    const result = projectOwnership({ agentIds: [A], snapshot: snapshot([row(A, server!, local!)]) });
    expect(result.agents[0]?.state).toBe(state);
    expect(result.desktopRoute).toBe("not_observed");
    expect(result.productionAccepted).toBe(false);
    expect(result.serverMigration).toBe("not_observed");
    expect(result.agents[0]?.blockers).toContain("desktop_route_not_observed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });
}

test("missing bridge/row, duplicate row and changed generation cannot confirm ownership", () => {
  for (const value of [null, {}, snapshot([]), snapshot([row(A, "box", "box"), row(A, "box", "box")])]) {
    expect(projectOwnership({ agentIds: [A], snapshot: value }).agents[0]?.state).toBe("unconfirmed");
  }
  expect(projectOwnership({ agentIds: [A], snapshot: snapshot([row(A, "box", "box")]), gatewayChanged: true }).agents[0]?.state).toBe("unconfirmed");
});

test("same UUID with different Server row id is conflict, not same agent proof", () => {
  const one = row(A, "box", "box");
  one.server.serverId = "other-row";
  const result = projectOwnership({ agentIds: [A], snapshot: snapshot([one]) });
  expect(result.agents[0]?.state).toBe("conflict");
  expect(result.agents[0]?.reasons).toContain("server_id_mismatch");
});

test("migration is an independent blocker, not a harness setter or proof it never occurs", () => {
  const value = snapshot([row(A, "box", "box")]);
  value.localMigrationWindow.after.kind = "active";
  const result = projectOwnership({ agentIds: [A], snapshot: value });
  expect(result.agents[0]?.state).toBe("confirmed_box");
  expect(result.agents[0]?.managedEligibility).toBe("blocked");
  expect(result.agents[0]?.blockers).toContain("local_migration_window_active");
});

test("a false stable claim does not conceal a changed local declaration", () => {
  const one = row(A, "box", "box");
  one.local.after.harness = "temporal";
  expect(projectOwnership({ agentIds: [A], snapshot: snapshot([one]) }).agents[0]?.state).toBe("unconfirmed");
});

for (const installed of [true, false]) for (const daemonMode of [false, true]) {
  test(`CLI ${daemonMode ? "daemon" : "direct"} makes one bounded read (${installed ? "installed" : "old Host"}), never reconcile/send/migrate`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ownership-test-"));
    const token = "owned-test-token";
    const requests: Array<{ path: string; body: unknown }> = [];
    const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1700000000000 });
      expect(req.headers.get("authorization")).toBe(`Bearer ${token}`);
      const body = await req.json(); requests.push({ path, body });
      if (path === "/api/listAgents") return Response.json([{ id: A, name: "owned-A", harness: "box", isGroup: false }, { id: B, name: "owned-B", harness: "box", isGroup: false }]);
      if (path === "/api/getHostStatus") return Response.json(installed ? { grokboxOwnership: snapshot([row(A, "box", "box"), row(B, "temporal", "box")]), secret: "PRIVATE_SENTINEL" } : { version: "stock" });
      return Response.json({}, { status: 404 });
    } });
    const discoveryPath = await writeDiscovery({ port: gateway.port!, pid: 4242, startedAt: 1700000000000, token });
    const deps: Partial<CliDeps> = { configDir: dir, discoveryPath, env: {}, agentDataRoot: join(dir, "agents"), boxRuntimeRoot: join(dir, "runtime"),
      transport: daemonMode ? "daemon" : "local", daemonSocket: join(dir, "daemon.sock") };
    await writeProfileFile(dir, "default", { version: 1, transport: daemonMode ? "daemon" : "local", gateway_discovery: discoveryPath, daemon_socket: deps.daemonSocket });
    const daemon = daemonMode ? await startDaemonHost({ ...createProductionDeps(), ...deps, transport: "local" }, deps.daemonSocket!) : undefined;
    try {
      const ran = await captureCli(["agents", "ownership", "owned-A", B, "--json"], deps);
      expect(ran.code).toBe(0);
      const data = (parseJson(ran.stdout) as { data: { agents: { state: string }[] } }).data;
      expect(data.agents.map((r: { state: string }) => r.state)).toEqual(installed ? ["confirmed_box", "conflict"] : ["unconfirmed", "unconfirmed"]);
      expect(requests).toEqual([{ path: "/api/listAgents", body: {} }, { path: "/api/getHostStatus", body: { grokboxOwnershipAgentIds: [A, B] } }]);
      expect(ran.stdout).not.toContain("PRIVATE_SENTINEL");
    } finally { await daemon?.close(); gateway.stop(true); await rm(dir, { recursive: true, force: true }); }
  });
}

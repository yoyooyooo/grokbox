import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCli, parseJson, writeDiscovery } from "./helpers.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
async function fixture(mode: "box" | "temporal" | "confirmed-temporal" | "old" | "failure" | "wrong-id" = "box") {
  const root = await mkdtemp(join(tmpdir(), "grokbox-selection-command-"));
  const calls: Array<{ path: string; body: unknown }> = [];
  let title = "Keep Me";
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1 });
    if (path === "/v1/models") return Response.json({ data: [{ id: "owned" }] });
    if (request.headers.get("authorization") !== "Bearer owned-command-token") return Response.json({}, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/api/createAgent") return Response.json({ agent: { id: A, name: "owned", isGroup: false } });
    if (path === "/api/listAgents") return Response.json([{ id: A, name: "owned", title, isGroup: false, harness: "box" }]);
    if (path === "/api/updateAgent") {
      const profile = body.profile as Record<string, unknown> | undefined;
      if (typeof profile?.title === "string") title = profile.title;
      return Response.json({ agent: { id: A, name: "owned", title, isGroup: false } });
    }
    if (path === "/api/getHostStatus") {
      if (mode === "old") return Response.json({ version: "old" });
      if (mode === "failure") return Response.json({ error: "owned-failure" }, { status: 503 });
      const ids = body.grokboxOwnershipAgentIds as string[];
      const snapshot = ownedOwnershipSnapshot(mode === "wrong-id" ? [B] : ids, {
        serverHarness: mode === "temporal" || mode === "confirmed-temporal" ? "temporal" : "box",
        localHarness: mode === "confirmed-temporal" ? "temporal" : "box",
      });
      return Response.json({ grokboxOwnership: snapshot });
    }
    return Response.json({}, { status: 404 });
  } });
  const discoveryPath = await writeDiscovery({ port: gateway.port!, pid: 4242, startedAt: 1, token: "owned-command-token" });
  const boxRuntimeRoot = join(root, "runtime");
  await mkdir(join(boxRuntimeRoot, "state"), { recursive: true, mode: 0o700 });
  await writeFile(join(boxRuntimeRoot, "config.json"), JSON.stringify({ schemaVersion: 2, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
  await writeFile(join(boxRuntimeRoot, "models.json"), JSON.stringify({ version: 1,
    models: { "openai/owned": { id: "openai/owned", provider: "openai", model: "owned", endpoint: `http://127.0.0.1:${gateway.port}/v1`, apiKeyRef: "env:OWNED", contextWindowTokens: 200000,
      capabilities: { tools: true, images: false, vision: false }, dataTypes: ["text", "tools"] } },
    assignments: { main: null, agents: { [A]: "stub/echo", [B]: "stub/echo" } },
  }));
  const deps = { configDir: root, discoveryPath, boxRuntimeRoot, env: { OWNED: "owned-test-key" }, transport: "local" as const, daemonSocket: join(root, "unused.sock") };
  return { calls, deps, load: async () => JSON.parse(await readFile(join(boxRuntimeRoot, "models.json"), "utf8")),
    close: async () => { gateway.stop(true); await rm(root, { recursive: true, force: true }); } };
}

test("real CLI use admits ownership; explicit reset only removes intent and preserves the other Bot", async () => {
  const f = await fixture();
  try {
    for (const args of [["use", "openai/owned"], ["reset"]]) {
      const ran = await captureCli(["models", ...args, "--for", A], f.deps);
      expect(ran.code, ran.stderr).toBe(0);
      const data = parseJson(ran.stdout) as { data: { title?: { from?: string; to?: string; written?: boolean; m?: string | null } } };
      expect(data).toMatchObject({ data: { selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed", blastRadius: "single_bot", ownership: args[0] === "reset" ? "not_required_for_reset" : "confirmed_box" } });
      expect(data.data.title?.to).toContain("Keep Me");
      if (args[0] === "use") {
        expect(data.data.title).toMatchObject({ from: "Keep Me", written: true, m: "owned" });
        expect(data.data.title?.to).toContain("m=owned");
      } else {
        expect(data.data.title?.from).toContain("m=owned");
        expect(data.data.title?.written).toBe(true);
        expect(data.data.title?.to?.includes("m=") ?? false).toBe(false);
      }
      expect((await f.load()).assignments.agents[B]).toBe("stub/echo");
      expect((await f.load()).assignments.agents[A]).toBe(args[0] === "reset" ? undefined : "openai/owned");
    }
    expect(f.calls.some((call) => call.path === "/api/updateAgent")).toBe(true);
    const byName = await captureCli(["models", "use", "openai/owned", "--for", "owned"], f.deps);
    expect(byName.code, byName.stderr).toBe(0);
    expect(f.calls.map(call => call.path).filter((path) => path === "/api/listAgents").length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

for (const mode of ["temporal", "old", "failure", "wrong-id"] as const) {
  test(`explicit CLI reset with ${mode} cannot be trapped behind managed admission`, async () => {
    const f = await fixture(mode);
    try {
      const before = await f.load();
      const result = await captureCli(["models", "reset", "--for", A], f.deps);
      expect(result.code, result.stderr).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({ data: { ownership: "not_required_for_reset", effectiveUse: "not_observed" } });
      expect(f.calls.some((call) => call.path === "/api/updateAgent")).toBe(false);
      expect(await f.load()).toEqual({ ...before, assignments: { ...before.assignments, agents: { [B]: "stub/echo" } } });
      const use = await captureCli(["models", "use", "openai/owned", "--for", A], f.deps);
      expect(use.code).not.toBe(0);
      expect((await f.load()).assignments.agents[A]).toBeUndefined();
      expect(f.calls.some((c) => c.path === "/api/getHostStatus")).toBe(true);
      const error = (parseJson(use.stderr) as { error: { code: string; message: string; next: string; failureCode?: string } }).error;
      expect(error.message).not.toBe(error.failureCode ?? "");
      expect(error.next).not.toContain("host on");
    } finally { await f.close(); }
  });
}

for (const [mode, expected] of [
  ["temporal", { code: "runtime_ownership_conflict", next: `grokbox agents ownership ${A}` }],
  ["confirmed-temporal", { code: "runtime_ownership_temporal", next: `grokbox agents ownership ${A}` }],
  ["old", { code: "runtime_ownership_unavailable", failureCode: "server_read_unavailable", next: `grokbox agents ownership ${A}` }],
  ["failure", { code: "runtime_ownership_unavailable", next: "grokbox doctor" }],
  ["wrong-id", { code: "runtime_ownership_unconfirmed", next: `grokbox agents ownership ${A}` }],
] as const) {
  test(`models use types ${mode} ownership refusal with next`, async () => {
    const f = await fixture(mode);
    try {
      const before = await f.load();
      const use = await captureCli(["models", "use", "openai/owned", "--for", A], f.deps);
      expect(use.code).not.toBe(0);
      expect(use.stdout).toBe("");
      const error = (parseJson(use.stderr) as { error: { code: string; message: string; next: string; failureCode?: string } }).error;
      expect(error).toMatchObject(expected);
      expect(error.next).not.toContain("host start");
      expect(error.next).not.toContain("title sync");
      expect(error.next).not.toContain("agents create");
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.message).not.toBe(error.failureCode ?? "");
      expect(error.next).not.toContain("host on");
      expect((await f.load()).assignments).toEqual(before.assignments);
    } finally { await f.close(); }
  });
}

test("actual packed Node reset removes an override with no Gateway/discovery or credential environment", async () => {
  const f = await fixture("failure");
  try {
    const before = await f.load();
    const cli = ensurePackedCli();
    const result = spawnSync("node", [cli, "models", "reset", "--for", A, "--json"], {
      env: { PATH: process.env.PATH, HOME: f.deps.configDir, GROKBOX_BOX_RUNTIME_ROOT: f.deps.boxRuntimeRoot, GROKBOX_RUN_ROOT: join(f.deps.configDir, "no-gateway") },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { selectionSaved: true, ownership: "not_required_for_reset", currentTurn: "unchanged", effectiveUse: "not_observed" } });
    expect(f.calls).toEqual([]);
    expect(await f.load()).toEqual({ ...before, assignments: { ...before.assignments, agents: { [B]: "stub/echo" } } });
  } finally { await f.close(); }
});

for (const mode of ["box", "temporal", "old", "failure", "wrong-id"] as const) {
  test(`created Bot ${mode} ownership read-back never retries create or pretends migration`, async () => {
    const f = await fixture(mode);
    try {
      const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const ran = await captureCli(["agents", "create", "--name", "owned", "--nonce", nonce, "--harness", "box"], f.deps);
      expect(ran.code, ran.stderr).toBe(0);
      const result = parseJson(ran.stdout) as { data: { creation: { outcome: string; ownershipConfirmed: boolean; operationId: string; managedEnabled: boolean } } };
      expect(result.data.creation).toMatchObject({ operationId: nonce, ownershipConfirmed: mode === "box", managedEnabled: false });
      expect(result.data.creation.outcome).toBe(mode === "box" ? "created_ownership_confirmed" : mode === "temporal" ? "created_ownership_mismatch" : "created_ownership_unconfirmed");
      expect(f.calls.filter(c => c.path === "/api/createAgent")).toHaveLength(1);
      expect(f.calls.filter(c => c.path.includes("delete") || c.path.includes("reconcile") || c.path.includes("sendPrompt"))).toHaveLength(0);
    } finally { await f.close(); }
  });
}

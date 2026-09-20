import { expect, test } from "bun:test";
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
  await writeFile(join(boxRuntimeRoot, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
  await writeFile(join(boxRuntimeRoot, "models.json"), JSON.stringify({ version: 1,
    models: { "openai/owned": { id: "openai/owned", provider: "openai", model: "owned", endpoint: `http://127.0.0.1:${gateway.port}/v1`, apiKeyRef: "env:OWNED", contextWindowTokens: 200000,
      capabilities: { tools: true, images: false, vision: false, reasoning: { efforts: ["high", "xhigh"] } }, dataTypes: ["text", "tools"] } },
    assignments: { main: null, agents: { [A]: "stub/echo", [B]: "stub/echo" } },
  }));
  const deps = { configDir: root, discoveryPath, boxRuntimeRoot, env: { OWNED: "owned-test-key" }, transport: "local" as const, daemonSocket: join(root, "unused.sock") };
  return { calls, deps, load: async () => JSON.parse(await readFile(join(boxRuntimeRoot, "models.json"), "utf8")),
    close: async () => { gateway.stop(true); await rm(root, { recursive: true, force: true }); } };
}

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

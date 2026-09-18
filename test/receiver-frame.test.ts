import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewedProfilePath } from "../packages/box-runtime/src/runtime.ts";
import { sha256Text } from "../packages/runtime-kernel/src/hash.ts";
import { OWNERSHIP_LOCAL_SOURCE } from "../packages/runtime-kernel/src/contract.ts";
import { RECEIVER_NOTICE_PROMPT, RECEIVER_NOTICE_POLICY_REVISION } from "../packages/runtime-kernel/src/observation.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { nativeReceiverReader, nativeExplicitReceiverReader } from "../packages/cli/src/gateway-receiver.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOURCE = "b".repeat(64), TRANSFORM = "c".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "receiver-frame-")), discovery = join(root, "discovery.json");
  const profile = { sourceSha256: SOURCE, transformedSourceSha256: TRANSFORM, slices: [] };
  const profileBytes = JSON.stringify(profile) + "\n", profileHash = sha256Text(profileBytes);
  const calls: Array<{ path: string; body: unknown }> = [];
  let mutateProfile = false, wrongOwner = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.headers.get("authorization") !== "Bearer fixture-receiver-token") return new Response(null, { status: 401 });
    if (path === "/health") return Response.json({ ok: true, pid: 4242, startedAt: 1700000000000, isBusy: false });
    const body = await request.json(); calls.push({ path, body });
    if (path === "/api/getAgentAutomations") return Response.json([{ id: "notice", name: "Notices", prompt: RECEIVER_NOTICE_PROMPT,
      isEnabled: false, trigger: { type: "webhook" }, createdAt: 1 }]);
    if (path !== "/api/getHostStatus") return new Response(null, { status: 404 });
    return Response.json({ grokboxOwnership: ownedOwnershipSnapshot([AGENT]), grokboxRuntimeCapabilities: { version: 1, source: "Host.loaded-runtime-capabilities",
      ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE },
      loaded: { pid: wrongOwner ? 4243 : 4242, start: 1, profileSha256: profileHash, sourceSha256: SOURCE, transformedSha256: TRANSFORM } },
      grokboxReceiverModel: { version: 1, source: "grokbox.host.automation-model.v1", state: "observed", agentId: AGENT,
        observedAtMs: Date.now(), selection: "native", modelRevision: "d".repeat(64), loadedProfileRevision: profileHash,
        loadedSourceRevision: SOURCE, loadedPreloadRevision: "e".repeat(64), loadedMode: "identity", reason: "selected",
        scope: "next_local_default_automation_session", executionObserved: false, toolsObserved: false, noModelRequest: true,
        credential: "PRIVATE_SENTINEL" } });
  } });
  await writeFile(discovery, JSON.stringify({ scheme: "http", host: "127.0.0.1", port: server.port, pid: 4242,
    startedAt: 1700000000000, token: "fixture-receiver-token" }), { mode: 0o600 });
  await mkdir(join(root, "config"), { mode: 0o700 });
  const profilePath = reviewedProfilePath(root); let profileReads = 0;
  const deps = { ...createProductionDeps(), boxRuntimeRoot: root, configDir: join(root, "config"), env: {}, discoveryPath: discovery,
    transport: "local" as const, readFile: async (path: string) => {
      if (path !== profilePath) return readFile(path, "utf8");
      profileReads++;
      return mutateProfile && profileReads > 1 ? JSON.stringify({ ...profile, sourceSha256: "f".repeat(64) }) : profileBytes;
    } };
  return { root, calls, read: () => nativeReceiverReader(deps, 10000)(AGENT, "notice"),
    readExplicit: () => nativeExplicitReceiverReader(deps, 15000)(AGENT, "notice"),
    mutate: () => { mutateProfile = true; }, wrongOwner: () => { wrongOwner = true; },
    close: async () => { server.stop(true); await rm(root, { recursive: true, force: true }); } };
}

test("receiver model and loaded capabilities come from one bounded native status frame", async () => {
  const f = await fixture(); try {
    const result = await f.read();
    expect(result).toMatchObject({ consistentGeneration: true, promptPolicyRevision: RECEIVER_NOTICE_POLICY_REVISION,
      capabilities: { state: "ready", reason: "matched" }, model: { state: "observed", executionObserved: false } });
    expect(f.calls.map(c => c.path)).toEqual(["/api/getAgentAutomations", "/api/getHostStatus"]);
    expect(f.calls[1]!.body).toEqual({ grokboxRuntimeCapabilities: true, grokboxOwnershipAgentIds: [AGENT], grokboxOwnershipLocalOnly: true });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("fixture-receiver-token");
    expect(JSON.stringify(result)).not.toContain(RECEIVER_NOTICE_PROMPT);
  } finally { await f.close(); }
});

test("explicit delivery reader adds the existing Server ownership read without minting credentials or running a Routine", async () => {
  const f = await fixture(); try {
    const value = await f.readExplicit();
    expect(value.ownershipGeneration).toBe(value.snapshot.generation);
    expect(value.ownership).toMatchObject({ source: "Host.official-client/ListGrokBotAgents", state: "observed" });
    expect(f.calls.map(c => c.path)).toEqual(["/api/getAgentAutomations", "/api/getHostStatus", "/api/getHostStatus"]);
    expect(f.calls[2]!.body).toEqual({ grokboxOwnershipAgentIds: [AGENT] });
  } finally { await f.close(); }
});

test("a failed local capability preflight does not broaden into a Server ownership request", async () => {
  const f = await fixture(); try {
    f.wrongOwner(); const value = await f.readExplicit();
    expect(value.ownership).toBeNull(); expect(f.calls).toHaveLength(2);
  } finally { await f.close(); }
});

test("reviewed profile changed during the native frame cannot be combined into a matching receiver", async () => {
  const f = await fixture(); try {
    f.mutate();
    expect(await f.read()).toMatchObject({ consistentGeneration: false, model: null,
      capabilities: { state: "unavailable", reason: "expected_profile_unavailable" } });
    expect(f.calls.filter(c => c.path === "/api/getHostStatus")).toHaveLength(1);
  } finally { await f.close(); }
});

test("another loaded Host identity is rejected even when source and profile digests match", async () => {
  const f = await fixture(); try {
    f.wrongOwner();
    expect(await f.read()).toMatchObject({ capabilities: { state: "incompatible", reason: "generation_mismatch" } });
    expect(f.calls).toHaveLength(2);
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { RECEIVER_NOTICE_PROMPT, RECEIVER_NOTICE_POLICY_REVISION } from "@grokbox/runtime-kernel/observation";
import { createManagementGateway, reviewedProfilePath } from "@grokbox/box-runtime/runtime";
import { ownedOwnershipSnapshot } from "../../box-runtime/test/ownership-fixture.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOURCE = "b".repeat(64), TRANSFORM = "c".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "management-receiver-")), discoveryPath = join(root, "gateway.json");
  const profile = { sourceSha256: SOURCE, transformedSourceSha256: TRANSFORM, slices: [] }, profileHash = sha256Text(JSON.stringify(profile) + "\n");
  const profilePath = reviewedProfilePath(root);
  await mkdir(dirname(profilePath), { recursive: true, mode: 0o700 }); await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
  const state = { mode: "normal" as "normal" | "changed-profile" | "changed-generation" | "redirect" | "oversized" | "slow", token: "synthetic-receiver-key" };
  let discovery: { scheme: string; host: string; port: number; pid: number; startedAt: number; token: string };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${state.token}`); assert.equal(request.headers.origin, undefined);
      let text = ""; for await (const bytes of request) text += bytes.toString();
      const input = JSON.parse(text); calls.push({ path: request.url!, input });
      response.setHeader("content-type", "application/json");
      if (state.mode === "redirect") { response.writeHead(302, { location: "https://not-authorized.invalid" }); response.end(); return; }
      if (state.mode === "oversized") { response.end(JSON.stringify({ data: "x".repeat(512 * 1024) })); return; }
      if (state.mode === "slow") return;
      if (request.url === "/api/getAgentAutomations") {
        if (state.mode === "changed-generation") await writeFile(discoveryPath, JSON.stringify({ ...discovery, startedAt: discovery.startedAt + 1 }), { mode: 0o600 });
        response.end(JSON.stringify([{ id: "notice", name: "Notices", prompt: RECEIVER_NOTICE_PROMPT, isEnabled: true, trigger: { type: "webhook" }, createdAt: 1 }])); return;
      }
      assert.equal(request.url, "/api/getHostStatus");
      if (state.mode === "changed-profile") await writeFile(profilePath, JSON.stringify({ ...profile, sourceSha256: "f".repeat(64) }), { mode: 0o600 });
      response.end(JSON.stringify({ grokboxOwnership: ownedOwnershipSnapshot([A]),
        grokboxRuntimeCapabilities: { version: 1, source: "Host.loaded-runtime-capabilities", ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE },
          loaded: { pid: 4242, start: 1, profileSha256: profileHash, sourceSha256: SOURCE, transformedSha256: TRANSFORM } },
        grokboxReceiverModel: { version: 1, source: "grokbox.host.automation-model.v1", state: "observed", agentId: A, observedAtMs: Date.now(), selection: "native", modelRevision: "d".repeat(64),
          loadedProfileRevision: profileHash, loadedSourceRevision: SOURCE, loadedPreloadRevision: "e".repeat(64), loadedMode: "identity", reason: "selected",
          scope: "next_local_default_automation_session", executionObserved: false, toolsObserved: false, noModelRequest: true, secret: "PRIVATE_SENTINEL" } }));
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  discovery = { scheme: "http", host: "127.0.0.1", port: address.port, pid: 4242, startedAt: 1700000000000, token: state.token };
  await writeFile(discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
  const source = createManagementGateway({ discoveryPath, configurationRoot: root });
  return { root, calls, state, source, expectedGeneration: sha256Text(canonicalJson([`http://127.0.0.1:${address.port}`, 4242, 1700000000000])),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

test("installed receiver adapter uses bounded native reads and preserves the original pairing generation", async () => {
  const f = await fixture();
  try {
    const read = await f.source.readNotificationReceiver(A, "notice");
    assert.equal(read.consistentGeneration, true); assert.equal(read.capabilities.state, "ready");
    assert.equal(read.snapshot.generation, f.expectedGeneration); assert.equal(read.ownershipGeneration, f.expectedGeneration);
    assert.equal(read.promptPolicyRevision, RECEIVER_NOTICE_POLICY_REVISION);
    assert.deepEqual(f.calls.map(call => call.path), ["/api/getAgentAutomations", "/api/getHostStatus", "/api/getHostStatus"]);
    assert.deepEqual(f.calls[1]!.input, { grokboxRuntimeCapabilities: true, grokboxOwnershipAgentIds: [A], grokboxOwnershipLocalOnly: true });
    assert.deepEqual(f.calls[2]!.input, { grokboxOwnershipAgentIds: [A] });
    for (const secret of [f.state.token, "PRIVATE_SENTINEL", RECEIVER_NOTICE_PROMPT]) assert.ok(!JSON.stringify(read).includes(secret));
  } finally { await f.close(); }
});
for (const mode of ["changed-profile", "changed-generation"] as const) test(`receiver ${mode} cannot mix observations or proceed to ownership qualification`, async () => {
  const f = await fixture();
  try { f.state.mode = mode; const read = await f.source.readNotificationReceiver(A, "notice"); assert.equal(read.consistentGeneration, false); assert.equal(read.ownership, null); assert.equal(f.calls.length, 2); }
  finally { await f.close(); }
});
for (const mode of ["redirect", "oversized", "slow"] as const) test(`receiver ${mode} remains bounded and never tries another source`, async () => {
  const f = await fixture();
  try {
    f.state.mode = mode;
    await assert.rejects(f.source.readNotificationReceiver(A, "notice", AbortSignal.timeout(100)));
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("cancelled or invalid receiver reads never start native requests", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.source.readNotificationReceiver(A, "notice", AbortSignal.abort()));
    await assert.rejects(f.source.readNotificationReceiver("display-name", "notice"));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

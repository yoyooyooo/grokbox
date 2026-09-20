import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { modelConfigurationRevision } from "@grokbox/runtime-kernel/model-management";
import { runModelChange } from "@grokbox/runtime-kernel/commands";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createManagementGateway, managedModelAdmission, modelConfigurationLayer, openRuntimeStore } from "../src/runtime.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-management-source-")), path = join(root, "gateway.json");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = { token: "private-synthetic-source-token", status: 200, calls: [] as Array<{ path: string; input: Record<string, unknown> }>,
    bots: [{ id: A, name: "First", harness: "box", isRunning: false, internalSecret: "private-synthetic-source-token" }, { id: B, name: "Group", isGroup: true }] as unknown,
    raw: null as string | null, stall: false };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${state.token}`) { response.writeHead(401).end(); return; }
    let text = "";
    for await (const chunk of request) text += chunk.toString();
    const input = JSON.parse(text);
    state.calls.push({ path: request.url!, input });
    if (state.status !== 200) { response.writeHead(state.status, { location: "https://off-box.invalid" }).end("private-error-body"); return; }
    response.setHeader("content-type", "application/json");
    if (state.stall) { response.write("["); return; }
    response.end(state.raw ?? JSON.stringify(request.url === "/api/listAgents" ? state.bots : { grokboxOwnership: ownedOwnershipSnapshot(input.grokboxOwnershipAgentIds) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture-address");
  const descriptor = { scheme: "http", host: "0.0.0.0", port: address.port, pid: process.pid, startedAt: 1, token: state.token };
  await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
  const gateway = createManagementGateway({ discoveryPath: path });
  return { root, path, state, descriptor, gateway };
}
const signal = () => new AbortController().signal;

test("native Bot projection is allowlisted and preserves missing observations as unknown", async () => {
  const f = await fixture();
  const before = await readFile(f.path, "utf8");
  const result = await f.gateway.listBots(signal());
  expect(result.bots).toEqual([{ id: A, name: "First", title: null, description: null, nativeHarness: "box", hidden: null,
    running: false, runningTurn: null, updatedAt: null, textTruncated: false, truncatedFields: [] }]);
  expect(result).toMatchObject({ coverage: "current-snapshot", source: { kind: "native-gateway", pid: process.pid, startedAt: 1 } });
  expect(JSON.stringify(result)).not.toContain(f.state.token);
  expect(f.state.calls).toEqual([{ path: "/api/listAgents", input: {} }]);
  expect(await readFile(f.path, "utf8")).toBe(before);
});

test("discovery is observed anew without retries or off-box fallback", async () => {
  const f = await fixture();
  const first = await f.gateway.listBots(signal());
  f.state.token = "rotated-synthetic-token";
  await writeFile(f.path, JSON.stringify({ ...f.descriptor, startedAt: 2, token: f.state.token }), { mode: 0o600 });
  const second = await f.gateway.listBots(signal());
  expect(second.source.generation).not.toBe(first.source.generation);
  expect(f.state.calls).toHaveLength(2);
  for (const host of ["192.168.1.1", "remote.invalid", "127.0.0.1@remote.invalid"]) {
    await writeFile(f.path, JSON.stringify({ ...f.descriptor, host }), { mode: 0o600 });
    await expect(f.gateway.listBots(signal())).rejects.toMatchObject({ code: "source_unavailable" });
  }
  expect(f.state.calls).toHaveLength(2);
});

test("native source failures and redirects remain failures, never empty-success snapshots", async () => {
  const f = await fixture();
  for (const status of [302, 401, 503]) {
    f.state.status = status;
    const error = await f.gateway.listBots(signal()).then(() => null, error => error);
    expect(error.code).toBe(status === 401 ? "source_unauthorized" : "source_unavailable");
    expect(error.message).not.toContain("private-error-body");
  }
  expect(f.state.calls).toHaveLength(3);
});

test("malformed, duplicated and oversized native observations are refused", async () => {
  const f = await fixture();
  for (const bots of [{ bots: [] }, [{ name: "no-id" }], [{ id: A, name: "First" }, { id: A.toUpperCase(), name: "Duplicate" }]]) {
    f.state.bots = bots;
    await expect(f.gateway.listBots(signal())).rejects.toMatchObject({ code: "source_invalid" });
  }
  for (const raw of ["{", " ".repeat(2 * 1024 * 1024 + 1)]) {
    f.state.raw = raw;
    await expect(f.gateway.listBots(signal())).rejects.toMatchObject({ code: "source_invalid" });
  }
});

test("native title bounds disclose truncation instead of returning unbounded text", async () => {
  const f = await fixture();
  f.state.bots = [{ id: A, name: "First", title: "x".repeat(2000) }];
  const result = await f.gateway.listBots(signal());
  expect(result.bots[0]?.title).toHaveLength(1024);
  expect(result.bots[0]?.textTruncated).toBe(true);
  expect(result.bots[0]?.truncatedFields).toEqual(["title"]);
});

test("ownership is a separate native call consumed by the production model admission program", async () => {
  const f = await fixture();
  const store = openRuntimeStore(f.root, {});
  await store.saveModels(applyUse(parseModelsFile(undefined), "stub/echo"));
  const result = await Effect.runPromise(runModelChange({ installationId: "33333333-3333-4333-8333-333333333333", principalId: "owner:local" }, {
    requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await store.loadModels()),
    change: { kind: "bot-selection", agentId: A, selection: { kind: "default" } },
  }, managedModelAdmission({ ownershipRead: f.gateway.ownershipRead, env: {} })).pipe(Effect.provide(modelConfigurationLayer(store))));
  expect(result.state).toBe("succeeded");
  expect(f.state.calls).toEqual([{ path: "/api/getHostStatus", input: { grokboxOwnershipAgentIds: [A] } }]);
  expect((await store.loadModels()).assignments.agents[A]).toEqual({ kind: "default" });
  await expect(f.gateway.ownershipRead([A, A], signal())).rejects.toMatchObject({ code: "source_invalid" });
  expect(f.state.calls).toHaveLength(1);
});

test("a stalled native response body is cancelled within the observation deadline", async () => {
  const f = await fixture(); f.state.stall = true;
  const gateway = createManagementGateway({ discoveryPath: f.path, timeoutMs: 50 });
  await expect(gateway.listBots(signal())).rejects.toMatchObject({ code: "source_timeout" });
  expect(f.state.calls).toHaveLength(1);
});

test("cancelled native observations do not send a request", async () => {
  const f = await fixture();
  await expect(f.gateway.listBots(AbortSignal.abort())).rejects.toMatchObject({ code: "source_timeout" });
  expect(f.state.calls).toHaveLength(0);
});

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { createModeldProduce } from "../src/internal/host/modeld-produce.node.ts";
import { createStreamingPromptSession, MANAGED_TOOL_POLICY } from "../src/internal/host/session.ts";
import { encodeModeldFrame, decodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";
import { projectFailureSummary, failureSummaryOf, streamFailureDiagnostic, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { traceAlerts, diagnoseExecution } from "@grokbox/runtime-kernel/alerts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { providerRuntimeFixture, waitFixtureRows, syntheticTool, successfulProviderResponse } from "./provider-runtime-fixture.ts";

for (const api of ["chat", "responses"] as const) for (const status of [401, 429, 502, 503, 504]) test(`production ${api} HTTP ${status} -> v5 Unix -> native-shaped error and same-STEP journal`, async () => {
  let calls = 0;
  const fetch = Object.assign(async () => { calls++; return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "PRIVATE_ERROR_BODY" } }), { status, headers: { "content-type": "application/json", "x-request-id": "fixture-http-id", "retry-after": "2" } }); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { api });
  try {
    const stepId = randomUUID(), handle = f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "fixture question" }]).stream({}, stepId, [syntheticTool]);
    const thrown = await handle.response.catch(e => e);
    expect(thrown).toBeInstanceOf(Error); expect(thrown.message).toContain(`HTTP ${status}`);
    expect(thrown.message).toContain("No tools were released by this STEP"); expect(thrown.message).not.toContain("PRIVATE_ERROR_BODY"); expect(calls).toBe(1);
    const summary = failureSummaryOf(thrown)!;
    expect(summary).toMatchObject({ identity: { agentId: f.agentId, turnId: f.turnId, stepId }, http: { status }, progress: { backendAttempts: 1, canonicalEvents: 0 } });
    const rows = await waitFixtureRows(f, stepId);
    const modeld = rows.find(e => e.name === "model_step_terminal" && e.stepId === stepId)!;
    const host = rows.find(e => e.name === "host_normalized_terminal" && e.stepId === stepId)!;
    expect(host.failureSummary.failureId).toBe(modeld.failureSummary.failureId);
    expect(host.failureSummary.http).toEqual(modeld.failureSummary.http);
    expect(diagnoseExecution(rows, { agentId: f.agentId, stepId })).toMatchObject({ state: "failure_observed", failureSummary: { http: { status } } });
    // The native decision observes the actual thrown Host error, not a manually
    // reconstructed summary. UI delivery remains an unproven downstream stage.
    const lifecycle: unknown[] = [];
    class NativeTray {
      trays: any[] = [];
      getTrays() { return this.trays; }
      emit(_event: unknown) {}
      pushError(tray: any) { this.trays.push({ ...tray, kind: "error" }); this.emit({ type: "pushed", tray: this.trays.at(-1) }); return this.trays.at(-1); }
    }
    const observer = createAlertObserver({ generation: host.hostGenerationId, emit: e => lifecycle.push(e) });
    const native = new NativeTray(); observer.attachManager(native);
    const trayId = randomUUID();
    observer.decision(thrown, { agentId: f.agentId, clientNonce: f.nonce }, true,
      () => native.pushError({ id: trayId, agentId: f.agentId, requestId: stepId, detail: thrown.message }));
    const traced = traceAlerts([...rows, ...lifecycle], { trayId }, { complete: true });
    expect(traced.traces[0]?.trays[0]).toMatchObject({ published: true, appRendered: "not_observed", executions: [{ failureSummary: { http: { status } } }] });
    expect(JSON.stringify(lifecycle)).not.toContain("PRIVATE_ERROR_BODY");
  } finally { await f.stop(); }
}, 10000);

test("pre-provider ownership refusal has the same bound summary path, without an invented POST", async () => {
  let calls = 0;
  const fetch = Object.assign(async () => { calls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead: null });
  try {
    const stepId = randomUUID(), handle = f.session.getExecutor([{ role: "system", content: "root" }, { role: "user", content: "q" }]).stream({}, stepId, [syntheticTool]);
    const thrown = await handle.response.catch(e => e);
    expect(calls).toBe(0); expect(thrown.stage).toBe("admit");
    expect(failureSummaryOf(thrown)).toMatchObject({ phase: "admission", code: "not_admitted", progress: { backendAttempts: 0 } });
  } finally { await f.stop(); }
});

test("old v4 modeld is rejected before run-step with an actionable local protocol message", async () => {
  const root = await mkdtemp(join(tmpdir(), "old-wire-peer-")), generation = randomUUID();
  let modelRequests = 0;
  const server = createServer(socket => {
    let bytes: Buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const frame = decodeModeldFrame(bytes); if (!frame || "error" in frame) return;
      if ((frame.value as any).method === "run-step") modelRequests++;
      socket.end(encodeModeldFrame({ ok: false, version: 4, error: { code: "unsupported_version" } }));
    });
  });
  await new Promise<void>(resolve => server.listen(join(root, "modeld.sock"), resolve));
  try {
    const producer = createModeldProduce({ runRoot: root, agentId: randomUUID(), turnId: randomUUID(), modelId: "openai/fixture", selectionRevision: "d".repeat(64),
      binding: { generationId: "a".repeat(64), activationId: "op", pid: 1, start: 1, sourceSha: "b".repeat(64), identitySha: "c".repeat(64) }, bridgeDigest: "e".repeat(64), profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    const handle = createStreamingPromptSession({ modelId: "openai/fixture", vision: false, parallel: MANAGED_TOOL_POLICY, produce: producer.produce })
      .stream({ envelope: buildHostEnvelope([{ role: "system", content: "root" }, { role: "user", content: "q" }]), invocationId: randomUUID() });
    const error = await handle.response.catch(e => e);
    expect(error.code).toBe("unsupported_version"); expect(error.message).toContain("incompatible protocol"); expect(error.stage).toBe("admit"); expect(modelRequests).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["missing", "invalid", "identity_mismatch", "valid"] as const) test(`bad error summary ${scenario} preserves the actual failure, no execution or new invalid-stream`, async () => {
  const root = await mkdtemp(join(tmpdir(), "failure-wire-")), generation = randomUUID();
  const agentId = randomUUID(), turnId = randomUUID(), stepId = randomUUID();
  let requests = 0;
  const server = createServer(socket => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]); const frame = decodeModeldFrame(buffer); if (!frame || "error" in frame) return;
      buffer = frame.rest; const request = frame.value as any;
      if (request.method === "health") { socket.end(encodeModeldFrame({ ok: true, method: "health", version: WIRE_VERSION, serverGeneration: generation })); return; }
      if (request.method !== "run-step") return;
      requests++;
      const summary = projectFailureSummary({ version: 1, code: "provider_error", phase: "provider", http: { status: 502 },
        identity: { agentId: scenario === "identity_mismatch" ? randomUUID() : agentId, turnId, stepId, hostGenerationId: "a".repeat(64), serviceEpoch: generation, bindingId: "binding" },
        progress: { canonicalEvents: 0, backendAttempts: 1 } });
      socket.write(encodeModeldFrame({ ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "binding" }));
      socket.end(encodeModeldFrame({ kind: "terminal", version: WIRE_VERSION, outcome: "error", code: "provider_error",
        ...(scenario === "missing" ? {} : { failure: scenario === "invalid" ? { version: 99, message: "PRIVATE_ERROR_BODY" } : summary }) }));
    });
  });
  await new Promise<void>(resolve => server.listen(join(root, "modeld.sock"), resolve));
  try {
    const produce = createModeldProduce({ runRoot: root, agentId, turnId, modelId: "openai/fixture", selectionRevision: "d".repeat(64),
      binding: { generationId: "a".repeat(64), activationId: "op", pid: 1, start: 1, sourceSha: "b".repeat(64), identitySha: "c".repeat(64) }, bridgeDigest: "e".repeat(64), profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    const session = createStreamingPromptSession({ modelId: "openai/fixture", vision: false, parallel: MANAGED_TOOL_POLICY, produce: produce.produce });
    const handle = session.stream({ envelope: buildHostEnvelope([{ role: "system", content: "root" }, { role: "user", content: "q" }], [syntheticTool]), invocationId: stepId });
    const thrown = await handle.response.catch(e => e);
    expect(thrown).toMatchObject({ code: "model_error" }); expect(requests).toBe(1); expect(thrown.message).not.toContain("PRIVATE_ERROR_BODY");
    expect(streamFailureDiagnostic(thrown)?.failureSummaryStatus).toBe(scenario === "valid" ? "direct" : scenario === "missing" ? "absent" : scenario);
    if (scenario === "valid") expect(thrown.message).toContain("HTTP 502"); else expect(thrown.message).not.toContain("HTTP 502");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

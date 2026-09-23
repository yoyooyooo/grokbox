import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { WIRE_VERSION, contextSnapshotBody, failureSummaryOf, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";
import { projectSendOutcome } from "../../cli/src/outcome.ts";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { providerRuntimeFixture, waitFixtureRows, syntheticTool, successfulProviderResponse } from "./provider-runtime-fixture.ts";

const nativeScope = { backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "synthetic" };
const secret = "PRIVATE_AUTHORITY_SOURCE_SENTINEL";

test("source cancellation cause and waiter identities survive Unix, Host, journal, SQLite cold read and CLI projection", async () => {
  const native = bindHostOwnershipRead();
  let modelCalls = 0, sourceCalls = 0;
  const started = performance.now(), stages: Array<{stage: string; elapsedMs: number}> = [];
  const mark = (stage: string) => stages.push({ stage, elapsedMs: Math.round(performance.now() - started) });
  const diagnostic = () => ({ suite: "authority-cancellation-stages", stages, elapsedMs: Math.round(performance.now() - started), sourceCalls, modelCalls });
  const warning = setTimeout(() => console.error(JSON.stringify(diagnostic())), 14000);
  mark("fixture-start");
  const invoke = async (ids: string[], localOnly = false) => ({ gateway: { pid: process.pid, startedAt: 1 },
    snapshot: await native({ agentIds: ids, localOnly, readScope: () => nativeScope,
      readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
      readLocal: () => ({ harness: "box", serverId: "server" }),
      listServer: async () => { sourceCalls++; throw Object.assign(new Error(secret), { code: 1, response: secret }); } }) });
  const source: OwnershipReader = ids => invoke(ids);
  source.local = ids => invoke(ids, true);
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead: source });
  mark("fixture-ready");
  const epoch = randomUUID(), monitor = openMonitorStore(join(f.durableRoot, "observations"));
  let initialized = false;
  try {
    const stepId = randomUUID();
    const handle = f.session.getExecutor([{ role: "system", content: "synthetic" }, { role: "user", content: "request" }]).stream({}, stepId, [syntheticTool]);
    mark("response-await");
    const error = await handle.response.catch(e => e);
    mark("response-settled");
    const summary = failureSummaryOf(error)!;
    expect(sourceCalls).toBe(2); expect(modelCalls).toBe(0);
    const authority = summary.diagnostic?.authority;
    expect(authority).toMatchObject({ reason: "server_read_unavailable", checkpoint: "admission",
      ownershipRead: { errorCode: "source_cancelled", rpcCode: 1, cancellationOrigin: "transport_unknown" },
      ownershipWait: { state: "source", outcome: "source_failure", sourceSettlement: "settled" },
      readRecovery: { attempts: 2, firstReadCode: "source_cancelled", lastReadCode: "source_cancelled" } });
    expect(authority?.ownershipWait?.waiterId).toMatch(/^[0-9a-f-]{36}$/);
    expect(authority?.ownershipWait?.sourceOperationId).toMatch(/^[0-9a-f-]{36}$/);
    mark("journal-await");
    let rows = await waitFixtureRows(f, stepId);
    mark("journal-settled");
    for (let n = 0; n < 100 && !rows.some(e => e.name === "host_stream_rejected" && e.stepId === stepId); n++) {
      await new Promise(resolve => setTimeout(resolve, 5)); rows = await f.rows();
    }
    for (const name of ["model_step_terminal", "host_stream_rejected", "host_normalized_terminal"]) {
      expect(rows.find(e => e.name === name && e.stepId === stepId)?.failureSummary?.diagnostic?.authority).toEqual(authority);
    }
    mark("monitor-initialize");
    await monitor.initialize(); await monitor.begin(epoch, Date.now(), [f.agentId]); initialized = true;
    await monitor.ingestEvidence({ epoch, sourceKey: "b".repeat(64), expectedCursor: null, nextCursor: "one", events: rows, atMs: Date.now() });
    const bytes = await readFile(monitor.path);
    const cold = openMonitorStore(join(f.durableRoot, "observations"));
    mark("cold-read");
    const retained = await cold.executionEvidence({ agentId: f.agentId, stepId });
    mark("cold-read-complete");
    const projected = projectSendOutcome({ agentId: f.agentId, stepId, entries: [], alerts: [], truncated: false, runtimeEvents: retained.events });
    expect(projected.state).toBe("failed");
    expect(projected.runtimeAuthority).toMatchObject({ currentLiveness: "not_proven", replayAuthorized: false,
      state: { phase: "denied", diagnostic: authority } });
    expect(await readFile(monitor.path)).toEqual(bytes);
    expect(JSON.stringify(retained)).not.toContain(secret);
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
  } finally {
    mark("cleanup");
    try { if (initialized) await monitor.finish(epoch, Date.now()); await f.stop(); }
    finally { clearTimeout(warning); mark("closed"); console.log(JSON.stringify(diagnostic())); }
  }
}, 15000);

test("a stalled authority journal is bounded and does not consume execution time or block successful STEPs", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-observer-")), epoch = randomUUID();
  const models = parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: { fixture: { modelId: STUB_ECHO_MODEL_ID } } } });
  const selection = captureManagedSelection(models, "fixture"); if (selection.kind !== "managed") throw Error("fixture");
  const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [], messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
  const request: RunStepRequest = { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v6" },
    serviceEpoch: { incarnationId: epoch }, agentId: "fixture", turnId: "turn", stepId: "step",
    selection: { agentId: "fixture", modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
  const counts = createCountedSeams(), resources = emptyResourceCounts();
  const outcomes: Array<{ outcome: string; authorityObservationGaps?: number }> = [];
  let observationStarted = 0, observationFinished = 0;
  const graph = fakeConfigurationReadLayer({ models: () => models }).pipe(
    Layer.merge(fakeBackendAuthLayer("synthetic", counts)), Layer.merge(fakeAdmissionAuthorityLayer()),
    Layer.merge(fakeModelBackendLayer([{ type: "backend_finish", finishReason: "stop" }], counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch })),
  );
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* serveModeld({ path: join(root, "modeld.sock"), generation: epoch, counts: resources,
        observeAuthority: () => Effect.gen(function* () { observationStarted++; yield* Effect.sleep("20 seconds"); observationFinished++; }),
        observeStep: (_request, result) => Effect.sync(() => { outcomes.push(result); }),
      });
      // TestClock never advances: a synchronous observer would keep this path
      // stuck. The real Unix client timeout is only an independent test oracle.
      for (let index = 0; index < 16; index++) {
        const frames = yield* Effect.tryPromise(() => requestModeld(root, { ...request, turnId: `turn-${index}`, stepId: `step-${index}`, version: WIRE_VERSION, method: "run-step" }, 2000));
        expect(frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "ok" });
      }
      expect(observationStarted).toBe(1); expect(observationFinished).toBe(0);
      expect(counts.network).toBe(16);
      expect(outcomes.some(row => (row.authorityObservationGaps ?? 0) > 0)).toBe(true);
    }).pipe(Effect.provide(graph), Effect.provide(TestClock.layer()))));
    expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
    expect(counts.leasesAlive).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

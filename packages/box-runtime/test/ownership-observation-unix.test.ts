import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { failureSummaryOf, streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { diagnoseExecution, traceAlerts } from "@grokbox/runtime-kernel/alerts";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { readManagedOwnership, type OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { providerRuntimeFixture, waitFixtureRows, successfulProviderResponse, syntheticTool } from "./provider-runtime-fixture.ts";
import { captureCli, parseJson } from "../../../test/helpers.ts";

const PRIVATE = "PRIVATE_OWNERSHIP_RESPONSE_SENTINEL";
const scope = { backend: "https://fixture.invalid", account: "a".repeat(64), machine: "synthetic-machine", team: null };
const agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function ports(agentIds: string[], listServer: (signal: AbortSignal) => Promise<unknown>) {
  return { agentIds, listServer, readLocal: () => ({ harness: "box", serverId: "s1" }),
    readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }), readScope: () => scope };
}
const failureCases = [
  { name: "authentication", code: 16, errorCode: "authorization_unavailable" },
  { name: "access", code: 7, errorCode: "authorization_unavailable" },
  { name: "unsupported", code: 12, errorCode: "unsupported_rpc" },
  { name: "rpc-failure", code: 14, errorCode: "server_read_failed" },
  { name: "malformed", code: undefined, errorCode: "invalid_response" },
  { name: "timeout", code: undefined, errorCode: "timeout" },
] as const;

for (const scenario of failureCases) test(`native ownership ${scenario.name} -> real admission -> v5 Unix -> Host -> journal -> offline incident`, async () => {
  const read = bindHostOwnershipRead({ timeoutMs: 20 });
  let serverCalls = 0, providerCalls = 0;
  const ownershipRead: OwnershipReader = async ids => ({ gateway: { pid: process.pid, startedAt: 1 }, snapshot: await read(ports(ids, async () => {
    serverCalls++;
    if (scenario.name === "timeout") return new Promise(() => undefined);
    if (scenario.name === "malformed") return { agents: PRIVATE };
    throw Object.assign(new Error(PRIVATE), { code: scenario.code, response: PRIVATE });
  })) });
  const fetch = Object.assign(async () => { providerCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead });
  try {
    const stepId = randomUUID();
    const handle = f.session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "synthetic request" }]).stream({}, stepId, [syntheticTool]);
    const error = await handle.response.catch(e => e);
    expect(providerCalls).toBe(0); expect(serverCalls).toBe(scenario.name === "rpc-failure" ? 2 : 1);
    const expected = { reason: "server_read_unavailable", checkpoint: "admission", waitBudgetMs: 10000,
      ownershipRead: { state: "unavailable", errorCode: scenario.errorCode, phase: "server", serverRead: "request", deadlineMs: 20 } };
    expect(streamFailureDiagnostic(error)?.authority).toMatchObject(expected);
    const summary = failureSummaryOf(error)!;
    expect(summary).toMatchObject({ code: "not_admitted", category: "authority", phase: "admission",
      diagnostic: { authority: expected }, progress: { canonicalEvents: 0, backendAttempts: 0 }, identity: { agentId: f.agentId, stepId } });
    if (scenario.code !== undefined) expect(summary.diagnostic?.authority?.ownershipRead?.rpcCode).toBe(scenario.code);
    expect(error.message).toContain(`Ownership-read detail: ${scenario.errorCode}`);
    expect(error.message).toContain("No model request was dispatched by this STEP");
    expect(error.message).not.toContain(PRIVATE);
    let rows = await waitFixtureRows(f, stepId);
    // Host rejection and normalized terminal have independent bounded writers;
    // seeing the two terminal rows does not prove the third append has settled.
    const deadline = Date.now() + 2500;
    while (!rows.some(row => row.name === "host_stream_rejected" && row.stepId === stepId) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10)); rows = await f.rows();
    }
    for (const name of ["model_step_terminal", "host_stream_rejected", "host_normalized_terminal"]) {
      expect(rows.find(row => row.name === name && row.stepId === stepId)).toMatchObject({
        failureSummary: { failureId: summary.failureId, diagnostic: { authority: expected } },
      });
    }
    expect(diagnoseExecution(rows, { agentId: f.agentId, stepId })).toMatchObject({ state: "failure_observed", diagnostic: { authority: expected } });
    // Freeze actual production-written evidence for the read-only CLI oracle.
    // An active journal can still receive earlier asynchronous seam observations;
    // their arrival during a query is not a write performed by that query.
    const offlineRoot = join(f.durableRoot, "offline-run");
    await mkdir(join(offlineRoot, "log"), { recursive: true });
    const file = join(offlineRoot, "log/events.ndjson"), before = await readFile(join(f.runRoot, "log/events.ndjson"), "utf8");
    await writeFile(file, before);
    const result = await captureCli(["runtime", "incident", stepId, "--agent", f.agentId], {
      configDir: join(f.durableRoot, "no-config"), env: { GROKBOX_RUN_ROOT: offlineRoot }, discoveryPath: join(f.runRoot, "NO_GATEWAY"),
      daemonSocket: join(f.runRoot, "NO_DAEMON"), transport: "local", boxRuntimeRoot: f.durableRoot, stdinIsTTY: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { state: "failed", replayAuthorized: false, runtimeFailure: { diagnostic: { authority: expected } } } });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(result.stdout).not.toContain(PRIVATE);

    // Actual thrown error enters the native-shaped alert branch. No browser or
    // real user notification is used or claimed by this local integration test.
    if (scenario.name === "authentication") {
      const lifecycle: unknown[] = [];
      class NativeTray {
        trays: any[] = [];
        getTrays() { return this.trays; }
        emit(_event: unknown) {}
        pushError(tray: any) { this.trays.push({ ...tray, kind: "error" }); this.emit({ type: "pushed", tray: this.trays.at(-1) }); return this.trays.at(-1); }
      }
      const host = rows.find(row => row.name === "host_normalized_terminal" && row.stepId === stepId)!;
      const observer = createAlertObserver({ generation: host.hostGenerationId, emit: e => lifecycle.push(e) });
      const native = new NativeTray(), trayId = randomUUID(); observer.attachManager(native);
      observer.decision(error, { agentId: f.agentId, clientNonce: f.nonce }, true,
        () => native.pushError({ id: trayId, agentId: f.agentId, requestId: stepId, detail: error.message }));
      const all = [...rows, ...lifecycle];
      const trace = traceAlerts(all, { trayId }, { complete: true });
      expect(trace.traces[0]?.trays[0]).toMatchObject({ published: true, appRendered: "not_observed",
        executions: [{ failureSummary: { diagnostic: { authority: expected } } }] });
      const monitorRoot = join(f.durableRoot, "private-monitor");
      const store = openMonitorStore(monitorRoot), epoch = randomUUID(), now = Date.now();
      await store.initialize(); await store.begin(epoch, now, [f.agentId]);
      await store.ingestEvidence({ epoch, sourceKey: "b".repeat(64), expectedCursor: null, nextCursor: "1", events: all, atMs: now + 1 });
      const cold = openMonitorStore(monitorRoot), bytes = await readFile(store.path);
      const indexed = await cold.executionEvidence({ agentId: f.agentId, stepId });
      expect(diagnoseExecution(indexed.events, { agentId: f.agentId, stepId })).toMatchObject({ diagnostic: { authority: expected } });
      expect((await cold.alertTrace({ trayId })).traces[0]?.trays[0]).toMatchObject({ executions: [{ failureSummary: { diagnostic: { authority: expected } } }] });
      const monitorIncident = await captureCli(["runtime", "incident", stepId, "--agent", f.agentId, "--from", "monitor"], {
        configDir: join(monitorRoot, "no-config"), env: { GROKBOX_RUN_ROOT: f.runRoot }, discoveryPath: join(f.runRoot, "NO_GATEWAY"),
        daemonSocket: join(f.runRoot, "NO_DAEMON"), transport: "local", boxRuntimeRoot: monitorRoot, stdinIsTTY: true,
      });
      expect(monitorIncident.code, monitorIncident.stderr).toBe(0);
      expect(parseJson(monitorIncident.stdout)).toMatchObject({ data: { state: "failed", replayAuthorized: false,
        runtimeFailure: { diagnostic: { authority: expected } } } });
      expect(await readFile(store.path)).toEqual(bytes);
      expect(bytes.includes(Buffer.from(PRIVATE))).toBe(false);
      await store.finish(epoch, now + 2);
    }
  } finally { await f.stop(); }
}, 15000);

test("post-provider authority refusal retains its true checkpoint and never claims no model dispatch", async () => {
  const read = bindHostOwnershipRead();
  let dispatched = false, providerCalls = 0;
  const ownershipRead: OwnershipReader = async ids => ({ gateway: { pid: process.pid, startedAt: 1 }, snapshot: await read(ports(ids, async () => {
    if (dispatched) throw Object.assign(new Error(PRIVATE), { code: 14 });
    return { agents: ids.map(agentId => ({ agentId, id: "s1", harness: "box" })) };
  })) });
  const fetch = Object.assign(async () => { dispatched = true; providerCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead });
  try {
    const stepId = randomUUID(), handle = f.session.getExecutor([{ role: "system", content: "root" }, { role: "user", content: "q" }]).stream({}, stepId, [syntheticTool]);
    const error = await handle.response.catch(e => e);
    expect(providerCalls).toBe(1);
    expect(failureSummaryOf(error)).toMatchObject({ phase: "authority", progress: { backendAttempts: 1 },
      diagnostic: { authority: { checkpoint: "tool_start", ownershipRead: { errorCode: "server_read_failed", rpcCode: 14 } } } });
    expect(error.message).not.toContain("No model request was dispatched");
    expect(error.message).toContain("No tools were released by this STEP");
  } finally { await f.stop(); }
});

test("a Gateway exception is not invented as a server RPC failure", async () => {
  const result = await Effect.runPromise(Effect.result(readManagedOwnership({ agentId: agent, read: async () => { throw Error(PRIVATE); } })));
  expect(result._tag).toBe("Failure"); if (result._tag !== "Failure") throw Error("fixture");
  expect(streamFailureDiagnostic(result.failure)).toMatchObject({ authority: { reason: "ownership_read_unavailable", waitBudgetMs: 10000 } });
  expect(streamFailureDiagnostic(result.failure)?.authority?.ownershipRead).toBeUndefined();
});

for (const phase of ["scope_before", "server", "scope_after"] as const) test(`native read timeout records the actual ${phase} boundary`, async () => {
  let reads = 0;
  const pending = new Promise<never>(() => undefined);
  const read = bindHostOwnershipRead({ timeoutMs: 10 });
  const snapshot = await read({ ...ports([agent], async () => phase === "server" ? pending : { agents: [] }),
    readScope: () => { reads++; return phase === "scope_before" || phase === "scope_after" && reads === 2 ? pending : scope; } });
  expect(snapshot).toMatchObject({ state: "unavailable", errorCode: "timeout", readObservation: {
    state: "unavailable", errorCode: "timeout", phase, serverRead: phase === "scope_before" ? "not_started" : "request", deadlineMs: 10,
  } });
});

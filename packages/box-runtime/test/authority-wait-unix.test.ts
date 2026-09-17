import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { failureSummaryOf, projectAuthorityProgress } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";
import { providerRuntimeFixture, waitFixtureRows, successfulProviderResponse, syntheticTool } from "./provider-runtime-fixture.ts";

const nativeScope = { backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "synthetic" };
function readerFor(list: (ids: string[], signal: AbortSignal) => Promise<unknown>, withLocal = true): OwnershipReader {
  const native = bindHostOwnershipRead();
  const read = async (ids: string[], _signal: AbortSignal, localOnly = false) => ({ gateway: { pid: process.pid, startedAt: 1 },
    snapshot: await native({ agentIds: ids, localOnly, listServer: signal => list(ids, signal), readScope: () => nativeScope,
      readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
      readLocal: () => ({ harness: "box", serverId: "server" }) }) });
  const source: OwnershipReader = (ids, signal) => read(ids, signal);
  if (withLocal) source.local = (ids, signal) => read(ids, signal, true);
  return source;
}
const serverRows = (ids: string[]) => ({ agents: ids.map(agentId => ({ agentId, id: "server", harness: "box" })) });
const input = [{ role: "system" as const, content: "Synthetic root" }, { role: "user" as const, content: "Synthetic request" }];

for (const afterDispatch of [false, true]) test(`production v6 ${afterDispatch ? "post-inference" : "pre-dispatch"} source recovery preserves one STEP and one model call`, async () => {
  let sourceCalls = 0, modelCalls = 0, failed = false;
  const source = readerFor(async ids => {
    sourceCalls++;
    if (!failed && (!afterDispatch || modelCalls > 0)) { failed = true; throw Object.assign(new Error("PRIVATE_SOURCE_SENTINEL"), { code: 14 }); }
    return serverRows(ids);
  }, !afterDispatch);
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead: source });
  try {
    const stepId = randomUUID();
    const handle = f.session.getExecutor(input).stream({}, stepId, [syntheticTool]);
    const response = await handle.response;
    expect(response.finishReason).toBe("tool-calls"); expect(modelCalls).toBe(1); expect(failed).toBe(true);
    if (!afterDispatch) expect(sourceCalls).toBe(2);
    const rows = await waitFixtureRows(f, stepId);
    const terminal = rows.filter(e => e.name === "model_step_terminal" && e.stepId === stepId);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ outcome: "ok", backendAttempts: 1 });
    expect(rows.find(e => e.name === "host_normalized_terminal" && e.stepId === stepId)?.toolCallCount).toBe(1);
    const progress = rows.filter(e => e.name === "model_authority_progress" && e.stepId === stepId).map(e => projectAuthorityProgress(e.authority));
    expect(progress.some(p => p?.phase === "waiting")).toBe(true);
    expect(progress.some(p => p?.phase === "authorized" && p.retries === 1)).toBe(true);
    expect(rows.some(e => e.name === "host_stream_rejected" && e.stepId === stepId)).toBe(false);
    expect(JSON.stringify(response)).not.toContain("strict-observation");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_SOURCE_SENTINEL");
  } finally { await f.stop(); }
}, 10000);

test("explicit source access rejection is not retried and progress cannot grant execution", async () => {
  let sourceCalls = 0, modelCalls = 0;
  const ownershipRead = readerFor(async () => { sourceCalls++; throw Object.assign(new Error("PRIVATE_AUTH_SENTINEL"), { code: 16 }); });
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead });
  try {
    const stepId = randomUUID(), handle = f.session.getExecutor(input).stream({}, stepId, [syntheticTool]);
    const error = await handle.response.catch(e => e);
    expect(sourceCalls).toBe(1); expect(modelCalls).toBe(0);
    expect(failureSummaryOf(error)).toMatchObject({ category: "authority", progress: { backendAttempts: 0 },
      diagnostic: { authority: { checkpoint: "admission", ownershipRead: { errorCode: "authorization_unavailable" } } } });
    const rows = await waitFixtureRows(f, stepId);
    expect(rows.filter(e => e.name === "model_step_terminal" && e.stepId === stepId)).toHaveLength(1);
    // The journal worker is asynchronous. The terminal's own snapshot is the
    // reliable settled observation; its separate progress append may arrive later.
    expect(rows.find(e => e.name === "model_step_terminal" && e.stepId === stepId)?.authority?.phase).toBe("denied");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_AUTH_SENTINEL");
  } finally { await f.stop(); }
}, 10000);

test("disconnect during initial admission ends the request without a late model dispatch", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let modelCalls = 0;
  const ownershipRead = readerFor(async ids => { enter(); await held; return serverRows(ids); });
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead }), abort = new AbortController();
  try {
    const stepId = randomUUID(), handle = f.session.getExecutor(input).stream({ abortSignal: abort.signal }, stepId, [syntheticTool]);
    await entered; abort.abort();
    await handle.response.catch(() => undefined);
    release();
    const rows = await waitFixtureRows(f, stepId);
    expect(modelCalls).toBe(0);
    expect(rows.find(e => e.name === "model_step_terminal" && e.stepId === stepId)?.backendAttempts).toBe(0);
  } finally { release(); abort.abort(); await f.stop(); }
}, 10000);

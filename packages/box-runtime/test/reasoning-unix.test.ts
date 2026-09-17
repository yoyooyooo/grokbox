import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyUse } from "@grokbox/runtime-kernel/selection";
import { WIRE_VERSION, WireError } from "@grokbox/runtime-kernel/contract";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { acceptModeldFrame, clientSessionFor, parseModeldRequest } from "../src/internal/wire/modeld-wire.ts";
import { providerRuntimeFixture, waitFixtureRows, syntheticTool } from "./provider-runtime-fixture.ts";
import { reasoningModel, reasoningResponse } from "./reasoning-fixture.ts";
for (const api of ["chat", "responses"] as const) test(`${api}: Host hook, disk selection, real Unix and modeld preserve policy and outcome usage`, async () => {
  const sent: Array<Record<string, any>> = [];
  const fetch = Object.assign(async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return reasoningResponse(api); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { api, record: reasoningModel(api), reasoning: { effort: "high" } });
  try {
    const store = openRuntimeStore(f.durableRoot, {});
    const state = [{ role: "system", content: "owned root" }, { role: "user", content: "owned question" }];
    const executor = f.session.getExecutor(state);
    const firstStep = randomUUID(), first = executor.stream({}, firstStep, [syntheticTool], { maxTokens: 100 });
    await first.response;
    expect(await first.usage).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 12 });
    const rows = await waitFixtureRows(f, firstStep);
    const modeld = rows.find(row => row.name === "model_step_terminal" && row.stepId === firstStep)!;
    expect(modeld).toMatchObject({ outcome: "ok", modelId: f.modelId, selectionRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 12 },
      stream: { reasoning: { requested: "high", emitted: "high", providerReported: "unknown" } } });
    await store.saveModels(applyUse(await store.loadModels(), f.modelId, f.agentId, { effort: "xhigh" }));
    await executor.stream({}, randomUUID(), [syntheticTool], { maxTokens: 100 }).response;
    const next = f.newSession(); expect(next.getModelId()).toBe(f.session.getModelId());
    await next.getExecutor(state).stream({}, randomUUID(), [syntheticTool], { maxTokens: 100 }).response;
    await store.saveModels(applyUse(await store.loadModels(), f.modelId, f.agentId));
    await f.newSession().getExecutor(state).stream({}, randomUUID(), [syntheticTool], { maxTokens: 100 }).response;
    expect(sent.map(body => api === "chat" ? body.reasoning_effort : body.reasoning?.effort)).toEqual(["high", "high", "xhigh", undefined]);
    expect(new Set(sent.map(body => body.model))).toEqual(new Set(["grok-4.6"]));
    expect(sent).toHaveLength(4);
    expect(Object.keys((await store.loadModels()).models)).toEqual([f.modelId]);
  } finally { await f.stop(); }
}, 15000);
test("wire v7 preserves reasoning usage and rejects inconsistent subsets and older execution", () => {
  expect(WIRE_VERSION).toBe(7);
  for (const version of [3, 4, 5, 6]) expect(() => parseModeldRequest({ version, method: "run-step" })).toThrow(WireError);
  const session = acceptModeldFrame(clientSessionFor({ method: "run-step" }), { ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "binding" }).session;
  const terminal = { kind: "terminal", outcome: "ok", bindingId: "binding", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 12 } };
  expect(acceptModeldFrame(session, terminal).done).toBe(true);
  for (const reasoningTokens of [-1, 21, 1.5, "12"]) expect(() => acceptModeldFrame(session, { ...terminal, usage: { ...terminal.usage, reasoningTokens } })).toThrow(WireError);
});

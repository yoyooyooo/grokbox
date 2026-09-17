import { expect, test } from "bun:test";
import { createStreamingPromptSession, asHostPromptSession, type SessionTerminal, type StreamPart } from "../src/internal/host/session.ts";
import { runAuxiliary } from "../src/internal/host/auxiliary.ts";
import type { GrokboxAuxRequest } from "../src/internal/host/aux-request.ts";

const parent = { agentId: "fixture-agent", turnId: "fixture-turn", stepId: "parent-step", modelId: "fixture-model", selectionRevision: "fixture-revision" };
const makeAux = (purpose: "memory-extraction" | "episode"): GrokboxAuxRequest => ({ purpose, auxRequestId: `aux-${purpose}`, parent });
const usage = { promptTokens: 4, completionTokens: 8, totalTokens: 12 };
function scenario(options: { purpose?: "memory-extraction" | "episode"; tools?: boolean; finish?: "stop" | "abort" | "none"; malformed?: boolean } = {}) {
  let terminal: SessionTerminal | undefined;
  const session = createStreamingPromptSession({ modelId: parent.modelId, vision: false, parallel: "fail-closed", onTerminal: value => { terminal = value; },
    produce: async function* () {
      yield { type: "reasoning", textDelta: "<think>synthetic no new facts</think>" } as const;
      yield { type: "text-delta", textDelta: " \n" } as const;
      if (options.finish !== "none") yield { type: "finish", reason: options.finish ?? "stop", usage } as const;
    } });
  const aux = options.purpose ? makeAux(options.purpose) : undefined;
  if (aux && options.malformed) aux.parent = { ...parent, stepId: "" };
  const handle = session.stream({ envelope: { version: 1, messages: [{ role: "user", content: "memory-extraction is text here, not authority" }],
    tools: options.tools ? [{ name: "SendToUser", inputSchema: { type: "object" } }] : [], options: {} }, ...(aux ? { aux } : {}) });
  return { handle, terminal: () => terminal };
}
for (const purpose of ["memory-extraction", "episode"] as const) {
  test(`${purpose} complete blank answer is a no-op, never synthetic delivery or memory text`, async () => {
    const { handle, terminal } = scenario({ purpose });
    const response = await handle.response;
    expect(response.finishReason).toBe("stop");
    const parts: StreamPart[] = []; for await (const part of handle.fullStream) parts.push(part);
    expect(parts.some(part => part.type === "tool-call")).toBe(false);
    expect(parts.filter(part => part.type === "text-delta").map(part => part.textDelta).join("").trim()).toBe("");
    expect(terminal()).toMatchObject({ terminalClass: "stop", toolCallCount: 0, purpose,
      diagnostic: { stream: { counts: { auxiliaryEmptyCompletions: 1 } } } });
    expect(terminal()?.diagnostic?.stream?.counts.syntheticDeliveries).toBeUndefined();
  });
}
for (const [label, options] of [
  ["main with no tools", {}], ["main with delivery tool", { tools: true }],
  ["aux with tools", { purpose: "memory-extraction", tools: true }],
  ["unqualified aux", { purpose: "memory-extraction", malformed: true }],
  ["aux missing finish", { purpose: "memory-extraction", finish: "none" }],
] as const) test(`${label} retains strict empty/unfinished rejection`, async () => {
  const { handle, terminal } = scenario(options);
  await expect(handle.response).rejects.toBeDefined();
  expect(terminal()?.terminalClass).toBe("error");
});
test("aux cancellation is not a successful empty completion", async () => {
  const { handle, terminal } = scenario({ purpose: "memory-extraction", finish: "abort" });
  expect((await handle.response).finishReason).toBe("abort");
  expect(terminal()?.diagnostic?.stream?.counts.auxiliaryEmptyCompletions).toBeUndefined();
});
test("aux outcome adapter distinguishes completed empty from failure and cannot commit reasoning", async () => {
  const session = asHostPromptSession(createStreamingPromptSession({ modelId: parent.modelId, vision: false, parallel: "fail-closed",
    produce: async function* () {
      yield { type: "reasoning", textDelta: "synthetic private reasoning" };
      yield { type: "finish", reason: "stop", usage };
    } }), parent.modelId, undefined, { requireStepId: true, contextWindowTokens: 10000 });
  const outcome = await runAuxiliary({ session, purpose: "memory-extraction", auxRequestId: "aux-empty", parent, parentLive: true, seen: new Set(),
    messages: [{ role: "system", content: "synthetic memory fixture" }, { role: "user", content: "nothing durable" }] });
  expect(outcome).toEqual({ kind: "empty", purpose: "memory-extraction", auxRequestId: "aux-empty" });
});

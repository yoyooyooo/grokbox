import { expect, test } from "bun:test";
import { createStreamingPromptSession, MANAGED_TOOL_POLICY, type SessionTerminal, type StreamPart } from "../src/internal/host/session.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { projectHostNormalizedTerminal } from "../src/internal/host/terminal-journal.node.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";

const tools = [{ name: "lookup", inputSchema: { type: "object" } }, { name: "record", inputSchema: { type: "object" } }];
const STOP: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
const start = (id: string, name = "lookup"): StreamPart => ({ type: "tool-call-streaming-start", toolCallId: id, toolName: name });
const delta = (id: string, text: string, name = "lookup"): StreamPart => ({ type: "tool-call-delta", toolCallId: id, toolName: name, argsTextDelta: text });
const call = (id: string, args: Record<string, number | string | boolean> = {}, name = "lookup") => ({ type: "tool-call" as const, toolCallId: id, toolName: name, args });
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function read(stream: AsyncIterable<StreamPart>) { const parts: StreamPart[] = []; for await (const p of stream) parts.push(p); return parts; }
function setup(parts: StreamPart[], options: { gate?: ReturnType<typeof latch>; reached?: ReturnType<typeof latch>; signal?: AbortSignal; parallel?: boolean; omitFinish?: boolean; fail?: boolean; maxParts?: number } = {}) {
  const terminals: SessionTerminal[] = [], requests = { count: 0 };
  const session = createStreamingPromptSession({ modelId: "synthetic/test", vision: false, parallel: MANAGED_TOOL_POLICY,
    providerCalls: requests, maxParts: options.maxParts, onTerminal: t => terminals.push(t),
    produce: async function* (request) {
      expect(request.envelope.options.parallelToolCalls).toBe(options.parallel ?? false);
      for (const p of parts) yield p;
      options.reached?.resolve(); if (options.gate) await options.gate.promise;
      if (options.fail) throw new Error("PRIVATE_PROVIDER_ERROR");
      if (!options.omitFinish) yield STOP;
    },
  });
  const handle = session.stream({ invocationId: "batch-step", abortSignal: options.signal,
    envelope: buildHostEnvelope([{ role: "user", content: "synthetic" }], tools, options.parallel === undefined ? {} : { parallelToolCalls: options.parallel }) });
  return { handle, terminals, requests };
}

for (const parallel of [undefined, false, true]) test(`validated native batch accepts two calls with generation preference ${parallel}`, async () => {
  const gate = latch(), reached = latch();
  const parts = [start("one"), start("two", "record"), delta("two", '{"n":2}', "record"), call("two", { n: 2 }, "record"), delta("one", '{"n":1}'), call("one", { n: 1 })];
  const f = setup(parts, { gate, reached, parallel });
  const seen: StreamPart[] = []; const consuming = (async () => { for await (const p of f.handle.fullStream) seen.push(p); })();
  await reached.promise;
  try { expect(seen).toEqual([]); expect(f.terminals).toHaveLength(0); } finally { gate.resolve(); }
  await consuming;
  const response = await f.handle.response;
  // A first-seen call finishing last must not swap either the replay or history order.
  expect(seen.filter(p => p.type.startsWith("tool-call"))).toEqual([parts[0], parts[4], parts[5], parts[1], parts[2], parts[3]]);
  expect(response.messages[0]?.content).toEqual([call("one", { n: 1 }), call("two", { n: 2 }, "record")]);
  expect(response.finishReason).toBe("tool-calls");
  expect(f.terminals).toMatchObject([{ terminalClass: "stop", toolCallCount: 2, diagnostic: { stream: {
    hostToolPolicy: "validated-batch", requestedParallelToolCalls: parallel ?? false, toolBatchState: "released",
    counts: { toolsStarted: 2, toolsCompleted: 2, openTools: 0, hostToolsReleased: 2 },
  } } }]);
  expect(await read(f.handle.fullStream)).toEqual(seen); expect(f.requests.count).toBe(1);
});

const bad: Array<[string, StreamPart[]]> = [
  ["undeclared second tool", [call("one"), call("two", {}, "not-declared")]],
  ["incomplete second tool", [call("one"), start("two"), delta("two", '{"n":')]],
  ["invalid second JSON", [call("one"), start("two"), delta("two", '{"n":'), call("two")]],
  ["mismatched second args", [call("one"), start("two"), delta("two", '{"n":1}'), call("two", { n: 2 })]],
  ["renamed second tool", [call("one"), start("two"), call("two", {}, "record")]],
  ["conflicting duplicate", [call("one"), call("two"), call("one", { changed: true })]],
  ["restarted completed ID", [call("one"), call("two"), start("one")]],
  ["missing usage", [call("one"), call("two"), { type: "finish", reason: "stop" }]],
  ["invalid finish", [call("one"), call("two"), { type: "finish", reason: "unknown" } as unknown as StreamPart]],
];
for (const [name, parts] of bad) test(`validated batch rejects ${name} with zero executable material`, async () => {
  const f = setup(parts);
  const seen = await read(f.handle.fullStream);
  await expect(f.handle.response).rejects.toBeInstanceOf(Error);
  expect(seen.filter(p => p.type.startsWith("tool-call"))).toEqual([]);
  expect(f.terminals).toMatchObject([{ terminalClass: "error", toolCallCount: 0, diagnostic: { stream: { hostToolPolicy: "validated-batch", toolBatchState: "discarded", counts: { hostToolsReleased: 0 } } } }]);
  expect(f.requests.count).toBe(1);
});

for (const fault of ["eof", "provider", "abort", "limit"] as const) test(`validated batch ${fault} before commit cannot release partial tools`, async () => {
  const controller = new AbortController(), gate = latch(), reached = latch();
  const f = setup([call("one"), call("two")], { signal: controller.signal,
    ...(fault === "eof" ? { omitFinish: true } : {}), ...(fault === "provider" ? { fail: true } : {}),
    ...(fault === "abort" ? { gate, reached } : {}), ...(fault === "limit" ? { maxParts: 1 } : {}),
  });
  if (fault === "abort") { await reached.promise; controller.abort(); gate.resolve(); }
  const seen = await read(f.handle.fullStream);
  if (fault === "abort") expect((await f.handle.response).finishReason).toBe("abort");
  else await expect(f.handle.response).rejects.toBeInstanceOf(Error);
  expect(seen.filter(p => p.type.startsWith("tool-call"))).toEqual([]);
  expect(JSON.stringify(f.terminals)).not.toContain("PRIVATE_PROVIDER_ERROR");
  expect(f.terminals[0]?.toolCallCount).toBe(0); expect(f.requests.count).toBe(1);
});

test("identical tool completion is deduplicated without dropping the other call", async () => {
  const f = setup([call("one"), call("one"), call("two")]);
  expect((await read(f.handle.fullStream)).filter(p => p.type === "tool-call")).toEqual([call("one"), call("two")]);
  expect((await f.handle.response).messages[0]?.content).toEqual([call("one"), call("two")]);
});

test("no new two-call quota is introduced: twelve valid calls survive once", async () => {
  const parts = Array.from({ length: 12 }, (_, i) => call(`id-${i}`, { n: i }));
  const f = setup(parts);
  expect((await f.handle.response).messages[0]?.content).toEqual(parts);
  expect((await read(f.handle.fullStream)).filter(p => p.type === "tool-call")).toEqual(parts);
  expect(f.terminals[0]?.toolCallCount).toBe(12);
});

test("text remains incremental while tools are withheld, with no fabricated SendToUser when tools exist", async () => {
  const gate = latch(), reached = latch();
  const f = setup([{ type: "text-delta", textDelta: "progress" }, call("one"), call("two")], { gate, reached });
  const it = f.handle.fullStream[Symbol.asyncIterator]();
  expect((await it.next()).value).toMatchObject({ type: "text-delta", textDelta: "progress" });
  await reached.promise; gate.resolve();
  const response = await f.handle.response;
  expect(response.messages[0]?.content).toEqual([{ type: "text", text: "progress" }, call("one"), call("two")]);
});

test("policy and actual batch outcome survive safe terminal projection and failure lookup", async () => {
  const f = setup([call("one"), start("two")]); await f.handle.response.catch(() => undefined);
  const t = f.terminals[0]!;
  const terminal = projectHostNormalizedTerminal({ name: "host_normalized_terminal", at: "2026-09-16T02:00:00.000Z", agentId: "agent", turnId: "turn", stepId: "batch-step", ...t });
  expect(terminal).toMatchObject({ diagnostic: { stream: { hostToolPolicy: "validated-batch", toolBatchState: "discarded" } } });
  const out = projectSendOutcome({ agentId: "agent", stepId: "batch-step", entries: [], alerts: [], truncated: false, runtimeEvents: [terminal] });
  expect(out.state).toBe("failed");
  expect(out.runtimeFailure?.diagnostic?.stream).toMatchObject({ hostToolPolicy: "validated-batch", toolBatchState: "discarded" });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelEnvelope, type ModelEnvelope } from "../src/envelope.ts";
import { callStubModeld } from "../src/modeld-ipc.ts";
import { startStubModeldServer } from "../src/modeld-serve.ts";
import { eventsPath } from "../src/paths.ts";
import { createSessionSeam, createStubRouteDriver, createModeldRouteDriver, type StubRouteSubmit } from "../src/seam.ts";
import type { HostPromptSession, StreamPart } from "../src/session.ts";
import { collectStreamParts, consumeHandle, hasMeaningfulResponseMessageContent, SEAM_STOP_PARTS } from "./host-consumer.ts";
import { providerHardOff } from "./provider-hard-off.ts";
import { modeldFixture, submitRequest } from "./modeld-fixture.ts";
import { scriptedStream, within } from "./scripted-stream.ts";

const AT = "2026-01-01T00:00:00.000Z";
const original = { stream: () => { throw new Error("official model hard-off"); } };
const hookArgs = (id: string) => ({ originalSession: original, sessionOptions: { invocationId: id, inferenceReason: "main" }, agentId: "agent-test" });
async function events(root: string): Promise<Array<Record<string, unknown>>> {
  try { return (await readFile(eventsPath(root), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-envelope-seam-"));
  const script = scriptedStream();
  const requests: StubRouteSubmit[] = [];
  const driver = createStubRouteDriver([]);
  driver.delivery = "stream";
  driver.stream = (request) => { requests.push(request); return script.source; };
  const seam = createSessionSeam({ mode: "route", root, assignment: "main", modelId: "stub/echo", driver, now: () => AT });
  return { root, script, requests, driver, seam };
}

describe("Host envelope seam, no provider or second Host loop", () => {
  test("streaming Host vector executes once, duplicate hook/stream does not replay effects or receipts", async () => {
    const off = providerHardOff();
    try {
      const f = await fixture();
      const requestIds: string[] = [];
      const args = { ...hookArgs("inv-vector"), onRequestId: (id: string) => requestIds.push(id) };
      const session = f.seam.hook(args) as HostPromptSession;
      const executor = session.getExecutor([{ role: "user", content: "private-vector-prompt" }]);
      const handle = executor.stream({}, "inv-vector");
      const vector = consumeHandle(handle);
      const duplicate = executor.stream({}, "inv-vector");
      expect(f.seam.hook(args)).toBe(session);
      for (const part of SEAM_STOP_PARTS) f.script.push(part);
      expect(await within(vector)).toEqual({ toolExecutionCount: 2, finalDeliveryCount: 1,
        transcriptEntryDelta: 3, transcriptSequenceDelta: 3, memoryIdDelta: 1, duplicateCount: 0 });
      expect(await consumeHandle(duplicate)).toEqual({ toolExecutionCount: 0, finalDeliveryCount: 0,
        transcriptEntryDelta: 0, transcriptSequenceDelta: 0, memoryIdDelta: 0, duplicateCount: 0 });
      expect(f.driver.dispatches).toBe(1);
      expect(requestIds).toEqual(["inv-vector"]);
      expect(executor.getState()).toEqual([{ role: "user", content: "private-vector-prompt" }]);
      await f.seam.flush();
      expect(await events(f.root)).toEqual([expect.objectContaining({ invocationId: "inv-vector", toolCallCount: 2, terminalClass: "stop", outcome: "managed" })]);
      expect(JSON.stringify(await events(f.root))).not.toMatch(/private-vector-prompt|fixture-memory-body|fixture-final-response/);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
      expect(f.driver.officialCalls + f.driver.secondProviderCalls).toBe(0);
    } finally { off.restore(); }
  });

  test("only the Host supplies the next serial step: tool result/id/schema roundtrip with two explicit invocations", async () => {
    const off = providerHardOff();
    try {
      const f = await fixture();
      const received: ModelEnvelope[] = [];
      f.driver.stream = (request) => {
        received.push(request.envelope);
        return { async *[Symbol.asyncIterator]() {
          if (request.invocationId === "inv-tool") yield { type: "tool-call" as const, toolCallId: "call:stable/1", toolName: "lookup", args: { query: "find" } };
          else yield { type: "text-delta" as const, textDelta: "done" };
          yield { type: "finish" as const, reason: "stop" as const };
        } };
      };
      let toolExecutions = 0;
      const tools = { lookup: { inputSchema: { type: "object", properties: { query: { type: "string" } } }, execute: () => { toolExecutions += 1; } } };
      const first = f.seam.hook(hookArgs("inv-tool")) as HostPromptSession;
      const executor = first.getExecutor([{ role: "system", content: "system" }, { role: "user", content: "question" }]);
      const tool = executor.stream({}, "inv-tool", tools, { parallelToolCalls: false });
      const response = await within(tool.response);
      expect(response.messages[0]!.content).toEqual([{ type: "tool-call", toolCallId: "call:stable/1", toolName: "lookup", args: { query: "find" } }]);
      expect(toolExecutions).toBe(0);
      expect(received).toHaveLength(1);
      expect(executor.getState()).toHaveLength(2);
      // The fake Host, not grokbox, appends its assistant/tool result and invokes the next model step.
      executor.appendMessages(response.messages).appendMessages({ role: "tool", content: [{ type: "tool-result", toolCallId: "call:stable/1", result: { rows: ["found"] } }] });
      const second = f.seam.hook(hookArgs("inv-followup")) as HostPromptSession;
      const next = second.getExecutor(executor.getState()).stream({}, "inv-followup", tools, { maxTokens: 100 });
      expect((await within(next.response)).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
      expect(received).toHaveLength(2);
      expect(received[1]!.messages.at(-1)?.content).toEqual([{ type: "tool-result", toolCallId: "call:stable/1", result: { rows: ["found"] } }]);
      expect(received[1]!.tools).toEqual(received[0]!.tools);
      expect(f.driver.dispatches).toBe(2);
      expect(toolExecutions).toBe(0);
      await f.seam.flush(); expect(await events(f.root)).toHaveLength(2);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { off.restore(); }
  });

  test("a changed payload under the same invocation is visibly rejected without changing its in-flight request", async () => {
    const f = await fixture();
    const session = f.seam.hook(hookArgs("inv-conflict")) as HostPromptSession;
    const executor = session.getExecutor([{ role: "user", content: "first" }]);
    const first = executor.stream({}, "inv-conflict");
    executor.appendMessages({ role: "user", content: "second" });
    const conflict = executor.stream({}, "inv-conflict");
    expect((await conflict.response).error?.code).toBe("invocation_conflict");
    expect(f.requests[0]!.envelope.messages).toEqual([{ role: "user", content: "first" }]);
    f.script.push({ type: "finish", reason: "stop" }); await within(first.response);
    expect(f.driver.dispatches).toBe(1);
    await f.seam.flush(); expect(await events(f.root)).toHaveLength(1);
  });

  test.each(["image", "bad-options"])("%s produces one visible rejected receipt, before driver effect", async (fault) => {
    const f = await fixture();
    const session = f.seam.hook(hookArgs("inv-rejected")) as HostPromptSession;
    const executor = session.getExecutor([{ role: "user", content: fault === "image" ? [{ type: "image", url: "https://invalid.test/private-image" }] : "private-prompt" }]);
    const handle = executor.stream({}, "inv-rejected", [], fault === "bad-options" ? { temperature: NaN, privateOption: "private-body" } : {});
    expect(hasMeaningfulResponseMessageContent((await within(handle.response)).messages)).toBe(true);
    expect(await consumeHandle(handle)).toMatchObject({ toolExecutionCount: 0, finalDeliveryCount: 1 });
    expect(f.driver.dispatches).toBe(0);
    expect(f.requests).toEqual([]);
    await f.seam.flush();
    expect(await events(f.root)).toEqual([expect.objectContaining({ terminalClass: "error", outcome: "rejected", toolCallCount: 0 })]);
    expect(JSON.stringify(await events(f.root))).not.toContain("private-");
  });

  test("disconnect terminates a stalled stream once, counts already delivered tools and forbids late dispatch", async () => {
    const f = await fixture();
    const session = f.seam.hook(hookArgs("inv-disconnect")) as HostPromptSession;
    const handle = session.getExecutor().stream({}, "inv-disconnect");
    const iterator = handle.fullStream[Symbol.asyncIterator]();
    f.script.push({ type: "tool-call", toolCallId: "call-one", toolName: "lookup", args: {} });
    expect((await within(iterator.next())).value).toMatchObject({ type: "tool-call" });
    await within(f.seam.disconnect("inv-disconnect"));
    expect((await within(handle.response)).finishReason).toBe("abort");
    f.script.push({ type: "finish", reason: "stop" });
    expect((await collectStreamParts(handle.fullStream)).filter((part) => part.type === "finish")).toHaveLength(1);
    await f.seam.flush();
    expect(await events(f.root)).toEqual([expect.objectContaining({ terminalClass: "unknown", toolCallCount: 1 })]);
    expect((await session.getExecutor().stream().response).messages[0]!.content).toEqual([]);
    expect(f.driver.dispatches).toBe(1);
    await iterator.return?.();
    const unused = f.seam.hook(hookArgs("inv-disconnected-before-use")) as HostPromptSession;
    await f.seam.disconnect("inv-disconnected-before-use");
    await unused.getExecutor().stream().response;
    expect(f.driver.dispatches).toBe(1);
  });
});

describe("buffered stub IPC envelope boundary (not token-streaming proof)", () => {
  test("forwarded envelope participates in conflict admission, with provider effects hard-off", async () => {
    const off = providerHardOff();
    const { runRoot: root, durable, binding } = await modeldFixture();
    const server = await startStubModeldServer({ runRoot: root, durableRoot: durable });
    try {
      const driver = createModeldRouteDriver(root, binding);
      const envelope = buildModelEnvelope([{ role: "system", content: "system-sentinel" }, { role: "user", content: "body-sentinel" }],
        { lookup: { parameters: { jsonSchema: { type: "object", properties: {} } } } }, { temperature: 0.5 });
      const request = { invocationId: "inv-ipc", turnId: "inv-ipc", agentId: "agent-test", modelId: "stub/echo", envelope };
      expect((await driver.submit!(request)).dispatched).toBe(true);
      const raw = submitRequest(server, request.invocationId, { agentId: request.agentId, envelope });
      expect(await callStubModeld(root, raw)).toMatchObject({ ok: true, dispatched: false });
      expect(await callStubModeld(root, { ...raw, envelope: buildModelEnvelope([{ role: "user", content: "changed" }]) })).toMatchObject({ ok: false, code: "conflict" });
      expect(await callStubModeld(root, { ...raw, invocationId: "invalid", envelope: { version: 99 } })).toMatchObject({ ok: false, code: "invalid-envelope" });
      expect(await callStubModeld(root, { ...raw, invocationId: "image", envelope: buildModelEnvelope([{ role: "user", content: [{ type: "image", data: "fixture-image" }] }]) })).toMatchObject({ ok: false, code: "unsupported-content" });
      expect(server.dispatches()).toBe(1);
      expect(off.counts).toEqual({ fetch: 0, dns: 0, tcp: 0, credential: 0 });
    } finally { await server.stop(); off.restore(); }
  });
});

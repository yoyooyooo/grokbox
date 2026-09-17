import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, StreamEvidence, projectStreamDiagnostic, streamFailureDiagnostic, type ContextSnapshot, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";
import { createStreamingPromptSession, type StreamPart } from "../src/internal/host/session.ts";
import { reshapeInferenceEvent } from "../src/internal/host/stream-codec.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";

const TOOL = { name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
const MODEL = { id: "openai/synthetic", provider: "openai" as const, model: "synthetic", endpoint: "https://synthetic.invalid/v1", apiKeyRef: "env:OPENAI_API_KEY", contextWindowTokens: 200000, capabilities: { tools: true } };
function snapshot(): ContextSnapshot {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1", systemMessages: [{ role: "system", content: "synthetic root" }], messages: [{ role: "user", content: "synthetic request" }], tools: [TOOL], options: {} });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}) });
const start = (name = "lookup", id = "call") => chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] });
const args = (text: string) => chunk({ tool_calls: [{ index: 0, function: { arguments: text } }] });
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
function fetchFrames(values: unknown[], onPull?: () => void): typeof fetch {
  return Object.assign(async () => {
    const frames = [...values.map(frame), "data: [DONE]\n\n"];
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      onPull?.();
      if (index === frames.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(frames[index++]!));
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: async () => undefined }) as typeof fetch;
}
async function run(values: unknown[]) {
  let requests = 0;
  const fetch = fetchFrames(values);
  const wrapped = Object.assign(async (...args: Parameters<typeof fetch>) => { requests++; return fetch(...args); }, { preconnect: async () => undefined }) as typeof fetch;
  const events: InferenceEvent[] = [];
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth, backend = yield* ModelBackend;
    const pin = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
    const prepared = yield* backend.prepare(MODEL, snapshot());
    return yield* Effect.result(Stream.runForEach(backend.infer({}, prepared, pin.lease), event => Effect.sync(() => { events.push(event); })));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch: wrapped, env: { OPENAI_API_KEY: "synthetic-only" } })))));
  return { result, events, requests, diagnostic: result._tag === "Failure" ? backendFailureObservation(result.failure) : undefined };
}

describe("production SDK stream boundaries and payload-free diagnostics", () => {
  for (const [label, events, expected] of [
    ["missing finish", [chunk({ content: "partial" })], "missing_finish"],
    ["unknown finish", [chunk({ content: "partial" }), chunk({}, "made_up")], "unsupported_finish_reason"],
    ["unclosed tool arguments", [start(), args('{"q":"incomplete'), chunk({}, "tool_calls")], "tool_arguments_invalid"],
    ["parsable prefix followed by junk", [start(), args('{"q":"SENTINEL_ARGUMENT"}'), args("INVALID_TAIL"), chunk({}, "tool_calls")], "tool_arguments_invalid"],
    ["undeclared tool", [start("not_declared"), args('{"q":"x"}'), chunk({}, "tool_calls")], "undeclared_tool"],
  ] as const) {
    test(label, async () => {
      const out = await run([...events]);
      expect(out.requests).toBe(1);
      expect(out.result._tag).toBe("Failure");
      expect(out.diagnostic?.normalizeCause).toBe(expected);
      expect(out.events.some(e => e.type === "backend_finish")).toBe(false);
      const diagnostic = JSON.stringify(out.diagnostic);
      expect(diagnostic).not.toContain("SENTINEL_ARGUMENT");
      expect(diagnostic).not.toContain("synthetic request");
      expect(diagnostic).not.toContain("synthetic-only");
      expect(out.diagnostic?.stream?.tail.length).toBeLessThanOrEqual(32);
      expect(out.diagnostic?.stream?.engine).toMatchObject({ aiVersion: "5.0.253", providerVersion: "2.0.125", adapterRevision: 3 });
    });
  }
  for (const [finish, reason] of [["insufficient_system_resource", "provider_resource"], ["aborted", "provider_interrupted"], ["length", "output_limit"]] as const) {
    test(`provider ${finish} is not an opaque normalize error or success`, async () => {
      const out = await run([chunk({ content: "partial" }), chunk({}, finish)]);
      expect(out.requests).toBe(1); expect(out.result._tag).toBe("Failure");
      expect(out.diagnostic?.reason).toBe(reason);
      expect(out.diagnostic?.stream?.providerFinishReason).toBe(finish);
    });
  }
  test("1429-event valid stream succeeds with counters and complete provider finish evidence", async () => {
    const out = await run([...Array.from({ length: 1429 }, () => chunk({ content: "x" })), chunk({}, "stop")]);
    expect(out.result._tag).toBe("Success");
    const finish = out.events.at(-1);
    expect(finish?.type).toBe("backend_finish");
    if (finish?.type !== "backend_finish") throw Error("missing finish");
    expect(finish.stream?.counts.textBytes).toBe(1429);
    expect(finish.stream?.providerFinishObserved).toBe(true);
    expect(finish.stream?.providerDoneObserved).toBe(true);
    expect(finish.stream?.counts.queuePeak).toBeLessThanOrEqual(16);
  });
  test("valid tool survives audit and the Host; a second call is not silently dropped", async () => {
    const second = chunk({ tool_calls: [{ index: 1, id: "second", type: "function", function: { name: "lookup", arguments: '{"q":"two"}' } }] });
    const out = await run([start(), args('{"q":"one"}'), second, chunk({}, "tool_calls")]);
    expect(out.result._tag).toBe("Success");
    expect(out.events.filter(e => e.type === "tool_complete")).toHaveLength(2);
    const prompt = createStreamingPromptSession({ modelId: MODEL.id, vision: false, parallel: "fail-closed", produce: async function* () {
      for (const event of out.events) {
        if (event.type === "backend_finish") { yield { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; continue; }
        const part = reshapeInferenceEvent(event); if (part.kind === "part") yield part.part;
      }
    } });
    const handle = prompt.stream({ envelope: buildHostEnvelope([{ role: "user", content: "x" }], [TOOL]) });
    const released: StreamPart[] = []; for await (const part of handle.fullStream) released.push(part);
    await expect(handle.response).rejects.toMatchObject({ code: "parallel_tools" });
    expect(released.some(p => p.type.startsWith("tool-call"))).toBe(false);
  });
  test("a terminal is not exposed before later SDK evidence has been checked", () => {
    const n = createSdkStreamNormalizer();
    expect(n.next({ type: "text-delta", text: "x" })).toMatchObject({ type: "text_delta" });
    expect(n.next({ type: "finish", finishReason: "stop" })).toBeUndefined();
    try { n.next({ type: "text-delta", text: "late" }); throw Error("should reject"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "event_after_finish" }); }
  });
  test("SDK invalid tool metadata is a rejection, not an executable call", () => {
    const n = createSdkStreamNormalizer(); n.next({ type: "tool-input-start", id: "a", toolName: "lookup" });
    try { n.next({ type: "tool-call", toolCallId: "a", toolName: "lookup", input: {}, invalid: true }); throw Error("should reject"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "sdk_invalid_tool", stream: { sdkInvalidToolObserved: true } }); }
  });
  test("SDK producer backpressures when the kernel consumer is blocked", async () => {
    let pulls = 0, entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetch = fetchFrames([...Array.from({ length: 512 }, () => chunk({ content: "x".repeat(1024) })), chunk({}, "stop")], () => { pulls++; });
    let first = true;
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth, backend = yield* ModelBackend;
      const pin = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(MODEL, snapshot());
      yield* Stream.runForEach(backend.infer({}, prepared, pin.lease), () => Effect.promise(async () => { if (first) { first = false; entered(); await gate; } }));
    }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { OPENAI_API_KEY: "synthetic" } })))));
    try { await reached; await new Promise(r => setTimeout(r, 30)); expect(pulls).toBeLessThan(512); }
    finally { release(); await Effect.runPromise(Fiber.interrupt(fiber)); }
  });
});

describe("provider raw guard parsing", () => {
  test("SSE CRLF and UTF-8 split at every byte keep semantic evidence", () => {
    const e = new StreamEvidence(), a = new ProviderStreamAudit("chat", e); a.instrumented();
    const data = new TextEncoder().encode((frame(chunk({ content: "鹈鹕" })) + frame(chunk({}, "stop")) + "data: [DONE]\n\n").replaceAll("\n", "\r\n"));
    for (const byte of data) a.push(Uint8Array.of(byte)); a.eof();
    expect(e.snapshot()).toMatchObject({ providerObservation: "eof", providerFinishReason: "stop", providerDoneObserved: true });
    expect(JSON.stringify(e.snapshot())).not.toContain("鹈鹕");
  });
  test("no SSE reader means finish observation remains absent, not false", () => {
    const e = new StreamEvidence(); new ProviderStreamAudit("chat", e).headers(401);
    expect(e.snapshot().providerFinishObserved).toBeUndefined();
  });
  test("Responses argument mismatch rejected before SDK success", () => {
    const e = new StreamEvidence(), a = new ProviderStreamAudit("responses", e); a.instrumented();
    a.push(new TextEncoder().encode(frame({ type: "response.function_call_arguments.delta", item_id: "i", delta: '{"q":"a"}' })));
    try { a.push(new TextEncoder().encode(frame({ type: "response.function_call_arguments.done", item_id: "i", arguments: '{"q":"b"}' }))); throw Error("should fail"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "tool_arguments_mismatch", rejectSite: "provider_responses_wire" }); }
  });
  test("Responses object key order alone is not an argument mismatch", () => {
    const a = new ProviderStreamAudit("responses", new StreamEvidence()); a.instrumented();
    a.push(new TextEncoder().encode(frame({ type: "response.function_call_arguments.delta", item_id: "i", delta: '{"a":1,"b":2}' })));
    expect(() => a.push(new TextEncoder().encode(frame({ type: "response.function_call_arguments.done", item_id: "i", arguments: '{"b":2,"a":1}' })))).not.toThrow();
  });
  test("diagnostics never invoke accessors or retain unknown payload fields", () => {
    let reads = 0;
    const projected = projectStreamDiagnostic({ normalizeCause: "undeclared_tool", rejectSite: "sdk_tool", toolName: "secret-name", get stream() { reads++; return {}; } });
    expect(reads).toBe(0); expect(projected).toEqual({ normalizeCause: "undeclared_tool", rejectSite: "sdk_tool" });
  });
});

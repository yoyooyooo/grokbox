import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Stream } from "effect";
import {
  BackendFailure, StreamEvidence, annotateStreamFailure, contextSnapshotBody,
  projectStreamDiagnostic, projectStreamSummary, streamFailureDiagnostic,
  type ContextSnapshot, type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { fakeBackendAuthLayer, unsealFakeAuth } from "@grokbox/runtime-kernel/testing";
import { aiSdkModelBackendLayer } from "../src/internal/backends/ai-sdk.ts";
import { createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { ProviderStreamAudit } from "../src/internal/backends/provider-stream-audit.ts";
import { projectModeldStepOutcome } from "../src/internal/io/modeld-outcome.node.ts";
import { createStreamingPromptSession, type StreamPart } from "../src/internal/host/session.ts";
import { reshapeInferenceEvent } from "../src/internal/host/stream-codec.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";

const PRIVATE = "PRIVATE_PROVIDER_OR_ARGUMENT_SENTINEL";
const tools: ContextSnapshot["tools"] = [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "notify", inputSchema: { type: "object" } }];
const model = { id: "openai/owned", provider: "openai-chat", model: "owned", endpoint: "https://offline.invalid/v1",
  apiKeyRef: "env:OWNED", capabilities: { tools: true }, contextWindowTokens: 200_000 };
function snapshot(): ContextSnapshot {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-state-root", abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "owned root" }], messages: [{ role: "user", content: "owned request" }], tools, options: {} });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
const text = (content = "x") => chunk({ content });
const finish = (reason = "stop") => ({ ...chunk({}, reason), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const toolStart = (name = "lookup", index = 0) => chunk({ tool_calls: [{ index, id: `call-${index}`, type: "function", function: { name, arguments: "" } }] });
const argument = (value: string, index = 0) => chunk({ tool_calls: [{ index, function: { arguments: value } }] });
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
function response(frames: unknown[], done = true): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(encode(frames[index++]));
      else if (done && index++ === frames.length) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      else controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
function layer(fetcher: () => Response) {
  const fetch = Object.assign(async () => fetcher(), { preconnect: async () => undefined }) as typeof globalThis.fetch;
  return Layer.merge(aiSdkModelBackendLayer(fetch, unsealFakeAuth), fakeBackendAuthLayer("synthetic-only"));
}
async function run(frames: unknown[], done = true) {
  let http = 0;
  const events: InferenceEvent[] = [];
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const pinned = yield* auth.pin({ apiKeyRef: "env:OWNED" });
    const prepared = yield* backend.prepare(model, snapshot());
    return yield* Effect.result(Stream.runForEach(backend.infer({}, prepared, pinned.lease), event => Effect.sync(() => { events.push(event); })));
  }).pipe(Effect.provide(layer(() => { http++; return response(frames, done); })))));
  return { events, http, error: result._tag === "Failure" ? result.failure : undefined };
}

describe("stream evidence is bounded and cannot retain payload", () => {
  test("all projectors drop raw values, getters, free-form types and oversized tail", () => {
    let reads = 0;
    const value = { normalizeCause: "open_tools_at_finish", rejectSite: "sdk_finish", toolName: PRIVATE,
      stream: { version: 1, counts: { canonicalEvents: 1429, toolArgumentBytes: 40, secret: PRIVATE }, timings: { durationMs: 9 },
        tail: Array.from({ length: 100 }, (_, sequence) => ({ layer: "sdk", type: "tool-input-delta", sequence, elapsedMs: sequence, text: PRIVATE })),
        providerFinishReason: PRIVATE, raw: PRIVATE } };
    Object.defineProperty(value, "declaredToolMatch", { get() { reads++; throw Error(PRIVATE); } });
    const safe = projectStreamDiagnostic(value)!;
    expect(reads).toBe(0);
    expect(safe.stream?.tail).toHaveLength(32);
    expect(safe.stream?.tail[0]?.sequence).toBe(68);
    expect(JSON.stringify(safe)).not.toContain(PRIVATE);
    expect(safe.stream?.providerFinishObserved).toBeUndefined();
    expect(projectStreamSummary({ version: 0 })).toBeUndefined();
    expect(projectStreamDiagnostic({ normalizeCause: PRIVATE })).toBeUndefined();
  });
  test("failure identity is local and the first concrete cause survives cleanup", () => {
    const one = annotateStreamFailure(new BackendFailure("stream_invalid"), { normalizeCause: "undeclared_tool", rejectSite: "sdk_tool" });
    const other = new BackendFailure("stream_invalid");
    annotateStreamFailure(one, { normalizeCause: "missing_finish", rejectSite: "canonical_finish", stream: new StreamEvidence().snapshot() });
    expect(streamFailureDiagnostic(one)).toMatchObject({ normalizeCause: "undeclared_tool", rejectSite: "sdk_tool" });
    expect(streamFailureDiagnostic(other)).toBeUndefined();
  });
  test("diagnostics survive the real terminal projector instead of disappearing", () => {
    const projected = projectModeldStepOutcome({ name: "model_step_terminal", schemaVersion: 3, at: "2026-01-01T00:00:00.000Z",
      agentId: "owned-agent", hostGenerationId: "generation", serviceEpoch: "epoch", turnId: "turn", stepId: "step",
      outcome: "error", phase: "normalize", eventCount: 1429, failureCode: "stream_invalid",
      diagnostic: { phase: "normalize", reason: "stream_shape", normalizeCause: "open_tools_at_finish", rejectSite: "canonical_finish",
        stream: { version: 1, counts: { openTools: 1 }, timings: {}, tail: [] }, raw: PRIVATE } });
    expect(projected).toMatchObject({ diagnostic: { normalizeCause: "open_tools_at_finish", rejectSite: "canonical_finish", stream: { counts: { openTools: 1 } } } });
    expect(JSON.stringify(projected)).not.toContain(PRIVATE);
  });
});

describe("real pinned SDK differentiates previously identical stream_shape failures", () => {
  for (const [name, frames, code, detail] of [
    ["valid long text", [...Array.from({ length: 1429 }, () => text()), finish()], undefined, undefined],
    ["long text missing finish", Array.from({ length: 1429 }, () => text()), "stream_invalid", "missing_finish"],
    ["open JSON at finish", [toolStart(), argument('{"q":"'), ...Array.from({ length: 1427 }, () => argument("x")), finish("tool_calls")], "stream_invalid", "tool_arguments_invalid"],
    ["unknown upstream finish", [...Array.from({ length: 1429 }, () => text()), finish("new_provider_reason")], "stream_invalid", "unsupported_finish_reason"],
    ["provider resource interruption", [text(), finish("insufficient_system_resource")], "provider_error", "provider_resource"],
    ["provider aborted, not user cancelled", [text(), finish("aborted")], "provider_error", "provider_interrupted"],
    ["output length", [text(), finish("length")], "provider_error", "output_limit"],
    ["unknown tool", [toolStart("undeclared"), argument('{"q":"x"}'), finish("tool_calls")], "stream_invalid", "undeclared_tool"],
  ] as const) {
    test(name, async () => {
      const result = await run([...frames]);
      expect(result.http).toBe(1);
      if (code === undefined) {
        expect(result.error).toBeUndefined();
        expect(result.events.filter(event => event.type === "text_delta")).toHaveLength(1429);
        expect(result.events.at(-1)).toMatchObject({ type: "backend_finish", stream: { counts: { providerEvents: 1430 }, providerFinishReason: "stop" } });
      } else {
        expect(result.error).toMatchObject({ code });
        const observation = backendFailureObservation(result.error);
        expect(observation?.normalizeCause ?? observation?.reason).toBe(detail);
        expect(result.events.some(event => event.type === "backend_finish")).toBe(false);
        expect(observation?.stream?.tail.length).toBeLessThanOrEqual(32);
        expect(JSON.stringify(observation)).not.toContain("new_provider_reason");
      }
    });
  }
  test("valid prefix plus ignored SDK trailing arguments is rejected, never executable", async () => {
    const result = await run([toolStart(), argument('{"q":"safe"}'), argument(PRIVATE), finish("tool_calls")]);
    expect(result.error).toMatchObject({ code: "stream_invalid" });
    expect(backendFailureObservation(result.error)).toMatchObject({ normalizeCause: "tool_arguments_invalid", rejectSite: "provider_chat_wire" });
    const session = createStreamingPromptSession({ modelId: "stub/echo", vision: false, parallel: "fail-closed",
      produce: async function* () {
        for (const event of result.events) { const next = reshapeInferenceEvent(event); if (next.kind === "part") yield next.part; }
        throw result.error;
      } });
    const handle = session.stream({ envelope: buildHostEnvelope([{ role: "user", content: "owned" }], tools) });
    const parts: StreamPart[] = [];
    for await (const part of handle.fullStream) parts.push(part);
    await expect(handle.response).rejects.toBeInstanceOf(Error);
    expect(parts.filter(part => part.type.startsWith("tool-call"))).toHaveLength(0);
    expect(JSON.stringify(backendFailureObservation(result.error))).not.toContain(PRIVATE);
  });
  test("a real second tool is visible to Host and rejects the whole serial batch", async () => {
    const result = await run([toolStart(), argument('{"q":"x"}'), toolStart("notify", 1), argument("{}", 1), finish("tool_calls")]);
    expect(result.error).toBeUndefined();
    expect(result.events.filter(event => event.type === "tool_complete")).toHaveLength(2);
    const session = createStreamingPromptSession({ modelId: "stub/echo", vision: false, parallel: "fail-closed",
      produce: async function* () {
        for (const event of result.events) {
          if (event.type === "backend_finish") yield { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
          else { const next = reshapeInferenceEvent(event); if (next.kind === "part") yield next.part; }
        }
      } });
    const handle = session.stream({ envelope: buildHostEnvelope([{ role: "user", content: "owned" }], tools) });
    const parts: StreamPart[] = [];
    for await (const part of handle.fullStream) parts.push(part);
    await expect(handle.response).rejects.toMatchObject({ code: "parallel_tools" });
    expect(parts.filter(part => part.type.startsWith("tool-call"))).toHaveLength(0);
  });
  test("an invalid SDK tool and a late part after finish cannot emit successful terminal", () => {
    const normalizer = createSdkStreamNormalizer({ declaredTools: new Set(["lookup"]) });
    expect(() => normalizer.next({ type: "tool-call", toolCallId: "one", toolName: "lookup", input: {}, invalid: true, error: Error(PRIVATE) }))
      .toThrow(BackendFailure);
    const n = createSdkStreamNormalizer();
    expect(n.next({ type: "finish", finishReason: "stop" })).toBeUndefined();
    try { n.next({ type: "text-delta", text: "late" }); throw Error("unexpected success"); }
    catch (error) { expect(streamFailureDiagnostic(error)?.normalizeCause).toBe("event_after_finish"); }
  });
});

describe("provider raw evidence remains bounded and preserves the complete argument stream", () => {
  test("split UTF-8 and CRLF, comments and DONE survive without body retention", () => {
    const evidence = new StreamEvidence();
    const audit = new ProviderStreamAudit("chat", evidence);
    const data = new TextEncoder().encode(`: heartbeat\r\ndata: ${JSON.stringify(text("中文"))}\r\n\r\ndata: ${JSON.stringify(finish())}\r\n\r\ndata: [DONE]\r\n\r\n`);
    for (const byte of data) audit.push(Uint8Array.of(byte));
    audit.eof();
    expect(evidence.snapshot()).toMatchObject({ providerFinishReason: "stop", providerDoneObserved: true, providerObservation: "eof" });
    expect(JSON.stringify(evidence.snapshot())).not.toContain("中文");
    audit.dispose();
  });
  test("Responses complete and accumulated arguments must agree", () => {
    const evidence = new StreamEvidence(), audit = new ProviderStreamAudit("responses", evidence);
    audit.push(encode({ type: "response.function_call_arguments.delta", item_id: "owned", delta: '{"q":"first"}' }));
    try {
      audit.push(encode({ type: "response.function_call_arguments.done", item_id: "owned", arguments: '{"q":"different"}' }));
      throw Error("unexpected success");
    } catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "tool_arguments_mismatch", rejectSite: "provider_responses_wire" }); }
    audit.dispose();
  });
  test("a huge unterminated SSE event fails its input budget instead of growing forever", () => {
    const audit = new ProviderStreamAudit("chat", new StreamEvidence());
    expect(() => audit.push(new TextEncoder().encode(`data: ${"x".repeat(1024 * 1024 + 1)}`))).toThrow(BackendFailure);
    audit.dispose();
  });
});

test("blocked downstream does not drain the whole SDK response into an unbounded queue", async () => {
  let upstream = 0, consumed = 0;
  let release!: () => void, first!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { first = resolve; });
  const graph = layer(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (upstream < 512) { upstream++; controller.enqueue(encode(text("x".repeat(4096)))); }
      else { controller.enqueue(encode(finish())); controller.close(); }
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const pin = yield* auth.pin({ apiKeyRef: "env:OWNED" });
    const prepared = yield* backend.prepare(model, snapshot());
    yield* Stream.runForEach(backend.infer({}, prepared, pin.lease), event => event.type === "text_delta"
      ? Effect.promise(async () => { if (++consumed === 1) { first(); await gate; } }) : Effect.void);
  }).pipe(Effect.provide(graph))));
  try {
    await reached;
    // Let already-scheduled SDK work settle; no provider timers or live services.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(consumed).toBe(1);
    const stalledAt = upstream;
    expect(stalledAt).toBeGreaterThan(0);
    expect(stalledAt).toBeLessThan(512);
    // SDK stages have their own small buffers. Verify demand stops upstream
    // progress rather than assuming their aggregate size is an arbitrary 32.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upstream).toBe(stalledAt);
    expect(consumed).toBe(1);
  } finally {
    release();
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
}, 5000);

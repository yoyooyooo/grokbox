import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  BackendFailure,
  applyInferenceEvent,
  classifyProviderFailure,
  emptyStreamValidation,
  finishInferenceStream,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { backendKindForModel, STUB_ECHO_MODEL } from "@grokbox/runtime-kernel/selection";
import {
  createCountedSeams,
  fakeBackendAuthLayer,
  fakeModelBackendLayer,
  peekFakeSecret,
} from "@grokbox/runtime-kernel/testing";

const finish: InferenceEvent = { type: "backend_finish", finishReason: "stop" };

describe("backend contract", () => {
  test("prepare is zero credential/network and infer consumes one cold stream", async () => {
    const counts = createCountedSeams();
    const layer = fakeModelBackendLayer([
      { type: "text_delta", text: "hi" },
      finish,
    ], counts);
    const program = Effect.gen(function* () {
      const backend = yield* ModelBackend;
      const prepared = yield* backend.prepare({ id: "stub/echo" }, { ok: true });
      expect(counts.credential).toBe(0);
      expect(counts.network).toBe(0);
      const stream = backend.infer({}, prepared, Object.create(null));
      const first = yield* Stream.runCollect(stream);
      const second = yield* Stream.runCollect(stream);
      expect(first.map((event) => event.type)).toEqual(["text_delta", "backend_finish"]);
      expect(counts.network).toBe(1);
      expect(second.length).toBe(0);
    });
    await Effect.runPromise(Effect.provide(program, layer));
  });

  test("unknown backend kind is explicit", () => {
    expect(() => backendKindForModel({
      id: "pi/x",
      provider: "pi",
      model: "x",
      endpoint: "https://example.test",
      apiKeyRef: "env:K",
      capabilities: { vision: false, tools: false, images: false },
      dataTypes: ["text"],
    })).toThrow();
    expect(backendKindForModel(STUB_ECHO_MODEL)).toBe("echo");
  });

  test("fake auth pin/verify and scope release; secret stays off JSON", async () => {
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("synthetic-secret", counts);
    const leaked = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const pinned = yield* auth.pin({ apiKeyRef: "env:K" });
      expect(counts.credential).toBe(1);
      yield* auth.verify(pinned.lease);
      expect(JSON.stringify(pinned)).not.toContain("synthetic-secret");
      expect(peekFakeSecret(pinned.lease)).toBe("synthetic-secret");
      return pinned.lease;
    }).pipe(Effect.provide(layer))));
    expect(peekFakeSecret(leaked)).toBeUndefined();
  });

  test("stream validator catches missing name, id conflict, bad sequence, and missing finish", () => {
    const ok = emptyStreamValidation();
    applyInferenceEvent(ok, { type: "tool_start", toolCallId: "c1", toolName: "lookup" });
    applyInferenceEvent(ok, { type: "tool_delta", toolCallId: "c1", toolName: "lookup", argsTextDelta: "{" });
    applyInferenceEvent(ok, { type: "tool_complete", toolCallId: "c1", toolName: "lookup", args: { q: "1" } });
    applyInferenceEvent(ok, finish);
    expect(ok.finished).toBe(true);
    finishInferenceStream(ok);

    expect(() => applyInferenceEvent(emptyStreamValidation(), {
      type: "tool_delta", toolCallId: "c1", toolName: "lookup", argsTextDelta: "{}",
    })).toThrow(BackendFailure);

    const named = emptyStreamValidation();
    applyInferenceEvent(named, { type: "tool_start", toolCallId: "c1", toolName: "lookup" });
    expect(() => applyInferenceEvent(named, {
      type: "tool_start", toolCallId: "c1", toolName: "other",
    })).toThrow(BackendFailure);

    const open = emptyStreamValidation();
    applyInferenceEvent(open, { type: "text_delta", text: "x" });
    expect(() => finishInferenceStream(open)).toThrow(BackendFailure);

    const mixed = classifyProviderFailure({ auth: true, overflow: true });
    expect(mixed.code).toBe("provider_error");
    expect(mixed.overflowCandidate).toBe(false);
    expect(JSON.stringify(mixed)).not.toContain("response");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import {
  BackendFailure,
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  contextSnapshotBody,
  type ContextSnapshot,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { STUB_ECHO_MODEL, backendKindForModel } from "@grokbox/runtime-kernel/selection";
import { fakeBackendAuthLayer, unsealFakeAuth } from "@grokbox/runtime-kernel/testing";
import { lookupBackend, lookupBackendKind } from "../src/internal/backends/registry.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { aiSdkModelBackendLayer } from "../src/internal/backends/ai-sdk.ts";
import { mapSdkStreamPart } from "../src/internal/backends/openai-events.ts";
import { testEchoBackendLayer, testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";

const schema = { type: "object", properties: { q: { type: "string" } } };

function snapshot(messages: ContextSnapshot["messages"], extra?: Partial<ContextSnapshot>): ContextSnapshot {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "required-root-once" }],
    messages,
    tools: extra?.tools ?? [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    options: extra?.options ?? {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function openaiRecord(model = "gpt-4o-mini") {
  return {
    id: "openai/gpt-4o-mini",
    provider: "openai" as const,
    model,
    endpoint: "https://ccs.test/v1",
    apiKeyRef: "env:OPENAI_API_KEY",
    capabilities: { vision: false, tools: true, images: false },
    dataTypes: ["text", "tools"],
    contextWindowTokens: 200000,
  };
}

function sseResponse(events: unknown[], done = true): Response {
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (done) chunks.push("data: [DONE]\n\n");
  return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textChunk(text: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function finishChunk(reason: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
  };
}

function mockFetch(handler: (init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  const deny = async (_url: string | URL | Request, init?: RequestInit) => handler(init);
  return Object.assign(deny, { preconnect: deny }) as typeof fetch;
}

async function runSdk<A>(
  fetchImpl: typeof fetch,
  env: NodeJS.Dict<string>,
  body: (backend: any, auth: any) => Effect.Effect<A, unknown, unknown>,
): Promise<A> {
  const layer = testSdkBackendLayer({ fetch: fetchImpl, env });
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth;
    const backend = yield* ModelBackend;
    return yield* body(backend, auth);
  }).pipe(Effect.provide(layer))) as Effect.Effect<A, unknown>);
}

describe("backend conformance", () => {
  test("SDK mapper rejects unknown finish, bad tool JSON, and tool-error", () => {
    const tools = new Map<string, string>();
    expect(() => mapSdkStreamPart({ type: "finish", finishReason: "unknown" }, tools)).toThrow(BackendFailure);
    expect(() => mapSdkStreamPart({ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: "{bad" }, tools)).toThrow(BackendFailure);
    expect(() => mapSdkStreamPart({ type: "tool-error", error: new Error("tool failed") }, tools)).toThrow(BackendFailure);
    expect(mapSdkStreamPart({ type: "finish", finishReason: "stop" }, tools)).toEqual({ type: "backend_finish", finishReason: "stop" });
  });

  test("exact kind lookup rejects unknown kinds", () => {
    expect(lookupBackendKind("echo")).toBe("echo");
    expect(() => lookupBackendKind("pi")).toThrow(BackendFailure);
    expect(() => lookupBackend("cursor", { echo: 1, "openai-chat": 2, "openai-responses": 3 })).toThrow(BackendFailure);
    expect(backendKindForModel(openaiRecord())).toBe("openai-chat");
  });

  test("echo prepare has zero network and echoes user text", async () => {
    let http = 0;
    const deny = async () => {
      http += 1;
      return sseResponse([]);
    };
    const program = Effect.gen(function* () {
      const backend = yield* ModelBackend;
      const prepared = yield* backend.prepare(STUB_ECHO_MODEL, snapshot([{ role: "user", content: "hello-echo" }]));
      const events = yield* Stream.runCollect(backend.infer({}, prepared, Object.create(null)));
      return events;
    });
    const events = await Effect.runPromise(Effect.provide(program, echoModelBackendLayer));
    expect(http).toBe(0);
    expect(events.some((event) => event.type === "text_delta" && event.text === "hello-echo")).toBe(true);
    expect(events.at(-1)?.type).toBe("backend_finish");
    expect(JSON.stringify(events)).not.toContain("finish.response");
  });

  test("SDK SSE keeps text, real stop, and available usage; drop-empty output fails", async () => {
    let http = 0;
    let body: unknown;
    const fetch = mockFetch((init) => {
      http += 1;
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return sseResponse([
        textChunk("hello-sdk"),
        finishChunk("stop", { prompt_tokens: 7, completion_tokens: 3 }),
      ]);
    });
    const events = await runSdk(fetch, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const snap = snapshot([{ role: "user", content: "hello-sdk" }]);
      const prepared = yield* backend.prepare(openaiRecord(), snap);
      expect(http).toBe(0);
      const stream = backend.infer({}, prepared, pinned.lease);
      const first = yield* Stream.runCollect(stream);
      const second = yield* Stream.runCollect(stream);
      return { first, second, fingerprint: pinned.fingerprint };
    }));
    expect(http).toBe(1);
    const first = events.first as InferenceEvent[];
    expect(first.some((event) => event.type === "text_delta" && event.text.includes("hello-sdk"))).toBe(true);
    const finish = first.find((event) => event.type === "backend_finish");
    expect(finish).toMatchObject({ type: "backend_finish", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3 } });
    expect(events.second.length).toBe(0);
    expect(JSON.stringify(body)).toContain("hello-sdk");
    expect(JSON.stringify(body)).not.toContain("execute");
    expect(JSON.stringify(events)).not.toContain("sk-test");
    expect(events.fingerprint).toBe(sha256Text("sk-test"));
  });

  test("SDK EOF without provider finish and missing usage stay honest", async () => {
    const empty = mockFetch(() => sseResponse([]));
    await expect(runSdk(empty, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(openaiRecord(), snapshot([{ role: "user", content: "x" }]));
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }))).rejects.toBeTruthy();

    const textEof = mockFetch(() => sseResponse([textChunk("partial")], true));
    await expect(runSdk(textEof, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(openaiRecord(), snapshot([{ role: "user", content: "x" }]));
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }))).rejects.toBeTruthy();

    const noUsage = mockFetch(() => sseResponse([textChunk("ok"), finishChunk("stop")]));
    const events = await runSdk(noUsage, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(openaiRecord(), snapshot([{ role: "user", content: "x" }]));
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }));
    const listed = events as InferenceEvent[];
    const finish = listed.find((event) => event.type === "backend_finish");
    expect(finish).toMatchObject({ type: "backend_finish", finishReason: "stop" });
    expect(finish?.type === "backend_finish" ? finish.usage : undefined).toBeUndefined();
  });

  test("prepare freezes tools/options and rejects Responses seed before pin", async () => {
    let http = 0;
    let body: unknown;
    const fetch = mockFetch((init) => {
      http += 1;
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return sseResponse([textChunk("ok"), finishChunk("stop", { prompt_tokens: 1, completion_tokens: 1 })]);
    });
    await runSdk(fetch, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const snap = snapshot([{ role: "user", content: "stable" }], {
        tools: [{ name: "lookup", description: "original", inputSchema: schema }],
        options: { temperature: 0.2, toolChoice: "none" },
      });
      const prepared = yield* backend.prepare(openaiRecord(), snap);
      snap.tools[0]!.description = "mutated";
      snap.options.temperature = 0.9;
      snap.options.toolChoice = "required";
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }));
    expect(JSON.stringify(body)).toContain("original");
    expect(JSON.stringify(body)).not.toContain("mutated");
    expect((body as { temperature?: number }).temperature).toBe(0.2);
    expect((body as { tool_choice?: unknown }).tool_choice).toBe("none");

    let cred = 0;
    const seedFetch = mockFetch(() => {
      throw new Error("must not fetch");
    });
    await expect(runSdk(seedFetch, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const snap = snapshot([{ role: "user", content: "seed" }], { options: { seed: 17 } });
      const responses = { ...openaiRecord(), provider: "openai-responses" as const };
      yield* backend.prepare(responses, snap);
      cred += 1;
      yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
    }))).rejects.toMatchObject({ code: "unsupported_options" });
    expect(cred).toBe(0);
    expect(http).toBe(1);
  });

  test("final SDK HTTP bytes over budget fail before injected fetch", async () => {
    let http = 0;
    const fetch = mockFetch(() => {
      http += 1;
      return sseResponse([textChunk("x"), finishChunk("stop", { prompt_tokens: 1, completion_tokens: 1 })]);
    });
    const longModel = "m".repeat(ENCODED_PROVIDER_REQUEST_MAX_BYTES);
    await expect(runSdk(fetch, { OPENAI_API_KEY: "sk-test" }, (backend, auth) => Effect.gen(function* () {
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(openaiRecord(longModel), snapshot([{ role: "user", content: "tiny" }]));
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }))).rejects.toMatchObject({ code: "envelope_too_large" });
    expect(http).toBe(0);
  });

  test("interrupt aborts the SDK request without waiting for the next chunk", async () => {
    let aborted = 0;
    const fetch = mockFetch((init) => {
      const signal = init?.signal;
      if (signal?.aborted) aborted += 1;
      signal?.addEventListener("abort", () => { aborted += 1; });
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk("hello-hang"))}\n\n`));
          const onAbort = () => {
            try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ }
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const graph = testSdkBackendLayer({ fetch, env: { OPENAI_API_KEY: "sk-test" } });
    let first: InferenceEvent | undefined;
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      const a = yield* BackendAuth;
      const backend = yield* ModelBackend;
      const pinned = yield* a.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare(openaiRecord(), snapshot([{ role: "user", content: "hang" }]));
      yield* Stream.runForEach(backend.infer({}, prepared, pinned.lease), (event) => Effect.sync(() => {
        if (!first) first = event;
      }));
    }).pipe(Effect.provide(graph))));
    try {
      const until = Date.now() + 3000;
      while (!first && Date.now() < until) await Effect.runPromise(Effect.sleep("20 millis"));
      expect(first).toMatchObject({ type: "text_delta" });
      await Effect.runPromise(Fiber.interrupt(fiber));
      const abortUntil = Date.now() + 2000;
      while (aborted === 0 && Date.now() < abortUntil) await Effect.runPromise(Effect.sleep("20 millis"));
      expect(aborted).toBeGreaterThan(0);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  }, 10_000);

  test("Fake auth unseals into SDK backend; sibling live roots cannot cross-unseal", async () => {
    let header = "";
    const fetch = mockFetch((init) => {
      header = String((init?.headers as Record<string, string> | undefined)?.authorization
        ?? (init?.headers as Headers | undefined)?.get?.("authorization") ?? "");
      return sseResponse([textChunk("from-fake"), finishChunk("stop", { prompt_tokens: 1, completion_tokens: 1 })]);
    });
    const fakeAuth = fakeBackendAuthLayer("synthetic-secret");
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const backend = yield* ModelBackend;
      const pinned = yield* auth.pin({ apiKeyRef: "env:IGNORED" });
      const prepared = yield* backend.prepare(openaiRecord(), snapshot([{ role: "user", content: "x" }]));
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }).pipe(Effect.provide(Layer.merge(aiSdkModelBackendLayer(fetch, unsealFakeAuth), fakeAuth)))));
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(header.toLowerCase()).toContain("synthetic-secret");

    const a = createLiveBackendAuth({ OPENAI_API_KEY: "sk-a" });
    const b = createLiveBackendAuth({ OPENAI_API_KEY: "sk-b" });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      expect(a.unseal(pinned.lease)).toBe("sk-a");
      expect(() => b.unseal(pinned.lease)).toThrow(BackendFailure);
    }).pipe(Effect.provide(a.layer))));
  });

  test("live file auth pin/verify, no-follow, fingerprint, change and missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t23-auth-"));
    const file = join(dir, "key");
    await writeFile(file, "  sk-file\n", { mode: 0o600 });
    const auth = createLiveBackendAuth({});
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      const pinned = yield* service.pin({ apiKeyRef: `file:${file}` });
      expect(pinned.fingerprint).toBe(sha256Text("sk-file"));
      yield* service.verify(pinned.lease);
      expect(JSON.stringify(pinned)).not.toContain("sk-file");
      expect(auth.unseal(pinned.lease)).toBe("sk-file");
    }).pipe(Effect.provide(auth.layer))));

    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      return yield* service.pin({ apiKeyRef: `file:${join(dir, "missing")}` });
    }).pipe(Effect.provide(auth.layer))))).rejects.toBeTruthy();

    const link = join(dir, "link");
    await symlink(file, link);
    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      return yield* service.pin({ apiKeyRef: `file:${link}` });
    }).pipe(Effect.provide(auth.layer))))).rejects.toBeTruthy();

    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      const pinned = yield* service.pin({ apiKeyRef: `file:${file}` });
      yield* Effect.promise(() => writeFile(file, "sk-changed", { mode: 0o600 }));
      yield* service.verify(pinned.lease);
    }).pipe(Effect.provide(auth.layer))))).rejects.toBeTruthy();
  });

  test("root layer construction does not send model requests", () => {
    let http = 0;
    const fetch = mockFetch(() => {
      http += 1;
      return sseResponse([]);
    });
    testSdkBackendLayer({ fetch, env: {} });
    testEchoBackendLayer({});
    expect(http).toBe(0);
  });
});

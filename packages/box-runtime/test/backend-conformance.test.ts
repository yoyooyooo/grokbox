import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import {
  BackendFailure,
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  contextSnapshotBody,
  type ContextSnapshot,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { STUB_ECHO_MODEL, backendKindForModel } from "@grokbox/runtime-kernel/selection";
import { lookupBackend, lookupBackendKind } from "../src/internal/backends/registry.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { testEchoBackendLayer, testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { liveBackendAuthLayer, unsealAuthLease } from "../src/internal/io/credentials.node.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

const schema = { type: "object", properties: { q: { type: "string" } } };

function snapshot(messages: ContextSnapshot["messages"]): ContextSnapshot {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "required-root-once" }],
    messages,
    tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function openaiRecord() {
  return {
    id: "openai/gpt-4o-mini",
    provider: "openai" as const,
    model: "gpt-4o-mini",
    endpoint: "https://ccs.test/v1",
    apiKeyRef: "env:OPENAI_API_KEY",
    capabilities: { vision: false, tools: true, images: false },
    dataTypes: ["text", "tools"],
  };
}

function chatCompletion(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("backend conformance", () => {
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
      return chatCompletion();
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

  test("SDK mock fetch uses T21 codec; oversize is zero request; tools have schema only", async () => {
    let http = 0;
    let body: unknown;
    const deny = async (_url: string | URL | Request, init?: RequestInit) => {
      http += 1;
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return chatCompletion();
    };
    const fetch = Object.assign(deny, { preconnect: deny }) as typeof globalThis.fetch;
    const layer = testSdkBackendLayer({ fetch, env: { OPENAI_API_KEY: "sk-test" } });
    const snap = snapshot([{ role: "user", content: "hello-sdk" }]);
    const program = Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const backend = yield* ModelBackend;
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY", env: { OPENAI_API_KEY: "sk-test" } });
      const prepared = yield* backend.prepare(openaiRecord(), snap);
      expect(http).toBe(0);
      const stream = backend.infer({ snapshot: snap }, prepared, pinned.lease);
      const first = yield* Stream.runCollect(stream);
      const second = yield* Stream.runCollect(stream);
      return { first, second, fingerprint: pinned.fingerprint };
    }));
    const result = await Effect.runPromise(Effect.provide(program, layer));
    expect(http).toBe(1);
    expect(result.second.length).toBe(0);
    expect(JSON.stringify(body)).toContain("hello-sdk");
    expect(JSON.stringify(body)).toContain("lookup");
    expect(JSON.stringify(body)).not.toContain("execute");
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(result.fingerprint).toBe(sha256Text("sk-test"));

    let oversizeHttp = 0;
    const overFetch = Object.assign(async () => {
      oversizeHttp += 1;
      return chatCompletion();
    }, { preconnect: async () => chatCompletion() }) as typeof fetch;
    const huge = snapshot([{ role: "user", content: "x".repeat(ENCODED_PROVIDER_REQUEST_MAX_BYTES + 8) }]);
    const oversize = Effect.scoped(Effect.gen(function* () {
      const backend = yield* ModelBackend;
      return yield* backend.prepare(openaiRecord(), huge);
    }));
    await expect(Effect.runPromise(Effect.provide(oversize, testSdkBackendLayer({ fetch: overFetch, env: {} })))).rejects.toBeTruthy();
    expect(oversizeHttp).toBe(0);
  });

  test("live file auth pin/verify, no-follow, fingerprint, change and missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t23-auth-"));
    const file = join(dir, "key");
    await writeFile(file, "  sk-file\n", { mode: 0o600 });
    const layer = liveBackendAuthLayer({});
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const pinned = yield* auth.pin({ apiKeyRef: `file:${file}`, env: {} });
      expect(pinned.fingerprint).toBe(sha256Text("sk-file"));
      yield* auth.verify(pinned.lease);
      expect(JSON.stringify(pinned)).not.toContain("sk-file");
      expect(unsealAuthLease(pinned.lease)).toBe("sk-file");
    }).pipe(Effect.provide(layer))));

    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      return yield* auth.pin({ apiKeyRef: `file:${join(dir, "missing")}`, env: {} });
    }).pipe(Effect.provide(layer))))).rejects.toBeTruthy();

    const link = join(dir, "link");
    await symlink(file, link);
    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      return yield* auth.pin({ apiKeyRef: `file:${link}`, env: {} });
    }).pipe(Effect.provide(layer))))).rejects.toBeTruthy();

    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const pinned = yield* auth.pin({ apiKeyRef: `file:${file}`, env: {} });
      yield* Effect.promise(() => writeFile(file, "sk-changed", { mode: 0o600 }));
      yield* auth.verify(pinned.lease);
    }).pipe(Effect.provide(layer))))).rejects.toBeTruthy();
  });

  test("root layer construction does not send model requests", () => {
    let http = 0;
    const fetch = Object.assign(async () => {
      http += 1;
      return chatCompletion();
    }, { preconnect: async () => chatCompletion() }) as typeof globalThis.fetch;
    testSdkBackendLayer({ fetch, env: {} });
    testEchoBackendLayer({});
    expect(http).toBe(0);
  });
});

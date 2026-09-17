import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { testSdkBackendLayer } from "../../src/internal/roots/layers.ts";
import { reasoningModel, reasoningResponse, reasoningSnapshot } from "../reasoning-fixture.ts";
const observed: unknown[] = [];
for (const api of ["chat", "responses"] as const) {
  let count = 0, body: Record<string, any> | undefined;
  const fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    count++; body = JSON.parse(String(init?.body)); return reasoningResponse(api);
  }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const prepared = yield* backend.prepare({ ...reasoningModel(api), reasoning: { effort: "xhigh" } }, reasoningSnapshot());
    const pinned = yield* auth.pin({ apiKeyRef: "env:FIXTURE_KEY" });
    return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { FIXTURE_KEY: "synthetic" } })))));
  const finish = [...events].find(event => event.type === "backend_finish");
  assert.equal(count, 1); assert.equal(api === "chat" ? body?.reasoning_effort : body?.reasoning?.effort, "xhigh");
  assert.equal(finish?.usage?.reasoningTokens, 12); assert.equal(finish?.stream?.reasoning?.emitted, "xhigh");
  observed.push({ api, calls: count, effort: "xhigh", reasoningTokens: finish?.usage?.reasoningTokens });
}
console.log(JSON.stringify({ node: process.versions.node, observed }));

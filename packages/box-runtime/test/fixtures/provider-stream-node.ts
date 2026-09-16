// Isolated Node artifact probe. All provider IO is injected, never networked.
import { Effect, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { testSdkBackendLayer } from "../../src/internal/roots/layers.ts";
import { backendFailureObservation } from "../../src/internal/backends/failure-observation.ts";

const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1", systemMessages: [{ role: "system", content: "synthetic root" }], messages: [{ role: "user", content: "synthetic input" }], tools: [{ name: "lookup", inputSchema: { type: "object" } }], options: {} });
const model = { id: "node/owned", provider: "openai-chat" as const, model: "owned", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:TEST_KEY", contextWindowTokens: 200000, capabilities: { tools: true } };
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 3, completion_tokens: 2 } } : {}) });
const call = (name: string, args: string) => chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name, arguments: args } }] });
const scenarios = [
  { name: "valid", rows: [chunk({ content: "ok" }), chunk({}, "stop")] },
  { name: "trailing_args", rows: [call("lookup", '{"x":1}'), chunk({ tool_calls: [{ index: 0, function: { arguments: "junk" } }] }), chunk({}, "tool_calls")] },
  { name: "undeclared", rows: [call("not_declared", '{"x":1}'), chunk({}, "tool_calls")] },
  { name: "missing_finish", rows: [chunk({ content: "partial" })] },
];
const results = [];
for (const scenario of scenarios) {
  let httpCalls = 0, finishCount = 0;
  const fetch = Object.assign(async () => {
    httpCalls++;
    return new Response(scenario.rows.map(r => `data: ${JSON.stringify(r)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth, backend = yield* ModelBackend;
    const pinned = yield* auth.pin({ apiKeyRef: "env:TEST_KEY" });
    const prepared = yield* backend.prepare(model, { ...body, snapshotDigest: computeSnapshotDigest(body) });
    return yield* Effect.result(Stream.runForEach(backend.infer({}, prepared, pinned.lease), event => Effect.sync(() => { if (event.type === "backend_finish") finishCount++; })));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { TEST_KEY: "synthetic-only" } })))));
  results.push({ name: scenario.name, outcome: result._tag, httpCalls, finishCount,
    cause: result._tag === "Failure" ? backendFailureObservation(result.failure)?.normalizeCause : null });
}
process.stdout.write(JSON.stringify({ runtime: process.version, results }));

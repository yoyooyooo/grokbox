/** Explicit-spend, bounded provider conformance probe. Uses the production
 * backend and auth owner, but synthetic in-memory tools only: no Host, Gateway,
 * business replay, filesystem tools, native automations or production writes.
 *
 * bun packages/box-runtime/scripts/verify-provider-tools.ts --live --model <catalog-id> [--batch]
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { BackendFailure, contextSnapshotBody, streamFailureDiagnostic, type ContextSnapshot, type InferenceEvent, type PromptContentPart, type PromptMessage, type ToolDefinition } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest, sha256Text } from "@grokbox/runtime-kernel/hash";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { aiSdkModelBackendLayer } from "../src/internal/backends/ai-sdk.ts";

const { values } = parseArgs({ options: { live: { type: "boolean", default: false }, model: { type: "string" }, batch: { type: "boolean", default: false } }, strict: true });
if (!values.live || !values.model) throw new Error("Explicit --live and --model <catalog-id> are required; this probe spends provider quota.");
const store = openRuntimeStore(undefined, process.env);
const model = (await store.loadModels()).models[values.model];
if (!model || !["openai", "openai-chat", "openai-responses"].includes(model.provider)) throw new Error("An existing supported catalog model is required.");
const nonce = randomUUID(), keys = values.batch ? ["alpha", "beta", "gamma", "delta", "epsilon"] : ["alpha"];
const schema = (properties: Record<string, { type: string }>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const tools: ToolDefinition[] = [
  { name: "LookupFixture", description: "Read one synthetic key. Returns the value and nonce required by RecordFixture.", inputSchema: schema({ key: { type: "string" } }) },
  { name: "RecordFixture", description: "Record one synthetic value with the exact nonce returned by LookupFixture. Returns a receipt. Never record the same key twice.", inputSchema: schema({ key: { type: "string" }, value: { type: "string" }, nonce: { type: "string" } }) },
  { name: "FinishFixture", description: "Complete only after all synthetic records exist. Supply all receipt strings separated by commas.", inputSchema: schema({ receipts: { type: "string" } }) },
];
const messages: PromptMessage[] = [{ role: "user", content: `Use LookupFixture for each key: ${keys.join(", ")}. Record each returned value exactly once using RecordFixture with the returned nonce. Then call FinishFixture with all receipts. Use only the provided tools and exact argument names. Do not guess tool results. ${values.batch ? "You may batch independent calls." : "Complete the stages in order."}` }];
const expected = new Map(keys.map(key => [key, `fixture-${key}-${nonce.slice(0, 8)}`]));
const receipts = new Map<string, string>(), lookedUp = new Set<string>();
let httpCalls = 0, finished = false, duplicateRecords = 0, assistantHistoryPreserved = true;
let previousAssistantTexts: string[] = [];
const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  httpCalls++;
  if (httpCalls > 8) throw new Error("probe request budget exceeded");
  const body = JSON.parse(String(init?.body));
  if (model.provider !== "openai-responses") {
    const actual = (body.messages ?? []).filter((m: { role: string }) => m.role === "assistant").map((m: { content?: string }) => m.content ?? "");
    assistantHistoryPreserved &&= actual.length === previousAssistantTexts.length && actual.every((text: string, i: number) => text === previousAssistantTexts[i]);
  }
  return globalThis.fetch(input, init);
}, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
const auth = createLiveBackendAuth(process.env, { durableRoot: store.root });
const graph = Layer.mergeAll(auth.layer, aiSdkModelBackendLayer(fetchImpl, auth.unseal));
const observations: object[] = [];
const program = Effect.scoped(Effect.gen(function* () {
  const credentials = yield* BackendAuth, backend = yield* ModelBackend;
  const pinned = yield* credentials.pin({ apiKeyRef: model.apiKeyRef });
  for (let step = 0; step < 8 && !finished; step++) {
    const body = contextSnapshotBody({ version: 1, profileId: "provider-probe", abiIdentity: "host-abi-v1",
      systemMessages: [{ role: "system", content: "You are exercising a synthetic tool contract. Tool results are authoritative. Use only the declared tool names. All actions here are in-memory fixtures, not real-world tasks." }],
      messages, tools, options: { maxTokens: 4096, parallelToolCalls: !!values.batch } });
    const snapshot: ContextSnapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
    const prepared = yield* backend.prepare(model, snapshot);
    const events: InferenceEvent[] = [];
    const exit = yield* Effect.exit(Stream.runForEach(backend.infer({}, prepared, pinned.lease), event => Effect.sync(() => { events.push(event); })).pipe(Effect.timeout("90 seconds")));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause), diagnostic = streamFailureDiagnostic(error);
      observations.push({ step, outcome: "failed", code: error instanceof BackendFailure ? error.code : "probe_timeout_or_defect", diagnostic });
      return;
    }
    const terminal = events.findLast(e => e.type === "backend_finish");
    const calls = events.filter((e): e is Extract<InferenceEvent, { type: "tool_complete" }> => e.type === "tool_complete");
    const text = events.filter((e): e is Extract<InferenceEvent, { type: "text_delta" }> => e.type === "text_delta").map(e => e.text).join("");
    const reasoning = events.filter((e): e is Extract<InferenceEvent, { type: "reasoning_delta" }> => e.type === "reasoning_delta").map(e => e.text).join("");
    const parts: PromptContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
      ...calls.map(c => ({ type: "tool-call" as const, toolCallId: c.toolCallId, toolName: c.toolName, args: c.args }))];
    messages.push({ role: "assistant", content: parts }); previousAssistantTexts.push(text + reasoning);
    const results: PromptContentPart[] = [];
    for (const call of calls) {
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
      const key = typeof args.key === "string" ? args.key : "";
      let result: Record<string, string | boolean> = { ok: false, error: "fixture contract rejected" };
      if (call.toolName === "LookupFixture" && expected.has(key)) {
        lookedUp.add(key); result = { key, value: expected.get(key)!, nonce };
      } else if (call.toolName === "RecordFixture" && lookedUp.has(key) && args.value === expected.get(key) && args.nonce === nonce) {
        if (receipts.has(key)) duplicateRecords++;
        else receipts.set(key, sha256Text(`${nonce}:${key}`));
        result = { key, receipt: receipts.get(key)!, ok: duplicateRecords === 0 };
      } else if (call.toolName === "FinishFixture" && typeof args.receipts === "string") {
        const supplied = args.receipts.split(",").map(s => s.trim()).sort();
        finished = receipts.size === keys.length && JSON.stringify(supplied) === JSON.stringify([...receipts.values()].sort());
        result = { ok: finished };
      }
      results.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, result });
    }
    if (results.length) messages.push({ role: "tool", content: results });
    else messages.push({ role: "user", content: "The fixture has not completed. Follow the tool contract and use the declared tools to finish." });
    observations.push({ step, outcome: "ok", textBytes: Buffer.byteLength(text), reasoningBytes: Buffer.byteLength(reasoning), inlineThinking: text.includes("<think>"),
      toolCalls: calls.length, toolNames: calls.map(c => c.toolName), stream: terminal?.type === "backend_finish" ? terminal.stream : undefined });
  }
}).pipe(Effect.provide(graph)));
const result = await Effect.runPromiseExit(program);
const pass = Exit.isSuccess(result) && finished && duplicateRecords === 0 && assistantHistoryPreserved;
console.log(JSON.stringify({ pass, dependency: "external-real provider; production backend/auth; synthetic in-memory tools; no native Host", modelId: model.id,
  scenario: values.batch ? "batch-five" : "sequential", httpCalls, finished, records: receipts.size, expectedRecords: keys.length,
  duplicateRecords, assistantHistoryPreserved, observations,
  ...(Exit.isFailure(result) ? { error: "probe_failed_before_or_outside_stream" } : {}),
}, null, 2));
process.exitCode = pass ? 0 : 1;

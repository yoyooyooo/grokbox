import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Fiber, Layer } from "effect";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";

const hex = (ch: string) => ch.repeat(64);
const tool = { name: "lookup", inputSchema: { type: "object", properties: { n: { type: "number" } } } };
const chat = (delta: unknown, finish: string | null = null) => ({ id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}) });
function response(api: "chat" | "responses", first: boolean, bad: boolean) {
  let rows: unknown[];
  if (api === "chat") rows = first ? [
    chat({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"n\":" } }] }),
    chat({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "lookup", arguments: "{\"n\":2}" } }] }),
    chat({ tool_calls: [{ index: 0, function: { arguments: bad ? "BROKEN" : "1}" } }] }),
    chat({}, "tool_calls"),
  ] : [chat({ content: "Both results received" }), chat({}, "stop")];
  else {
    const item = (id: string, n: number) => ({ type: "function_call", id: `item_${id}`, call_id: `call_${id}`, name: "lookup", status: "completed", arguments: JSON.stringify({ n }) });
    const common = { id: "resp_synthetic", model: "synthetic", object: "response", created_at: 1 };
    rows = first ? [
      { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item("a", 1), status: "in_progress", arguments: "" } },
      { type: "response.output_item.added", output_index: 1, item: { ...item("b", 2), status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "item_b", output_index: 1, delta: '{"n":2}' },
      { type: "response.function_call_arguments.done", item_id: "item_b", output_index: 1, arguments: '{"n":2}' },
      { type: "response.output_item.done", output_index: 1, item: item("b", 2) },
      { type: "response.function_call_arguments.delta", item_id: "item_a", output_index: 0, delta: bad ? "BROKEN" : '{"n":1}' },
      { type: "response.function_call_arguments.done", item_id: "item_a", output_index: 0, arguments: '{"n":1}' },
      { type: "response.output_item.done", output_index: 0, item: item("a", 1) },
    ] : [
      { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Both results received" },
    ];
    rows.push({ type: "response.completed", response: { ...common, status: "completed", output: first ? [item("a", 1), item("b", 2)] : [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  }
  return new Response(rows.map(r => `data: ${JSON.stringify(r)}\n\n`).join("") + (api === "chat" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}

for (const api of ["chat", "responses"] as const) for (const bad of [false, true]) test(`actual production hook / ${api} / Unix batch ${bad ? "invalid" : "continuation"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-unix-")), generation = randomUUID();
  const agentId = `batch-${randomUUID()}`, turnId = randomUUID(), step1 = randomUUID(), step2 = randomUUID();
  const outcomes: unknown[] = [];
  const model = { id: "openai/batch", provider: api === "chat" ? "openai-chat" : "openai-responses", model: "synthetic", endpoint: "https://batch.invalid/v1", apiKeyRef: "env:SYNTHETIC_KEY", capabilities: { tools: true, vision: false }, contextWindowTokens: 200000 };
  const models = parseModelsFile({ version: 1, models: { [model.id]: model }, assignments: { main: null, agents: { [agentId]: model.id } } });
  await writeFile(join(root, "models.json"), JSON.stringify(models));
  const bodies: any[] = [];
  const fetchImpl = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return response(api, bodies.length === 1, bad);
  }, { preconnect: async () => undefined }) as typeof fetch;
  const auth = createLiveBackendAuth({ SYNTHETIC_KEY: "synthetic-no-live-credential" });
  const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(Layer.merge(admitAllAuthorityLayer()), Layer.merge(auth.layer), Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)), Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })));
  const fiber = Effect.runFork(Effect.scoped(serveModeld({ path: join(root, "modeld.sock"), generation, observeStep: (_r, outcome) => Effect.sync(() => { outcomes.push(outcome); }) }).pipe(Effect.andThen(Effect.never), Effect.provide(layer))) as Effect.Effect<never, unknown>);
  try {
    const until = Date.now() + 2000; while (!(await probeModeldHealth(root, 100))) { if (Date.now() > until) throw Error("fixture listener unavailable"); await new Promise(r => setTimeout(r, 10)); }
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root,
      binding: { generationId: hex("a"), activationId: "synthetic-operation", pid: 1, start: 1, sourceSha: hex("b"), identitySha: hex("c") },
      compile: { profileId: "patch-profile", profileSha256: hex("e"), sourceSha256: hex("b"), transformedSha256: hex("d") } });
    const session = hook({ agentId, sessionOptions: { invocationId: turnId, clientNonce: randomUUID() } });
    if (!isHostPromptSession(session)) throw Error("production hook did not select managed session");
    const executor = session.getExecutor([{ role: "system", content: "synthetic-root" }, { role: "user", content: "two lookups" }]);
    const handle = executor.stream({}, step1, [tool]);
    const released: any[] = []; const reading = (async () => { for await (const p of handle.fullStream) if (p.type.startsWith("tool-call")) released.push(p); })();
    void reading.catch(() => undefined);
    if (bad) {
      const rejected = await handle.response.catch(error => error);
      expect(rejected).toBeInstanceOf(Error); await reading.catch(() => undefined);
      expect(released).toEqual([]); expect(bodies.length, JSON.stringify({ rejected: { message: rejected.message, code: rejected.code, diagnostic: streamFailureDiagnostic(rejected) }, outcomes, journal: await readFile(join(root, "log", "events.ndjson"), "utf8").catch(() => "") })).toBe(1);
    } else {
      const first = await handle.response.catch(error => { throw new Error(`synthetic batch rejected: ${JSON.stringify({ diagnostic: streamFailureDiagnostic(error), outcomes })}`); }); await reading;
      expect(first.finishReason).toBe("tool-calls");
      const calls = released.filter(p => p.type === "tool-call");
      expect(calls.map(c => c.toolCallId)).toEqual(["call_a", "call_b"]);
      expect(calls.map(c => c.args)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(first.messages[0]?.content).toEqual(calls);
      // Owned Host capability fixture, not a claim about native side-effect atomicity.
      const executions: string[] = [];
      const results = calls.map(c => { executions.push(c.toolCallId); return { type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName, result: { value: c.args.n * 10 } }; });
      executor.appendMessages([...first.messages, { role: "tool", content: results }]);
      const second = await executor.stream({}, step2, [tool]).response;
      expect(second.finishReason).toBe("stop"); expect(bodies).toHaveLength(2);
      expect(executions).toEqual(["call_a", "call_b"]);
      if (api === "chat") {
        const history = bodies[1].messages;
        expect(history.find((m: any) => m.tool_calls)?.tool_calls.map((c: any) => c.id)).toEqual(["call_a", "call_b"]);
        expect(history.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual(["call_a", "call_b"]);
      } else {
        const history = bodies[1].input;
        expect(history.filter((m: any) => m.type === "function_call").map((m: any) => m.call_id)).toEqual(["call_a", "call_b"]);
        expect(history.filter((m: any) => m.type === "function_call_output").map((m: any) => m.call_id)).toEqual(["call_a", "call_b"]);
      }
      expect(JSON.stringify(bodies[1])).toContain('value');
    }
    expect(bodies[0].parallel_tool_calls).toBe(false);
    const untilJournal = Date.now() + 1000; let terminal: Record<string, unknown> | undefined;
    do {
      const journal = await readFile(join(root, "log", "events.ndjson"), "utf8").catch(() => "");
      const rows = journal.split("\n").flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });
      terminal = rows.find(e => e.name === "host_normalized_terminal" && e.stepId === step1);
      // Appending observations is asynchronous: STEP-2 can be recorded first.
      // A different STEP's terminal cannot satisfy this receipt barrier.
      if (terminal && (bad || rows.some(e => e.name === "host_normalized_terminal" && e.stepId === step2))) break;
      await new Promise(r => setTimeout(r, 10));
    } while (Date.now() < untilJournal);
    expect(terminal).toMatchObject({ terminalClass: bad ? "error" : "stop", toolCallCount: bad ? 0 : 2, diagnostic: { stream: { hostToolPolicy: "validated-batch", toolBatchState: bad ? "discarded" : "released" } } });
  } finally { await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore)); await rm(root, { recursive: true, force: true }); }
}, 12000);

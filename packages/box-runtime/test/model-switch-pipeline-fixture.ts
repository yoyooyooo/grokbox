import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCompletedRouteFixture } from "./modeld-authority-fixture.ts";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { submitModelChange } from "./model-management-fixture.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { bindCompiledHost } from "../src/internal/host/host-binding.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A = "openai/owned-a", B = "openai-responses/owned-b";
const FACT = "OWNED_RIVER=83";
const sha = "a".repeat(64);
const compile = { profileId: "fixture", profileSha256: sha, sourceSha256: sha, transformedSha256: sha };
const tools = [{ name: "lookup", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }];
const settings = { maxTokens: 128, parallelToolCalls: false };
const asSse = (rows: unknown[]) => new Response(rows.map(row => `data: ${typeof row === "string" ? row : JSON.stringify(row)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
});

function answer(model: string, requestNo: number) {
  if (model === "owned-a") {
    return asSse([
      { id: `chat-${requestNo}`, object: "chat.completion.chunk", choices: [{ index: 0,
        delta: requestNo === 1 ? { tool_calls: [{ index: 0, id: "lookup-1", type: "function", function: { name: "lookup", arguments: '{"key":"river"}' } }] } : { content: FACT },
        finish_reason: null }] },
      { id: `chat-${requestNo}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: requestNo === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }, "[DONE]",
    ]);
  }
  const common = { id: `response-${requestNo}`, model, object: "response", created_at: 1 };
  const message = { id: `message-${requestNo}`, type: "message", role: "assistant", content: [{ type: "output_text", text: FACT, annotations: [] }] };
  return asSse([
    { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: FACT },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { ...common, status: "completed", output: [message],
      usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50, input_tokens_details: { cached_tokens: 0 } } } },
  ]);
}

// Exercises real configuration use cases, native hook, modeld root/Unix, kernel
// and both SDK protocols. The official object and tool are independently owned
// fixtures, not a claim of a real official model or native durable-store roundtrip.
export type PipelineCheckpoint = {
  save: (directory: string, messages: unknown[]) => Promise<void>;
  load: (directory: string) => Promise<unknown[]>;
};
export async function exerciseModelSwitchPipeline(persistence?: PipelineCheckpoint) {
  const dir = await mkdtemp(join(tmpdir(), "gbox-switch-pipeline-"));
  const durableRoot = join(dir, "durable"), runRoot = join(dir, "run");
  await mkdir(join(durableRoot, "state"), { recursive: true, mode: 0o700 });
  const model = (provider: string, name: string) => ({ provider, model: name, endpoint: "https://owned.invalid/v1", apiKeyRef: "env:OWNED_KEY",
    capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text", "tools"], contextWindowTokens: 200000 });
  await writeFile(join(durableRoot, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
  await writeFile(join(durableRoot, "models.json"), JSON.stringify({ version: 3,
    models: { [A]: model("openai", "owned-a"), [B]: model("openai-responses", "owned-b") },
    assignments: { main: null, agents: { [OTHER]: { modelId: A } } } }), { mode: 0o600 });
  const identity = { pid: process.pid, start: 1, uid: 1, ppid: 1, exe: "/owned/node", cmdline: ["node"], ancestry: [1] };
  const binding = bindCompiledHost(identity, "owned-switch", compile);
  await writeCompletedRouteFixture(runRoot, { mode: "route", coverage: "attested", modeld: true, diskSha: sha,
    pid: process.pid, start: 1, identity, at: new Date().toISOString(), profileId: "fixture", transformedSha: sha,
    operationId: "owned-switch", compile });
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.origin !== "https://owned.invalid") throw Error("external_network_forbidden");
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "owned-a" }, { id: "owned-b" }] }), { status: 200 });
    }
    if (typeof init?.body !== "string") throw Error("external_network_forbidden");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.model !== "owned-a" && body.model !== "owned-b") throw Error("unselected_provider_model");
    requests.push({ path: url.pathname, body });
    return answer(body.model, requests.length);
  }, { preconnect: async () => undefined }) as typeof fetch;
  const ownershipRead = ownedOwnershipReader(process.pid);
  const store = openRuntimeStore(durableRoot, { OWNED_KEY: "owned-noncredential" });
  const rootOptions = { durableRoot, runRoot, env: { OWNED_KEY: "owned-noncredential" }, fetch: fetchImpl, ownershipRead };
  let server = await startModeldProcess(rootOptions);
  const nativeCalls: unknown[][] = [];
  const originalSession = { getModelId: () => "official-owned-fixture", getExecutor(state: unknown[]) {
    nativeCalls.push(structuredClone(state));
    return { getState: () => structuredClone(state) };
  } };
  const hook = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile });
  const open = (turnId: string) => hook({ agentId: AGENT, sessionOptions: { invocationId: turnId }, originalSession });
  try {
    expect(open("official-first")).toBe(originalSession);
    expect(requests).toHaveLength(0);
    await submitModelChange({ store, change: { kind: "bot-selection", agentId: AGENT, selection: { kind: "model", modelId: A } }, ownershipRead, env: { OWNED_KEY: "owned-noncredential" }, fetch: fetchImpl });
    const sessionA = open("turn-a");
    if (!isHostPromptSession(sessionA)) throw Error("managed_a_not_selected");
    const root = sessionA.getExecutor([
      { role: "system", content: "Preserve the Host-selected window.", id: "root-1" },
      { role: "user", content: FACT, id: "summary-1", providerOptions: { host: { isSummary: true } } },
    ]);
    const first = await root.stream({}, "a-tool", tools, settings).response;
    const content = first.messages[0]?.content;
    if (!Array.isArray(content)) throw Error("missing_tool_content");
    const call = content.find(part => part.type === "tool-call");
    expect(call).toEqual({ type: "tool-call", toolCallId: "lookup-1", toolName: "lookup", args: { key: "river" } });
    root.appendMessages(first.messages);
    let toolEffects = 0;
    const toolResult = (() => { toolEffects++; return { river: 83 }; })();
    root.appendMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "lookup-1", toolName: "lookup", result: toolResult }] }]);
    const checkpoint = root.getState();
    const savedB = await submitModelChange({ store, change: { kind: "bot-selection", agentId: AGENT, selection: { kind: "model", modelId: B } }, ownershipRead, env: { OWNED_KEY: "owned-noncredential" }, fetch: fetchImpl });
    expect(savedB).toMatchObject({ currentTurn: "unchanged", effectiveWhen: "next-turn", state: "succeeded" });
    expect((await store.loadModels()).assignments.agents[AGENT]?.modelId).toBe(B);
    // Configuration changed while A was between tool steps: the admitted TURN stays A.
    const afterTool = await root.stream({}, "a-after-tool", tools, settings).response;
    expect(requests.map(row => row.body.model)).toEqual(["owned-a", "owned-a"]);
    expect(root.getState()).toEqual(checkpoint);
    root.appendMessages(afterTool.messages);
    const sessionB = open("turn-b");
    if (!isHostPromptSession(sessionB)) throw Error("managed_b_not_selected");
    const rootB = sessionB.getExecutor(root.getState());
    const b = await rootB.stream({}, "b-first", tools, settings).response;
    rootB.appendMessages(b.messages);
    expect(requests[2]?.path).toBe("/v1/responses");
    await submitModelChange({ store, change: { kind: "bot-selection", agentId: AGENT, selection: { kind: "native" } }, ownershipRead });
    // The same rule applies when the future selection is official.
    const oldB = await rootB.stream({}, "b-after-reset", tools, settings).response;
    rootB.appendMessages(oldB.messages);
    expect(requests[3]?.body.model).toBe("owned-b");
    const selectedOfficial = open("official-return");
    expect(selectedOfficial).toBe(originalSession);
    const officialState = originalSession.getExecutor(rootB.getState()).getState();
    expect(officialState).toEqual(rootB.getState());
    expect(nativeCalls).toHaveLength(1);
    expect(requests).toHaveLength(4);
    // Public execution contract uses an owned JSON double. The explicit native
    // qualification supplies the original AgentStore/worker/independent reader.
    if (persistence) await persistence.save(dir, officialState);
    else await writeFile(join(dir, "owned-state.json"), JSON.stringify(officialState));
    await submitModelChange({ store, change: { kind: "bot-selection", agentId: AGENT, selection: { kind: "model", modelId: A } }, ownershipRead, env: { OWNED_KEY: "owned-noncredential" }, fetch: fetchImpl });
    await server.stop();
    server = await startModeldProcess(rootOptions);
    const nextA = open("turn-a-after-service-restart");
    if (!isHostPromptSession(nextA)) throw Error("managed_a_not_restored");
    const restoredState = persistence ? await persistence.load(dir) : JSON.parse(await readFile(join(dir, "owned-state.json"), "utf8"));
    const restored = nextA.getExecutor(restoredState);
    await restored.stream({}, "a-restored", tools, settings).response;
    expect(restored.getState()).toEqual(officialState);
    expect(requests.map(row => row.body.model)).toEqual(["owned-a", "owned-a", "owned-b", "owned-b", "owned-a"]);
    for (const { body } of requests) {
      expect(JSON.stringify(body)).toContain(FACT);
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.tools).toHaveLength(1);
    }
    for (const { body } of requests.slice(1)) {
      expect(JSON.stringify(body)).toContain("lookup-1");
      expect(JSON.stringify(body)).toContain("river");
    }
    expect(toolEffects).toBe(1);
    expect((await store.loadModels()).assignments.agents[OTHER]?.modelId).toBe(A);
    expect(await store.loadDesired()).toEqual({ version: 1, mode: "route" });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

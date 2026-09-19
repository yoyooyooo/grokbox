import type { ModelRecord, ReasoningPolicy } from "@grokbox/runtime-kernel/selection";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { bindCompiledHost } from "../src/internal/host/host-binding.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";

/** Actual production root, disk history, Unix protocol and Host hook; only the
 * upstream HTTP and native ownership capabilities are synthetic. No live paths. */
export async function providerRuntimeFixture(fetch: typeof globalThis.fetch, options: {
  api?: "chat" | "responses"; record?: ModelRecord; reasoning?: ReasoningPolicy; env?: Record<string, string>; ownershipRead?: OwnershipReader | null;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "provider-contract-"));
  const durableRoot = join(parent, "d"), runRoot = join(parent, "r"), agentId = randomUUID();
  await mkdir(join(durableRoot, "state"), { recursive: true, mode: 0o700 }); await mkdir(runRoot, { mode: 0o700 });
  const sha = "a".repeat(64), compile = { profileId: "fixture", profileSha256: sha, sourceSha256: sha, transformedSha256: sha };
  const identity = { pid: process.pid, start: 1, uid: 1, ppid: 1, exe: "/fixture/node", cmdline: ["node"], ancestry: [1] };
  const binding = bindCompiledHost(identity, "owned-operation", compile);
  const modelId = options.record?.id ?? "openai/fixture";
  const catalog = { version: 2, models: { [modelId]: options.record ?? { provider: options.api === "responses" ? "openai-responses" : "openai-chat", model: "fixture", endpoint: "https://fixture.invalid/v1", apiKeyRef: "env:FIXTURE_KEY", capabilities: { tools: true, vision: false, images: false }, contextWindowTokens: 200000 } }, assignments: { main: null, agents: { [agentId]: { modelId, ...(options.reasoning ? { reasoning: options.reasoning } : {}) } } } };
  await writeFile(join(durableRoot, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
  await writeFile(join(durableRoot, "models.json"), JSON.stringify(catalog));
  await writeAttestation(runRoot, { mode: "route", coverage: "attested", modeld: true, diskSha: sha, pid: process.pid, start: 1, identity,
    at: new Date().toISOString(), profileId: "fixture", transformedSha: sha, operationId: "owned-operation", launchMode: "direct-launch", compile });
  const server = await startModeldProcess({ durableRoot, runRoot, fetch, env: { FIXTURE_KEY: "synthetic-only", ...options.env },
    ownershipRead: options.ownershipRead === null ? undefined : options.ownershipRead ?? ownedOwnershipReader(process.pid) });
  const turnId = randomUUID(), nonce = randomUUID();
  const hook = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile });
  const session = hook({ agentId, sessionOptions: { invocationId: turnId, clientNonce: nonce } });
  if (!isHostPromptSession(session)) { await server.stop(); await rm(parent, { recursive: true, force: true }); throw Error("owned Host session missing"); }
  return { agentId, turnId, nonce, durableRoot, runRoot, modelId, session,
    newSession(nextTurn = randomUUID()) {
      const next = hook({ agentId, sessionOptions: { invocationId: nextTurn, clientNonce: randomUUID() } });
      if (!isHostPromptSession(next)) throw Error("owned next Host session missing");
      return next;
    },
    async rows() { const data = await readFile(join(runRoot, "log/events.ndjson"), "utf8").catch(() => ""); return data.split("\n").flatMap(line => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } }); },
    async stop() { await server.stop(); await rm(parent, { recursive: true, force: true }); },
    async changeModel() { await writeFile(join(durableRoot, "models.json"), JSON.stringify({ ...catalog, assignments: { main: null, agents: {} } })); },
  };
}
export const syntheticTool = { name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
export function successfulProviderResponse(api: "chat" | "responses" = "chat") {
  const rows = api === "chat" ? [
    { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "lookup", arguments: '{"q":"ok"}' } }] }, finish_reason: null }] },
    { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ] : [
    { type: "response.created", response: { id: "r", model: "fixture", created_at: 1 } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item_x", call_id: "call_x", name: "lookup", arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "item_x", output_index: 0, delta: '{"q":"ok"}' },
    { type: "response.function_call_arguments.done", item_id: "item_x", output_index: 0, arguments: '{"q":"ok"}' },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "item_x", call_id: "call_x", name: "lookup", arguments: '{"q":"ok"}', status: "completed" } },
    { type: "response.completed", response: { id: "r", model: "fixture", created_at: 1, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + (api === "chat" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}
export async function waitFixtureRows(fixture: Awaited<ReturnType<typeof providerRuntimeFixture>>, stepId: string) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const rows = await fixture.rows();
    if (rows.some(e => e.name === "host_normalized_terminal" && e.stepId === stepId) && rows.some(e => e.name === "model_step_terminal" && e.stepId === stepId)) return rows;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("owned terminal journal did not settle");
}

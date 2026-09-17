import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureContextPolicy } from "@grokbox/runtime-kernel/config";
import { BackendAuth, HostCompact, type HostContextMaintenance } from "@grokbox/runtime-kernel/ports";
import { makeContextMaintenanceRunner, memoryExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { ContextFailure, measureContext, type ContextMaterial, type ContextCandidate, type ContextMaintenanceRequest } from "@grokbox/runtime-kernel/contract";
import { parseModelsFile, modelForAgent, captureManagedSelection } from "@grokbox/runtime-kernel/selection";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { piCompactionAlgorithmLayer } from "../src/internal/context/pi-compaction.ts";
import { planPiCompaction } from "../src/internal/context/pi-projection.ts";
import { contextBudget, summaryBudget } from "@grokbox/runtime-kernel/config";

const A = "00000000-0000-4000-8000-000000000001";
const M = "owned/model";
const hex = (s: string) => s.repeat(64);
function longMaterial(): ContextMaterial {
  return { rootId: "owned-root", rootRevision: "old-revision", tools: [], options: { maxTokens: 512 }, messages: [
    { ref: "system", message: { role: "system", content: "Retain the user's intent." } },
    ...Array.from({ length: 50 }, (_, i) => ({ ref: `history-${i}`, message: { role: i % 2 ? "assistant" as const : "user" as const,
      content: `FACT_${i}=retained_${i}; ${"bounded ordinary history ".repeat(500)}` } })),
    { ref: "tool-call", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: "one-call", toolName: "read", args: {} }] } },
    { ref: "tool-result", message: { role: "user", content: [{ type: "tool-result", toolCallId: "one-call", toolName: "read", result: `${"x".repeat(6000)} FACT_TAIL=after_2000;` }] } },
    { ref: "failed-assistant", message: { role: "assistant", content: "" } },
    { ref: "next-input", preserve: true, message: { role: "user", content: "Continue, and remember FACT_TAIL." } },
  ] };
}
function request(selection: ReturnType<typeof captureManagedSelection>): ContextMaintenanceRequest {
  if (selection.kind !== "managed") throw new Error("fixture selection missing");
  return { operationId: "maintenance-owned", hostEpoch: { compile: hex("a"), source: hex("b"), profile: hex("c"),
    hostIdentity: "owned-host", bridgeDigest: hex("d"), wireVersion: "test-only" }, serviceEpoch: { incarnationId: "owned-epoch" },
    agentId: A, sessionId: "", rootId: "owned-root", rootRevision: "old-revision", selection: { ...selection, agentId: A },
    parent: { turnId: "new-turn", stepId: "new-step" }, reason: "preflight", deadlineMs: 180000 };
}
function candidateMaterial(before: ContextMaterial, candidate: ContextCandidate): ContextMaterial {
  const retained = before.messages.filter(row => candidate.retainedRefs.includes(row.ref));
  const index = retained.findIndex(row => row.message.role !== "system");
  const messages = [...retained];
  messages.splice(index < 0 ? messages.length : index, 0, { ref: `summary:${candidate.operationId}`, summary: true,
    message: { role: "user", content: `Summary of older context:\n${candidate.summary}` } });
  return { ...before, messages, rootRevision: sha256Text(canonicalJson(messages)) };
}

test("real SDK/local HTTP: failed old history compacts at local 128K with no provider overflow, then durable readback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-context-"));
  const path = join(dir, "root.json");
  let material = longMaterial();
  await writeFile(path, JSON.stringify({ material }), { mode: 0o600 });
  const requests: Record<string, unknown>[] = [];
  let commits = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data.toString();
    const parsed = JSON.parse(body); requests.push(parsed);
    const input = JSON.stringify(parsed.messages);
    // Summary is derived from the actual received material, never a canned fact.
    const facts = [...new Set(input.match(/FACT_[A-Z0-9_]+=[a-z0-9_]+/g) ?? [])];
    const text = `## Critical Context\n${facts.join("\n")}\n## Next Steps\nContinue the pending user request.`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 64, completion_tokens: 32, total_tokens: 96 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local HTTP missing");
  const models = parseModelsFile({ version: 2, models: { [M]: { provider: "openai", model: "owned-model",
    endpoint: `http://127.0.0.1:${address.port}/v1`, apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000,
    capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text", "tools"] } },
    assignments: { main: null, agents: { [A]: { modelId: M } } } });
  const policy = captureContextPolicy(undefined, M, A), model = modelForAgent(models, A)!;
  const req = request(captureManagedSelection(models, A));
  const owner: HostContextMaintenance = {
    authorize: identity => identity.agentId === A && identity.rootId === "owned-root" ? Effect.void : Effect.fail(new ContextFailure("not_admitted")),
    inspect: () => Effect.succeed(structuredClone(material)),
    preview: (_, candidate) => Effect.succeed(candidateMaterial(material, candidate)),
    commit: (_, candidate) => Effect.tryPromise({ try: async () => {
      if (candidate.sourceRootRevision !== material.rootRevision) throw new ContextFailure("stale_root");
      const next = candidateMaterial(material, candidate);
      const commit = { operationId: candidate.operationId, sourceRootRevision: material.rootRevision, rootRevision: next.rootRevision, outcome: "committed" as const, persisted: true };
      await writeFile(`${path}.tmp`, JSON.stringify({ material: next, commit }), { mode: 0o600 }); await rename(`${path}.tmp`, path);
      material = next; commits++; return commit;
    }, catch: () => new ContextFailure("commit_unknown") }),
    readCommit: () => Effect.tryPromise({ try: async () => { const saved = JSON.parse(await readFile(path, "utf8")); return saved.commit ? { ...saved.commit, material: saved.material } : undefined; }, catch: () => new ContextFailure("commit_unknown") }),
  };
  const auth = createLiveBackendAuth({ OWNED_KEY: "owned-not-a-real-credential" });
  const layers = auth.layer.pipe(Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)), Layer.merge(piCompactionAlgorithmLayer),
    Layer.merge(Layer.succeed(HostCompact, { request: () => Effect.succeed({ kind: "unavailable", reason: "capability_not_ready" }), maintenance: owner })));
  try {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const runner = yield* makeContextMaintenanceRunner(memoryExecutionHistory());
      const lease = yield* (yield* BackendAuth).pin({ apiKeyRef: model.apiKeyRef });
      const input = { request: req, model, policy, lease: lease.lease };
      const first = yield* runner.run(input);
      const duplicate = yield* runner.run(input);
      expect(duplicate).toEqual(first);
      expect(runner.activeCount()).toBe(0);
      return first;
    }).pipe(Effect.provide(layers))));
    expect(result.outcome).toBe("committed");
    expect(result.before.tokens).toBeGreaterThan(result.budget.inputTokens);
    expect(result.after.tokens).toBeLessThanOrEqual(result.budget.resumeThresholdTokens);
    expect(commits).toBe(1);
    expect(requests.length).toBe(result.summaryRequests);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(body => body.model === "owned-model" && body.max_tokens === 8192 && !body.tools)).toBe(true);
    const readback = JSON.parse(await readFile(path, "utf8"));
    expect(readback.material.messages.find((row: { ref: string }) => row.ref === "next-input")).toEqual(longMaterial().messages.at(-1));
    expect(JSON.stringify(readback.material)).toContain("FACT_0=retained_0");
    expect(JSON.stringify(readback.material)).toContain("FACT_TAIL=after_2000");
    expect(measureContext(readback.material).tokens).toBeLessThanOrEqual(result.budget.resumeThresholdTokens);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("projection coverage includes the complete tool result and never mutates native source refs", () => {
  const material = longMaterial(), original = structuredClone(material);
  const policy = captureContextPolicy(undefined, M, A);
  const plan = planPiCompaction(material, contextBudget(policy, 500000), summaryBudget(policy, 500000).inputTokens);
  const refs = [...plan.retainedRefs, ...plan.summarizedRefs];
  expect(new Set(refs).size).toBe(material.messages.length);
  expect(material).toEqual(original);
  const summarized = plan.summarizedRefs.includes("tool-result");
  expect(summarized ? plan.chunks.join("").includes("FACT_TAIL=after_2000") : plan.retainedRefs.includes("tool-result")).toBe(true);
  expect(plan.retainedRefs.includes("tool-call")).toBe(plan.retainedRefs.includes("tool-result"));
});

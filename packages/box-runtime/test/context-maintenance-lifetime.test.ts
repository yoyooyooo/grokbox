import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendAuth, HostCompact, ModelBackend, type HostContextMaintenance, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { ContextFailure, parseContextSnapshot, type ContextCandidate, type ContextCommitReceipt, type ContextMaterial, type ContextMaintenanceRequest, type ContextSnapshot, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { captureContextPolicy } from "@grokbox/runtime-kernel/config";
import { makeContextMaintenanceRunner, memoryExecutionHistory, type ExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { modelForAgent, parseModelsFile, captureManagedSelection } from "@grokbox/runtime-kernel/selection";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { openExecutionHistory } from "../src/internal/io/execution-history.node.ts";
import { piCompactionAlgorithmLayer } from "../src/internal/context/pi-compaction.ts";

const A = "00000000-0000-4000-8000-000000000001", M = "owned/maintenance-model", hex = (s: string) => s.repeat(64);
function world(options: { mode?: "preflight" | "manual"; small?: boolean; response?: "blank" | "missing-finish" | "tool"; budget?: number } = {}) {
  const models = parseModelsFile({ version: 2, models: { [M]: { provider: "openai", model: "owned-model", endpoint: "https://fixture.invalid/v1",
    apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000, capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text", "tools"] } },
    assignments: { main: null, agents: { [A]: { modelId: M } } } });
  const selected = captureManagedSelection(models, A); if (selected.kind !== "managed") throw Error("fixture");
  const model = modelForAgent(models, A)!;
  const policy = captureContextPolicy({ windowTokens: 32000, compaction: { reserveTokens: 4096, keepRecentTokens: 500,
    limits: { maxSummaryRequests: options.budget ?? 16 } } }, M, A);
  let material: ContextMaterial = { rootId: "owned-root", rootRevision: "old-root", options: {}, tools: [], messages: [
    { ref: "system", message: { role: "system", content: "Keep facts." } },
    ...options.small ? [] : Array.from({ length: 30 }, (_, i) => ({ ref: `h-${i}`, message: { role: i % 2 ? "assistant" as const : "user" as const, content: `FACT_${i}=value${i}; ${"history ".repeat(1000)}` } })),
    { ref: "current", preserve: true, message: { role: "user", content: "NEW_INPUT=one" } },
  ] };
  const request: ContextMaintenanceRequest = { operationId: "maintenance-op", hostEpoch: { compile: hex("a"), source: hex("b"), profile: hex("c"),
    bridgeDigest: hex("d"), hostIdentity: "owned-host", wireVersion: "v8" }, serviceEpoch: { incarnationId: "owned-service" }, agentId: A, sessionId: "",
    rootId: material.rootId, rootRevision: material.rootRevision, selection: { agentId: A, modelId: M, selectionRevision: selected.selectionRevision },
    reason: options.mode ?? "preflight", ...(options.mode === "manual" ? { confirmed: true } : { parent: { turnId: "turn", stepId: "step" } }), deadlineMs: 180000 };
  let commits = 0, requests = 0, producers = 0, commit: ContextCommitReceipt | undefined;
  let wait: Effect.Effect<void> = Effect.void;
  let started: Deferred.Deferred<void> | undefined;
  const prepared = new WeakMap<PreparedCall, ContextSnapshot>();
  const backend = Layer.succeed(ModelBackend, {
    prepare: (_model, snapshot) => Effect.sync(() => { const handle = {} as PreparedCall; prepared.set(handle, parseContextSnapshot(snapshot)); return handle; }),
    infer: (_call, handle) => Stream.unwrap(Effect.gen(function* () {
      const snapshot = prepared.get(handle)!; requests++; producers++;
      if (started) yield* Deferred.succeed(started, undefined);
      return Stream.fromEffect(wait.pipe(Effect.map((): InferenceEvent => {
        if (options.response === "tool") return { type: "tool_start", toolCallId: "unwanted", toolName: "write" };
        const facts = [...new Set(JSON.stringify(snapshot.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
        return { type: "text_delta", text: options.response === "blank" ? " " : `## Critical Context\n${facts.join("\n")}` };
      }))).pipe(Stream.concat(options.response === "missing-finish" ? Stream.empty : Stream.make({ type: "backend_finish", finishReason: "stop" } as const)),
        Stream.ensuring(Effect.sync(() => { producers--; })));
    })),
  });
  const preview = (candidate: ContextCandidate): ContextMaterial => {
    const messages = material.messages.filter(row => candidate.retainedRefs.includes(row.ref));
    messages.splice(1, 0, { ref: `summary:${candidate.operationId}`, summary: true, message: { role: "user", content: candidate.summary } });
    return { ...material, messages, rootRevision: sha256Text(canonicalJson(messages)) };
  };
  const owner: HostContextMaintenance = {
    authorize: () => Effect.void, inspect: () => Effect.succeed(structuredClone(material)), preview: (_, candidate) => Effect.succeed(preview(candidate)),
    commit: (_, candidate) => Effect.sync(() => { const next = preview(candidate); commits++; commit = { operationId: candidate.operationId,
      sourceRootRevision: material.rootRevision, rootRevision: next.rootRevision, outcome: "committed", persisted: true, material: next }; material = next; return commit; }),
    readCommit: () => Effect.succeed(commit),
  };
  const auth = createLiveBackendAuth({ OWNED_KEY: "synthetic-only" });
  const layer = auth.layer.pipe(Layer.merge(backend), Layer.merge(piCompactionAlgorithmLayer), Layer.merge(Layer.succeed(HostCompact, {
    request: () => Effect.succeed({ kind: "unavailable", reason: "capability_not_ready" }), maintenance: owner,
  })));
  return { layer, request, model, policy, counters: () => ({ requests, commits, producers }), current: () => material,
    gate: (block: Effect.Effect<void>, signal: Deferred.Deferred<void>) => { wait = block; started = signal; } };
}

for (const response of ["blank", "missing-finish", "tool"] as const) test(`summary ${response} never commits or retries`, async () => {
  const w = world({ response });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runner = yield* makeContextMaintenanceRunner(memoryExecutionHistory());
    const auth = yield* (yield* BackendAuth).pin({ apiKeyRef: w.model.apiKeyRef });
    return yield* Effect.result(runner.run({ ...w, lease: auth.lease }));
  }).pipe(Effect.provide(w.layer))));
  expect(result._tag).toBe("Failure");
  expect(w.counters()).toEqual({ requests: 1, commits: 0, producers: 0 });
  expect(w.current().rootRevision).toBe("old-root");
});

test("one summary request budget cannot be multiplied by internal chunk/merge calls", async () => {
  const w = world({ budget: 1 });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runner = yield* makeContextMaintenanceRunner(memoryExecutionHistory());
    const auth = yield* (yield* BackendAuth).pin({ apiKeyRef: w.model.apiKeyRef });
    return yield* Effect.result(runner.run({ ...w, lease: auth.lease }));
  }).pipe(Effect.provide(w.layer))));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "maintenance_budget_exhausted" } });
  expect(w.counters()).toEqual({ requests: 1, commits: 0, producers: 0 });
});

test("joined waiters share one source; cancelling one does not cancel the surviving waiter", async () => {
  const w = world();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runner = yield* makeContextMaintenanceRunner(memoryExecutionHistory());
    const auth = yield* (yield* BackendAuth).pin({ apiKeyRef: w.model.apiKeyRef });
    const started = yield* Deferred.make<void>(), release = yield* Deferred.make<void>();
    w.gate(Deferred.await(release), started);
    const input = { ...w, lease: auth.lease };
    const first = yield* Effect.forkScoped(runner.run(input));
    yield* Deferred.await(started);
    const second = yield* Effect.forkScoped(runner.run(input));
    yield* Effect.sleep("2 millis");
    yield* Fiber.interrupt(first);
    expect(w.counters().producers).toBe(1);
    yield* Deferred.succeed(release, undefined);
    const done = yield* Fiber.join(second);
    expect(done.outcome).toBe("committed");
    expect(w.counters().commits).toBe(1);
    expect(w.counters().producers).toBe(0);
    expect(runner.activeCount()).toBe(0);
  }).pipe(Effect.provide(w.layer))));
});

test("manual no-op is durably claimed and remains a no-op after a new service epoch", async () => {
  const w = world({ mode: "manual", small: true });
  const dir = await mkdtemp(join(tmpdir(), "context-noop-"));
  try {
    const first = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const history = yield* openExecutionHistory(dir, "service-first");
      const runner = yield* makeContextMaintenanceRunner(history);
      const auth = yield* (yield* BackendAuth).pin({ apiKeyRef: w.model.apiKeyRef });
      return yield* runner.run({ ...w, lease: auth.lease });
    }).pipe(Effect.provide(w.layer))));
    expect(first).toMatchObject({ outcome: "unchanged", summaryRequests: 0, persisted: false });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const history = yield* openExecutionHistory(dir, "service-second");
      const record = yield* history.getLatestMaintenance!(A, "");
      expect(record).toMatchObject({ state: "committed", receipt: first });
      expect(record?.identity).not.toHaveProperty("reason");
      expect(record?.identity).not.toHaveProperty("deadlineMs");
      expect(JSON.stringify(record)).not.toContain("NEW_INPUT");
    })));
    expect(w.counters()).toEqual({ requests: 0, commits: 0, producers: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

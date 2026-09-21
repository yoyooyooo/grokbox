import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { contextSnapshotBody, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import type { ModeldStepOutcome } from "../src/internal/modeld/step-outcome.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";

const HOST_EPOCH = {
  compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v4",
};

function snapshot() {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "required-root-once" }],
    messages: [{ role: "user", content: "ping" }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

async function waitForOutcome(read: () => ModeldStepOutcome | undefined): Promise<ModeldStepOutcome> {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("missing modeld step outcome");
}

function responsesStream(): Response {
  const common = { id: "resp-admit", model: "grok-4.6", object: "response", created_at: 1 };
  const rows = [
    { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_text.done", item_id: "msg-1", output_index: 0, content_index: 0, text: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
    { type: "response.completed", response: { ...common, status: "completed", output: [], usage: {
      input_tokens: 4, output_tokens: 1, total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } },
  ];
  return new Response(rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("modeld route admit after Host capture", () => {
  test("dangling Pi-style assignment journals not_admitted, never silent defect", async () => {
    const file = parseModelsFile({
      version: 3,
      models: {},
      assignments: { main: null, agents: { a: { modelId: "sub2api-xai/grok-4.6" } } },
    });
    const generation = randomUUID();
    let observed: ModeldStepOutcome | undefined;
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ah94-dangling-"));
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path: join(dir, "modeld.sock"),
        generation,
        observeStep: (_request, outcome) => Effect.sync(() => { observed = outcome; }),
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(fakeConfigurationReadLayer({ models: () => file, desired: { version: 1, mode: "route" } }).pipe(
          Layer.merge(admitAllAuthorityLayer()),
          Layer.merge(echoModelBackendLayer),
          Layer.merge(liveBackendAuthLayer({})),
          Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
        )),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const frames = await requestModeld(dir, {
        version: WIRE_VERSION,
        method: "run-step",
        hostEpoch: HOST_EPOCH,
        serviceEpoch: { incarnationId: generation },
        agentId: "a",
        turnId: "t-dangling",
        stepId: "s-dangling",
        selection: { agentId: "a", modelId: "sub2api-xai/grok-4.6", selectionRevision: "a".repeat(64) },
        snapshot: snapshot(),
      }, 4_000);
      expect(frames.at(-1)).toMatchObject({ ok: false, error: { code: "not_admitted" } });
      const outcome = await waitForOutcome(() => observed);
      expect(outcome).toMatchObject({ outcome: "error", phase: "admission", failureCode: "not_admitted", eventCount: 0 });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    }
  }, 12_000);

  test("pi-provider openai-responses pin reaches the provider instead of defecting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ah94-pi-"));
    const piPath = join(dir, "pi-models.json");
    const secret = "sk-ah94-pi-reuse";
    await writeFile(piPath, `${JSON.stringify({
      providers: {
        "sub2api-xai": {
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
          apiKey: secret,
          models: [{ id: "grok-4.6", contextWindow: 500000 }],
        },
      },
    })}\n`, { mode: 0o600 });
    const model = {
      id: "sub2api-xai/grok-4.6",
      provider: "openai-responses" as const,
      model: "grok-4.6",
      endpoint: "https://example.test/v1",
      apiKeyRef: "pi-provider:sub2api-xai",
      capabilities: { vision: true, tools: true, images: true },
      dataTypes: ["text", "tools", "images"],
      contextWindowTokens: 500000,
      catalog: "pi" as const,
    };
    const file = parseModelsFile({
      version: 3,
      models: { [model.id]: model },
      assignments: { main: null, agents: { a: { modelId: model.id } } },
    });
    const pinned = file.models[model.id];
    if (!pinned) throw new Error("expected parsed pi model");
    const generation = randomUUID();
    let observed: ModeldStepOutcome | undefined;
    let http = 0;
    let sawBearer = false;
    const fetchImpl = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      http += 1;
      const header = init && typeof init === "object" && "headers" in init ? init.headers : undefined;
      const authorization = header instanceof Headers ? header.get("authorization")
        : header && typeof header === "object" && !Array.isArray(header)
          ? String((header as Record<string, unknown>).authorization ?? (header as Record<string, unknown>).Authorization ?? "")
          : "";
      sawBearer = authorization === `Bearer ${secret}`;
      return responsesStream();
    }, { preconnect: async () => undefined }) as typeof fetch;
    const auth = createLiveBackendAuth({}, { catalog: [{ id: "pi", modelsPath: piPath }], homedir: dir });
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path: join(dir, "modeld.sock"),
        generation,
        observeStep: (_request, outcome) => Effect.sync(() => { observed = outcome; }),
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(fakeConfigurationReadLayer({ models: () => file, desired: { version: 1, mode: "route" } }).pipe(
          Layer.merge(admitAllAuthorityLayer()),
          Layer.merge(auth.layer),
          Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
          Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
        )),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const frames = await requestModeld(dir, {
        version: WIRE_VERSION,
        method: "run-step",
        hostEpoch: HOST_EPOCH,
        serviceEpoch: { incarnationId: generation },
        agentId: "a",
        turnId: "t-pi",
        stepId: "s-pi",
        selection: {
          agentId: "a",
          modelId: pinned.id,
          selectionRevision: computeSelectionRevision({ agentId: "a", model: pinned }),
        },
        snapshot: snapshot(),
      }, 8_000);
      expect(http).toBeGreaterThan(0);
      expect(sawBearer).toBe(true);
      expect(frames.some((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal")).toBe(true);
      const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string; code?: string };
      expect(terminal.outcome).toBe("ok");
      expect(terminal.code).toBeUndefined();
      const outcome = await waitForOutcome(() => observed);
      expect(outcome.failureCode).not.toBe("defect");
      expect(outcome).toMatchObject({ outcome: "ok", phase: "complete" });
      expect(outcome.eventCount).toBeGreaterThan(0);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    }
  }, 15_000);
});

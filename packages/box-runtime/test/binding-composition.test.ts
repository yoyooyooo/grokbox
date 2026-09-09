import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { CONFIG_READ_MAX_BYTES, contextSnapshotBody, type ContextSnapshot } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer, runStep } from "@grokbox/runtime-kernel/inference";
import { ConfigurationRead } from "@grokbox/runtime-kernel/ports";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeAdmissionAuthorityLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { configurationReadLayer, openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { testEchoBackendLayer } from "../src/internal/roots/layers.ts";
import { captureHostSelection } from "../src/internal/host/selection.node.ts";

function snapshot(): ContextSnapshot {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }],
    messages: [{ role: "user", content: "hello-echo" }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function run<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>);
}

describe("T24 live composition", () => {
  test("echo + live BackendAuth runStep works for empty apiKeyRef across STEPs", async () => {
    const file = parseModelsFile({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-a": STUB_ECHO_MODEL_ID } },
    });
    const captured = captureManagedSelection(file, "agent-a");
    if (captured.kind !== "managed") throw new Error("expected managed");
    const req = {
      hostEpoch: {
        compile: "c",
        source: "s",
        profile: "p",
        hostIdentity: "h",
        bridgeDigest: "b",
        wireVersion: "v3",
      },
      serviceEpoch: { incarnationId: "svc-1" },
      agentId: "agent-a",
      turnId: "turn-echo",
      stepId: "step-1",
      selection: { agentId: "agent-a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
      snapshot: snapshot(),
    };
    const graph = testEchoBackendLayer({}).pipe(
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(fakeConfigurationReadLayer({ models: () => file })),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1" })),
    );
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* runStep(req);
      if (!("stream" in first)) throw new Error("expected live");
      const events = yield* Stream.runCollect(first.stream);
      const second = yield* runStep({ ...req, stepId: "step-2", bindingId: first.bindingId });
      if (!("stream" in second)) throw new Error("expected live");
      const more = yield* Stream.runCollect(second.stream);
      return { events: [...events], more: [...more] };
    }).pipe(Effect.provide(graph))));
    expect(result.events.some((event) => event.type === "text_delta" && event.text.includes("hello-echo"))).toBe(true);
    expect(result.more.some((event) => event.type === "backend_finish")).toBe(true);
  });

  test("Effect configuration read uses the same 128 KiB no-follow bound as Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-t24-config-"));
    const small = {
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-a": STUB_ECHO_MODEL_ID } },
    };
    await writeFile(join(root, "models.json"), `${JSON.stringify(small)}\n`);
    expect(captureHostSelection(root, "agent-a").kind).toBe("managed");
    const padding = "x".repeat(CONFIG_READ_MAX_BYTES);
    await writeFile(join(root, "models.json"), `${JSON.stringify({ ...small, padding })}\n`);
    expect(captureHostSelection(root, "agent-a").kind).toBe("official");
    const store = openRuntimeStore(root);
    await expect(run(Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ConfigurationRead;
        return yield* config.snapshot();
      }).pipe(Effect.provide(configurationReadLayer(store))),
    ))).rejects.toBeTruthy();
  });
});

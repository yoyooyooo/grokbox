import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { Effect, Fiber, Layer } from "effect";
import { BackendFailure, contextSnapshotBody, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeModelBackendLayer,
} from "@grokbox/runtime-kernel/testing";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { COMPACT_WAIT_MS, sameConnectionHostCompactLayer } from "../src/internal/modeld/same-connection-compact.ts";
import { acceptModeldFrame, clientSessionFor, decodeModeldFrame, encodeModeldFrame, parseV4ControlFrame } from "../src/internal/wire/modeld-wire.ts";

const EVENTS: InferenceEvent[] = [
  { type: "text_delta", text: "ok" },
  { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
];

const overflow = new BackendFailure("overflow_candidate", {
  overflowCandidate: true,
  overflowEvidence: { providerCode: "context_length_exceeded", httpStatus: 400 },
});

function file() {
  return parseModelsFile({
    version: 1,
    models: {
      "openai/gpt": {
        provider: "openai",
        model: "gpt",
        endpoint: "https://api.example.test/v1",
        apiKeyRef: "env:KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
        contextWindowTokens: 200000,
      },
    },
    assignments: { main: null, agents: { a: "openai/gpt" } },
  });
}

function snapshot(text: string) {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "p",
    abiIdentity: "abi",
    systemMessages: [{ role: "system", content: "r" }],
    messages: [{ role: "user", content: text }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function stepBody(generation: string) {
  const models = file();
  const captured = captureManagedSelection(models, "a");
  if (captured.kind !== "managed") throw new Error("managed");
  return {
    version: WIRE_VERSION,
    method: "run-step",
    hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v4" },
    serviceEpoch: { incarnationId: generation },
    agentId: "a",
    turnId: "t-v4",
    stepId: "step-1",
    selection: { agentId: "a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
    snapshot: snapshot("hi"),
  };
}

async function drive(path: string, body: unknown, resume: (control: ReturnType<typeof parseV4ControlFrame>) => unknown) {
  return await new Promise<unknown[]>((resolve, reject) => {
    const socket = createConnection({ path });
    let session = clientSessionFor(body);
    const frames: unknown[] = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timeout")), 8_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(frames);
    };
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame(body)); }
      catch (error) { finish(error instanceof Error ? error : new Error("write")); }
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (!settled) {
        const decoded = decodeModeldFrame(buf);
        if (decoded == null) break;
        if ("error" in decoded) {
          finish(new Error(decoded.error));
          return;
        }
        buf = Buffer.from(decoded.rest);
        try {
          const next = acceptModeldFrame(session, decoded.value);
          session = next.session;
          if (next.control) {
            socket.write(encodeModeldFrame(resume(next.control)));
            continue;
          }
          frames.push(decoded.value);
          if (next.done) {
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error("malformed"));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => { if (!settled) finish(new Error("incomplete")); });
  });
}

describe("same-connection v4 HostCompact adapter", () => {
  test("compact-request then matching resume-step yields one attempt1 terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-compact-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: (incoming) => sameConnectionHostCompactLayer(incoming),
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const compacted = snapshot("compacted");
    const frames = await drive(path, stepBody(generation), (control) => {
      expect(control.method).toBe("compact-request");
      if (control.method !== "compact-request") throw new Error("compact");
      return {
        version: 4,
        method: "resume-step",
        agentId: control.agentId,
        turnId: control.turnId,
        stepId: control.stepId,
        bindingId: control.bindingId,
        selectionRevision: control.selectionRevision,
        recoveryNonce: control.recoveryNonce,
        snapshot: compacted,
      };
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(2);
    expect(frames.some((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal")).toBe(true);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string };
    expect(terminal.outcome).toBe("ok");
    expect(frames.filter((frame) => frame && typeof frame === "object" && (frame as { method?: string }).method === "compact-request")).toHaveLength(0);
  });

  test("wrong nonce resume does not start attempt1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-nonce-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: (incoming) => sameConnectionHostCompactLayer(incoming),
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = await drive(path, stepBody(generation), (control) => {
      if (control.method !== "compact-request") throw new Error("compact");
      return {
        version: 4,
        method: "resume-step",
        agentId: control.agentId,
        turnId: control.turnId,
        stepId: control.stepId,
        bindingId: control.bindingId,
        selectionRevision: control.selectionRevision,
        recoveryNonce: "wrong-nonce",
        snapshot: snapshot("compacted"),
      };
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(1);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string; code?: string };
    expect(terminal.outcome).toBe("error");
  });

  test("no resume-step before COMPACT_WAIT_MS is overflow, not attempt1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-compact-wait-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: (incoming) => sameConnectionHostCompactLayer(incoming),
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = await new Promise<unknown[]>((resolve, reject) => {
      const socket = createConnection({ path });
      const body = stepBody(generation);
      let session = clientSessionFor(body);
      const collected: unknown[] = [];
      let buf = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("timeout")), COMPACT_WAIT_MS + 3_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(collected);
      };
      socket.on("connect", () => {
        try { socket.write(encodeModeldFrame(body)); }
        catch (error) { finish(error instanceof Error ? error : new Error("write")); }
      });
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (!settled) {
          const decoded = decodeModeldFrame(buf);
          if (decoded == null) break;
          if ("error" in decoded) {
            finish(new Error(decoded.error));
            return;
          }
          buf = Buffer.from(decoded.rest);
          try {
            const next = acceptModeldFrame(session, decoded.value);
            session = next.session;
            if (next.control) continue;
            collected.push(decoded.value);
            if (next.done) {
              finish();
              return;
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error("malformed"));
            return;
          }
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => { if (!settled) finish(new Error("incomplete")); });
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(1);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string };
    expect(terminal.outcome).toBe("error");
  }, COMPACT_WAIT_MS + 4_000);
});

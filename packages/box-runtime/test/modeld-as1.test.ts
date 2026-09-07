import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildModelEnvelope } from "../src/envelope.ts";
import { createModeld, type ModelPin } from "../src/modeld.ts";
import {
  AS1_SKELETON_PROVIDER,
  as1Accepts,
  collectAs1Chunks,
  createAs1ModeldDriver,
  type As1GenerateChunk,
  type As1GenerateRequest,
} from "../src/modeld-as1.ts";
import { STUB_ECHO_MODEL, STUB_ECHO_MODEL_ID, type ModelsFile } from "../src/models.ts";
import { FAKE_BINDING, submitRequest } from "./modeld-fixture.ts";
import { within } from "./scripted-stream.ts";

const envelope = buildModelEnvelope([{ role: "user", content: "fixture prompt" }]);
const as1Model = {
  id: "as1/fake",
  provider: AS1_SKELETON_PROVIDER,
  model: "fake",
  endpoint: "as1:fake",
  apiKeyRef: "env:AS1_FAKE",
  capabilities: { vision: false, tools: false, images: false },
  dataTypes: ["text"],
};
const pin: ModelPin = {
  model: as1Model,
  assignment: "main",
  fingerprint: "a".repeat(64),
  credentialFingerprint: null,
};
const as1Models: ModelsFile = {
  version: 1,
  models: { "as1/fake": as1Model },
  assignments: { main: "as1/fake", agents: {} },
};

async function* emit(...chunks: As1GenerateChunk[]): AsyncIterable<As1GenerateChunk> {
  for (const chunk of chunks) yield chunk;
}

describe("A+S1 ModeldDriver skeleton", () => {
  test("accepts only the as1 skeleton provider, never stub/echo", () => {
    expect(as1Accepts(as1Model)).toBe(true);
    expect(as1Accepts(STUB_ECHO_MODEL)).toBe(false);
    expect(as1Accepts({ ...as1Model, provider: "fake", id: "fake/fast" })).toBe(false);
    expect(as1Accepts({ ...as1Model, id: STUB_ECHO_MODEL_ID })).toBe(false);
  });

  test("buffers multiple generate chunks into one StreamPart[] complete() result", async () => {
    const driver = createAs1ModeldDriver({
      generate: () => emit({ type: "text", text: "hel" }, { type: "text", text: "lo" }, { type: "finish" }),
    });
    const parts = await driver.complete({
      pin, envelope, invocationId: "step-1", agentId: "agent-tom", signal: new AbortController().signal,
    });
    expect(parts).toEqual([
      { type: "text-delta", textDelta: "hel" },
      { type: "text-delta", textDelta: "lo" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("appends finish when the generate iterable ends without one", async () => {
    const parts = await collectAs1Chunks(emit({ type: "text", text: "only" }), new AbortController().signal);
    expect(parts).toEqual([
      { type: "text-delta", textDelta: "only" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("honors abort before and during collect", async () => {
    const started = new AbortController();
    started.abort();
    await expect(collectAs1Chunks(emit({ type: "text", text: "nope" }), started.signal)).rejects.toThrow(/cancelled/);

    const live = new AbortController();
    let blocked = false;
    async function* delayed(): AsyncIterable<As1GenerateChunk> {
      yield { type: "text", text: "hello" };
      await new Promise<void>((resolve, reject) => {
        blocked = true;
        const timer = setTimeout(resolve, 5_000);
        live.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        }, { once: true });
      });
      yield { type: "text", text: "world" };
    }
    const pending = collectAs1Chunks(delayed(), live.signal);
    while (!blocked) await Bun.sleep(1);
    live.abort();
    await expect(within(pending)).rejects.toThrow(/cancelled/);
  });

  test("passes fingerprint-only pin into generate and does not add a secret field", async () => {
    let seen: As1GenerateRequest | undefined;
    const driver = createAs1ModeldDriver({
      generate: async function* (request) {
        seen = request;
        yield { type: "text", text: "ok" };
      },
    });
    const fingerprinted: ModelPin = { ...pin, credentialFingerprint: "b".repeat(64) };
    await driver.complete({
      pin: fingerprinted, envelope, invocationId: "step-2", agentId: "agent-tom",
      signal: new AbortController().signal,
    });
    expect(seen?.pin.credentialFingerprint).toBe("b".repeat(64));
    expect(seen?.pin).not.toHaveProperty("secret");
    expect(JSON.stringify(seen)).not.toMatch(/sk-|Bearer /);
  });

  test("reuses the existing admission kernel; stub models are wrong-model", async () => {
    const driver = createAs1ModeldDriver({
      generate: () => emit({ type: "text", text: "hel" }, { type: "text", text: "lo" }, { type: "finish" }),
    });
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => as1Models,
      credentialFingerprint: () => "c".repeat(64),
      driver,
    });
    try {
      expect(await kernel.admit(submitRequest(kernel, "as1-step"))).toMatchObject({
        ok: true,
        dispatched: true,
        modelId: "as1/fake",
        parts: [
          { type: "text-delta", textDelta: "hel" },
          { type: "text-delta", textDelta: "lo" },
          { type: "finish", reason: "stop" },
        ],
      });
    } finally { kernel.stop(); }

    const stubKernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => ({ version: 1, models: { [STUB_ECHO_MODEL_ID]: STUB_ECHO_MODEL }, assignments: { main: STUB_ECHO_MODEL_ID, agents: {} } }),
      driver,
    });
    try {
      expect(await stubKernel.admit(submitRequest(stubKernel, "stub-blocked"))).toMatchObject({
        ok: false, code: "wrong-model",
      });
    } finally { stubKernel.stop(); }
  });
});

describe("A+S1 SDK fence", () => {
  const sdkImport = /(?:from|import\(|require\()\s*["'](ai(?:\/[^"']*)?|@ai-sdk(?:\/[^"']*)?|openai(?:\/[^"']*)?|@anthropic-ai(?:\/[^"']*)?)["']/;
  const srcDir = join(import.meta.dir, "../src");
  const hostFiles = ["preload.ts", "seam.ts", "session.ts", "hook.ts", "transform.ts"];

  test("preload/seam/session/hook/transform do not import AI SDK packages", async () => {
    for (const file of hostFiles) {
      const text = await readFile(join(srcDir, file), "utf8");
      expect(text.match(sdkImport), file).toBeNull();
    }
  });

  test("skeleton and default Unix server stay SDK-free; Host/cli manifests do not depend on AI SDK", async () => {
    const as1 = await readFile(join(srcDir, "modeld-as1.ts"), "utf8");
    const ipc = await readFile(join(srcDir, "modeld-ipc.ts"), "utf8");
    expect(as1.match(sdkImport)).toBeNull();
    expect(as1).not.toMatch(/from "\.\/(preload|seam|hook|transform)\.ts"/);
    expect(ipc).not.toContain("createAs1ModeldDriver");
    expect(ipc).not.toContain("createOpenAiModeldDriver");
    expect(ipc).toContain("STUB_ECHO_MODEL_ID");

    const manifests = [
      join(import.meta.dir, "../../../package.json"),
      join(import.meta.dir, "../../cli/package.json"),
    ];
    for (const manifest of manifests) {
      const json = JSON.parse(await readFile(manifest, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const deps of [json.dependencies ?? {}, json.devDependencies ?? {}]) {
        expect(Object.keys(deps).some((name) => name === "ai" || name === "openai" || name.startsWith("@ai-sdk/"))).toBe(false);
      }
    }
  });
});

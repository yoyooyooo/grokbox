import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelEnvelope } from "../src/envelope.ts";
import { sha256Text } from "../src/hash.ts";
import {
  createCompositeModeldDriver,
  createDefaultCredentialFingerprint,
  createDefaultModeldDriver,
  createStubEchoModeldDriver,
  stubEchoAccepts,
  STUB_ECHO_PARTS,
} from "../src/modeld-default.ts";
import { createModeld } from "../src/modeld.ts";
import { createOpenAiModeldDriver, openAiAccepts } from "../src/modeld-openai.ts";
import { STUB_ECHO_MODEL, type ModelsFile } from "../src/models.ts";
import { callStubModeld, startStubModeldServer } from "../src/modeld-ipc.ts";
import { modeldStorePorts } from "../src/modeld-store.ts";
import { FAKE_BINDING, modeldFixture, submitRequest } from "./modeld-fixture.ts";

const openaiModel = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};

const openaiModels: ModelsFile = {
  version: 1,
  models: { [openaiModel.id]: openaiModel, [STUB_ECHO_MODEL.id]: STUB_ECHO_MODEL },
  assignments: { main: openaiModel.id, agents: {} },
};

const stubAssigned: ModelsFile = {
  version: 1,
  models: { [STUB_ECHO_MODEL.id]: STUB_ECHO_MODEL, [openaiModel.id]: openaiModel },
  assignments: { main: STUB_ECHO_MODEL.id, agents: {} },
};

describe("composite / default modeld driver", () => {
  test("accepts stub OR openai; stub complete still echoes; openai never overlaps stub", () => {
    const driver = createDefaultModeldDriver({
      env: { OPENAI_API_KEY: "test-key" },
      hardOff: true,
    });
    expect(stubEchoAccepts(STUB_ECHO_MODEL)).toBe(true);
    expect(openAiAccepts(STUB_ECHO_MODEL)).toBe(false);
    expect(driver.accepts(STUB_ECHO_MODEL)).toBe(true);
    expect(driver.accepts(openaiModel)).toBe(true);
    expect(driver.accepts({ ...openaiModel, provider: "as1" })).toBe(false);
  });

  test("composite stub path returns STUB_ECHO_PARTS without credential hook", async () => {
    let fingerprints = 0;
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => stubAssigned,
      credentialFingerprint: () => {
        fingerprints += 1;
        return "a".repeat(64);
      },
      driver: createDefaultModeldDriver({ hardOff: true, env: {} }),
    });
    try {
      const result = await kernel.admit(submitRequest(kernel, "stub-echo"));
      expect(result).toMatchObject({
        ok: true,
        dispatched: true,
        modelId: "stub/echo",
        parts: STUB_ECHO_PARTS,
      });
      expect(fingerprints).toBe(0);
    } finally {
      kernel.stop();
    }
  });

  test("openai admit with env key fingerprint + injected stream; missing key → credential-unavailable", async () => {
    const env = { OPENAI_API_KEY: "  offline-test-key\n" };
    const expectedFp = sha256Text("offline-test-key");
    const driver = createDefaultModeldDriver({
      env,
      streamEvents: async function* () {
        yield { type: "text-delta", text: "hi" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => openaiModels,
      credentialFingerprint: createDefaultCredentialFingerprint(env),
      driver,
    });
    try {
      const ok = await kernel.admit(submitRequest(kernel, "openai-ok"));
      expect(ok).toMatchObject({
        ok: true,
        dispatched: true,
        modelId: openaiModel.id,
        parts: [{ type: "text-delta", textDelta: "hi" }, { type: "finish", reason: "stop" }],
      });
      if (!ok.ok) throw new Error("expected ok");
      expect(ok.fingerprint).toBe(sha256Text(JSON.stringify([openaiModel, expectedFp])));
    } finally {
      kernel.stop();
    }

    const missing = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => openaiModels,
      credentialFingerprint: createDefaultCredentialFingerprint({}),
      driver: createDefaultModeldDriver({ env: {}, hardOff: true }),
    });
    try {
      expect(await missing.admit(submitRequest(missing, "openai-missing"))).toMatchObject({
        ok: false,
        code: "credential-unavailable",
      });
    } finally {
      missing.stop();
    }
  });

  test("openai complete re-reads env via the same C1 Effect; secret never enters parts", async () => {
    const env = { OPENAI_API_KEY: "  offline-resolve-key\n" };
    const expectedFp = sha256Text("offline-resolve-key");
    const driver = createDefaultModeldDriver({
      env,
      fetch: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => openaiModels,
      credentialFingerprint: createDefaultCredentialFingerprint(env),
      driver,
    });
    try {
      const result = await kernel.admit(submitRequest(kernel, "openai-resolve"));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected dispatched complete");
      expect(result.dispatched).toBe(true);
      expect(result.modelId).toBe(openaiModel.id);
      expect(result.fingerprint).toBe(sha256Text(JSON.stringify([openaiModel, expectedFp])));
      expect(result.parts.some((part) => part.type === "error")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("offline-resolve-key");
    } finally {
      kernel.stop();
    }
  });

  test("hardOff still blocks network on openai complete path", async () => {
    const driver = createCompositeModeldDriver({
      stub: createStubEchoModeldDriver(),
      openai: createOpenAiModeldDriver({
        resolveApiKey: async () => "test-key",
        hardOff: true,
      }),
    });
    await expect(driver.complete({
      pin: {
        model: openaiModel,
        assignment: "main",
        fingerprint: "a".repeat(64),
        credentialFingerprint: "b".repeat(64),
      },
      envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "hard-off",
      agentId: "agent-tom",
      signal: new AbortController().signal,
    })).rejects.toThrow(/openai-hard-off/);
  });

  test("Unix submit waits past idle 1s once a complete request is owned", async () => {
    const f = await modeldFixture();
    await f.store.saveModels(openaiModels);
    const env = { OPENAI_API_KEY: "offline-delay-key" };
    const server = await startStubModeldServer({
      ...f,
      durableRoot: f.durable,
      defaultDriver: {
        env,
        streamEvents: async function* () {
          await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          yield { type: "text-delta", text: "slow" };
          yield { type: "finish", finishReason: "stop" };
        },
      },
    });
    try {
      const started = Date.now();
      const reply = await callStubModeld(f.runRoot, submitRequest(server, "slow-openai"), 5000);
      expect(reply).toMatchObject({
        ok: true,
        modelId: openaiModel.id,
        parts: [{ type: "text-delta", textDelta: "slow" }, { type: "finish", reason: "stop" }],
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
    } finally {
      await server.stop();
    }
  });

  test("default Unix startStubModeldServer uses composite; stub still echoes; openai admit with inject", async () => {
    const f = await modeldFixture();
    const stubServer = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      const reply = await callStubModeld(f.runRoot, submitRequest(stubServer, "default-stub"));
      expect(reply).toMatchObject({ ok: true, modelId: "stub/echo", parts: STUB_ECHO_PARTS });
    } finally {
      await stubServer.stop();
    }

    const f2 = await modeldFixture();
    await f2.store.saveModels(openaiModels);
    const env = { OPENAI_API_KEY: "unix-test-key" };
    const server = await startStubModeldServer({
      ...f2,
      durableRoot: f2.durable,
      defaultDriver: {
        env,
        streamEvents: async function* () {
          yield { type: "text-delta", text: "unix" };
          yield { type: "finish" };
        },
      },
      // Custom ports without credentialFingerprint must keep store hooks and still get default fingerprint.
      ports: modeldStorePorts(f2.durable, f2.runRoot),
    });
    try {
      const reply = await callStubModeld(f2.runRoot, submitRequest(server, "default-openai"));
      expect(reply).toMatchObject({
        ok: true,
        modelId: openaiModel.id,
        parts: [{ type: "text-delta", textDelta: "unix" }, { type: "finish", reason: "stop" }],
      });
    } finally {
      await server.stop();
    }
  });
});

describe("default driver fence", () => {
  const sdkImport = /(?:from|import\(|require\()\s*["'](ai(?:\/[^"']*)?|@ai-sdk(?:\/[^"']*)?|openai(?:\/[^"']*)?)["']/;
  const srcDir = join(import.meta.dir, "../src");

  test("Host/preload/seam/session stay SDK-free; ipc has no direct SDK import; route admit is stub or openai*", async () => {
    for (const file of ["preload.ts", "seam.ts", "session.ts", "hook.ts", "transform.ts", "modeld-ipc.ts"]) {
      const text = await readFile(join(srcDir, file), "utf8");
      expect(text.match(sdkImport), file).toBeNull();
    }
    const ipc = await readFile(join(srcDir, "modeld-ipc.ts"), "utf8");
    expect(ipc).toContain("createDefaultModeldDriver");
    expect(ipc).toContain("createDefaultCredentialFingerprint");
    expect(ipc).not.toMatch(/from "\.\/modeld-openai\.ts"/);

    const def = await readFile(join(srcDir, "modeld-default.ts"), "utf8");
    expect(def).toContain("createOpenAiModeldDriver");
    expect(def).toContain("createCompositeModeldDriver");

    const models = await readFile(join(srcDir, "models.ts"), "utf8");
    expect(models).toContain("route admits only stub/echo or openai*");
  });

  test("Host/preload/seam/session/hook/ipc stay Effect-free; preload bundle does not include effect", async () => {
    const effectImport = /(?:from|import\(|require\()\s*["']effect(?:\/[^"']*)?["']/;
    for (const file of ["preload.ts", "seam.ts", "session.ts", "hook.ts", "transform.ts", "modeld-ipc.ts"]) {
      const text = await readFile(join(srcDir, file), "utf8");
      expect(text.match(effectImport), file).toBeNull();
    }
    const creds = await readFile(join(srcDir, "modeld-credentials.ts"), "utf8");
    expect(creds).toMatch(/from "effect"/);
    expect(creds).not.toMatch(/from "\.\/(preload|seam|hook|transform|session)\.ts"/);
    const def = await readFile(join(srcDir, "modeld-default.ts"), "utf8");
    expect(def.match(effectImport)).toBeNull();
    expect(def).toContain('import("./modeld-credentials.ts")');

    const dir = await mkdtemp(join(tmpdir(), "grokbox-preload-effect-"));
    const outfile = join(dir, "preload.cjs");
    const built = Bun.spawn(
      ["bun", "build", join(srcDir, "preload.ts"), "--outfile", outfile, "--target", "node", "--format", "cjs"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await built.exited).toBe(0);
    const bundle = await readFile(outfile, "utf8");
    expect(bundle).not.toMatch(/from ["']effect["']|require\(["']effect["']\)|node_modules\/effect/);
    expect(bundle).not.toContain("fingerprintApiKeyRef");
    expect(bundle).not.toContain("materializeApiKeyRef");
  });
});

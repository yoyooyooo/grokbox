import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { BackendAuth } from "@grokbox/runtime-kernel/ports";
import { persistModelsDocument, resolveExternalCatalog, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  CREDENTIAL_SECRET_MAX_BYTES,
  createLiveBackendAuth,
  fingerprintApiKeyRef,
  fingerprintSecret,
  materializeApiKeyRef,
} from "../src/internal/io/credentials.node.ts";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { modelsPath } from "../src/internal/io/paths.ts";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grokbox-c1-"));
}

describe("modeld C1 credentials", () => {
  test("env hit trims; miss/empty fail; fingerprint is stable sha256 hex", async () => {
    const env = { OPENAI_API_KEY: "  sk-offline\n" };
    const secret = await materializeApiKeyRef("env:OPENAI_API_KEY", env);
    expect(secret).toBe("sk-offline");
    const fp = await fingerprintApiKeyRef("env:OPENAI_API_KEY", env);
    expect(fp).toBe(sha256Text("sk-offline"));
    expect(fp).toBe(fingerprintSecret(secret));
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(fp).toBe(await fingerprintApiKeyRef("env:OPENAI_API_KEY", env));
    expect(JSON.stringify({ fp })).not.toContain("sk-offline");

    await expect(materializeApiKeyRef("env:MISSING", {})).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("env:EMPTY", { EMPTY: "" })).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("env:BLANK", { BLANK: "  \n\t" })).rejects.toBeInstanceOf(BoxRuntimeError);
    await expect(materializeApiKeyRef("sk-live", { OPENAI_API_KEY: "x" })).rejects.toBeInstanceOf(BoxRuntimeError);
  });

  test("pi command-form env values are rejected and not used as Bearer", async () => {
    const command = "!/usr/bin/env sh -lc 'printf %s placeholder-not-a-key'";
    await expect(materializeApiKeyRef("env:GROKBOX_SUB2API_KEY", { GROKBOX_SUB2API_KEY: `  ${command}\n` })).rejects.toMatchObject({
      code: "credential_invalid",
      message: "Referenced env credential holds a command reference, not a secret.",
    });
    expect(await materializeApiKeyRef("env:GROKBOX_SUB2API_KEY", { GROKBOX_SUB2API_KEY: "opaque-token-not-a-command" })).toBe("opaque-token-not-a-command");
    const dir = await tmpDir();
    const file = join(dir, "cmd");
    await writeFile(file, `${command}\n`, { mode: 0o600 });
    await expect(materializeApiKeyRef(`file:${file}`, {})).rejects.toMatchObject({ code: "credential_invalid" });
  });

  test("file hit/miss/too-large/non-regular; env and file fingerprint the same trimmed payload", async () => {
    const dir = await tmpDir();
    const file = join(dir, "key");
    await writeFile(file, "  sk-file\n", { mode: 0o600 });
    expect(await materializeApiKeyRef(`file:${file}`, {})).toBe("sk-file");
    expect(await fingerprintApiKeyRef(`file:${file}`, {})).toBe(sha256Text("sk-file"));
    expect(await fingerprintApiKeyRef("env:K", { K: "sk-file" })).toBe(sha256Text("sk-file"));

    const blank = join(dir, "blank");
    await writeFile(blank, "\n  \n");
    await expect(materializeApiKeyRef(`file:${blank}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    await expect(materializeApiKeyRef(`file:${join(dir, "missing")}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const huge = join(dir, "huge");
    await writeFile(huge, "x".repeat(CREDENTIAL_SECRET_MAX_BYTES + 1));
    await expect(materializeApiKeyRef(`file:${huge}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const nested = join(dir, "nested");
    await mkdir(nested);
    await expect(materializeApiKeyRef(`file:${nested}`, {})).rejects.toMatchObject({ code: "credential_invalid" });

    const link = join(dir, "link");
    await symlink(file, link);
    await expect(materializeApiKeyRef(`file:${link}`, {})).rejects.toMatchObject({ code: "credential_invalid" });
  });

  test("Promise facade maps already-aborted signal to cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(materializeApiKeyRef("env:K", { K: "v" }, ac.signal)).rejects.toThrow(/cancelled/);
  });

  test("pi-provider reuses a string Pi apiKey; command-form fails closed", async () => {
    const dir = await tmpDir();
    const piPath = join(dir, "pi-models.json");
    const secret = "sk-pi-reuse-secret";
    await writeFile(piPath, `${JSON.stringify({
      providers: {
        "sub2api-xai": {
          api: "openai-responses",
          baseUrl: "https://example.test/",
          apiKey: `  ${secret}\n`,
          models: [{ id: "grok-4.6" }],
        },
        cmd: {
          api: "openai-responses",
          baseUrl: "https://example.test/",
          apiKey: "!/usr/bin/env sh -lc 'printf %s leaked'",
          models: [{ id: "grok-4.6" }],
        },
      },
    })}\n`, { mode: 0o600 });
    const context = { catalog: [{ id: "pi" as const, modelsPath: piPath }], homedir: dir };
    expect(await materializeApiKeyRef("pi-provider:sub2api-xai", {}, undefined, context)).toBe(secret);
    const fp = await fingerprintApiKeyRef("pi-provider:sub2api-xai", {}, undefined, context);
    expect(fp).toBe(sha256Text(secret));
    expect(JSON.stringify({ fp })).not.toContain(secret);
    await expect(materializeApiKeyRef("pi-provider:cmd", {}, undefined, context)).rejects.toMatchObject({
      code: "credential_invalid",
      message: "Referenced Pi provider credential holds a command reference, not a secret.",
    });
    await expect(materializeApiKeyRef("pi-provider:missing", {}, undefined, context)).rejects.toMatchObject({
      code: "credential_invalid",
    });

    const auth = createLiveBackendAuth({}, context);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      const pinned = yield* service.pin({ apiKeyRef: "pi-provider:sub2api-xai" });
      expect(auth.unseal(pinned.lease)).toBe(secret);
      expect(pinned.fingerprint).toBe(sha256Text(secret));
      expect(JSON.stringify(pinned)).not.toContain(secret);
    }).pipe(Effect.provide(auth.layer))));
  });

  test("store persist of Pi-adapted models does not write Pi secrets", async () => {
    const root = await tmpDir();
    const piPath = join(root, "pi-models.json");
    const secret = "sk-pi-must-not-persist";
    await writeFile(piPath, `${JSON.stringify({
      providers: {
        "sub2api-xai": {
          api: "openai-responses",
          baseUrl: "https://example.test/",
          apiKey: secret,
          models: [{ id: "grok-4.6" }],
        },
      },
    })}\n`, { mode: 0o600 });
    const store = openRuntimeStore(root, {});
    const native = parseModelsFile({
      version: 3,
      externalCatalog: [{ id: "pi", modelsPath: piPath }],
      models: {},
      assignments: { main: null, agents: {} },
    });
    await store.saveModels(native);
    const loaded = await store.loadModels();
    expect(loaded.models["sub2api-xai/grok-4.6"]?.apiKeyRef).toBe("pi-provider:sub2api-xai");
    expect(JSON.stringify(loaded.models)).not.toContain(secret);
    const context = { durableRoot: root, homedir: root };
    expect(await materializeApiKeyRef(loaded.models["sub2api-xai/grok-4.6"]!.apiKeyRef, {}, undefined, context)).toBe(secret);
    const auth = createLiveBackendAuth({}, context);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* BackendAuth;
      const pinned = yield* service.pin({ apiKeyRef: "pi-provider:sub2api-xai" });
      expect(auth.unseal(pinned.lease)).toBe(secret);
    }).pipe(Effect.provide(auth.layer))));
    await store.saveModels(loaded);
    const disk = await readFile(modelsPath(root), "utf8");
    expect(disk).not.toContain(secret);
    expect(disk).not.toContain("pi-provider:");
    const persisted = persistModelsDocument(loaded);
    expect(persisted.models["sub2api-xai/grok-4.6"]).toBeUndefined();
    expect(persisted.credentials).toBeUndefined();
    expect(JSON.stringify(resolveExternalCatalog(native, {
      pi: JSON.parse(await readFile(piPath, "utf8")),
    }).models)).not.toContain(secret);
  });
});

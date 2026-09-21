import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { persistModelCredential } from "../src/internal/io/persist-model-credential.node.ts";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";

const ID = "openai-responses/grok-4.6";
const KEY = "owned-test-key-DO-NOT-OUTPUT";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gbox-persist-key-"));
  const store = openRuntimeStore(root);
  const models = parseModelsFile({ version: 3, models: {
    [ID]: { provider: "openai-responses", model: "grok-4.6", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:OLD_KEY", contextWindowTokens: 500000 },
    "openai/other": { provider: "openai", model: "other", endpoint: "https://other.invalid/v1", apiKeyRef: "env:OTHER_KEY", contextWindowTokens: 32000 },
  }, assignments: { main: null, agents: { test2: { modelId: ID } } } });
  await store.saveModels(models);
  return { root, store, models, close: () => rm(root, { recursive: true, force: true }) };
}

test("persist one key, keep assignments/other models, and resolve from a fresh process without old env", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const input = { store: f.store, modelId: ID, piProvider: "ccs-sub2api-xai", confirmed: true,
      readCredential: async (provider: string, model: string) => { reads++; expect(provider).toBe("ccs-sub2api-xai"); expect(model).toBe("grok-4.6"); return `${KEY}\n`; } };
    const receipt = await persistModelCredential(input);
    expect(receipt.persisted).toBe(true);
    expect(receipt.reused).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    const current = await f.store.loadModels();
    expect(current.assignments).toEqual(f.models.assignments);
    expect(current.models["openai/other"]).toEqual(f.models.models["openai/other"]);
    expect(current.models[ID]).toEqual({ ...f.models.models[ID], apiKeyRef: receipt.apiKeyRef });
    const path = receipt.apiKeyRef.slice(5);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.root, "secrets"))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toBe(KEY);
    const adapter = new URL("../src/internal/io/credentials.node.ts", import.meta.url).pathname;
    const child = spawnSync(process.execPath, ["--eval", `const {materializeApiKeyRef}=await import(${JSON.stringify(adapter)}); const key=await materializeApiKeyRef(process.argv[1],{}); console.log(key===${JSON.stringify(KEY)}?"RESOLVED":"FAILED");`, receipt.apiKeyRef], {
      env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("RESOLVED");
    expect(`${child.stdout}${child.stderr}`).not.toContain(KEY);
    const again = await persistModelCredential(input);
    expect(again.apiKeyRef).toBe(receipt.apiKeyRef);
    expect(again.reused).toBe(true);
    expect(reads).toBe(2);
    expect(await readdir(join(f.root, "secrets"))).toHaveLength(1);
  } finally { await f.close(); }
});

test("confirmation, target, source and cancellation are checked before reading secrets", async () => {
  const f = await fixture();
  let reads = 0;
  try {
    const base = { store: f.store, modelId: ID, piProvider: "ccs-sub2api-xai", confirmed: true,
      readCredential: async () => { reads++; return KEY; } };
    for (const change of [{ confirmed: false }, { modelId: "missing" }, { modelId: "constructor" }, { piProvider: "x;echo" }, { signal: AbortSignal.abort() }]) {
      await expect(persistModelCredential({ ...base, ...change })).rejects.toBeDefined();
    }
    expect(reads).toBe(0);
    expect(await f.store.loadModels()).toEqual(f.models);
  } finally { await f.close(); }
});

test("empty, command-shaped, multiline and over-limit credentials never enter configuration", async () => {
  const f = await fixture();
  try {
    for (const secret of ["", "!/bin/false", "line1\nline2", "x".repeat(4097)]) {
      await expect(persistModelCredential({ store: f.store, modelId: ID, piProvider: "source", confirmed: true, readCredential: async () => secret })).rejects.toMatchObject({ code: "credential_invalid" });
    }
    expect(await f.store.loadModels()).toEqual(f.models);
    expect((await readdir(f.root)).includes("secrets")).toBe(false);
  } finally { await f.close(); }
});

test("configuration write failure removes only this unreferenced new credential", async () => {
  const f = await fixture();
  try {
    const store = { ...f.store, saveModels: async () => { throw new Error(KEY); } };
    let failure: unknown;
    try { await persistModelCredential({ store, modelId: ID, piProvider: "source", confirmed: true, readCredential: async () => KEY }); }
    catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(KEY);
    expect(await readdir(join(f.root, "secrets"))).toEqual([]);
    expect(await f.store.loadModels()).toEqual(f.models);
  } finally { await f.close(); }
});

test("a config save that committed before failing retains the now-referenced credential", async () => {
  const f = await fixture();
  try {
    const store = { ...f.store, saveModels: async (file: typeof f.models) => { await f.store.saveModels(file); throw new Error("after-commit"); } };
    await expect(persistModelCredential({ store, modelId: ID, piProvider: "source", confirmed: true, readCredential: async () => KEY })).rejects.toBeDefined();
    const keyRef = (await f.store.loadModels()).models[ID]!.apiKeyRef;
    expect(keyRef.startsWith("file:")).toBe(true);
    expect(await readFile(keyRef.slice(5), "utf8")).toBe(KEY);
  } finally { await f.close(); }
});

test("an unsafe or redirected credential directory is refused without overwriting it", async () => {
  for (const mode of ["public", "symlink"] as const) {
    const f = await fixture();
    const other = await mkdtemp(join(tmpdir(), "gbox-key-decoy-"));
    try {
      if (mode === "public") {
        await mkdir(join(f.root, "secrets"), { mode: 0o755 });
        // mkdir's mode is masked by the invoking shell. This negative oracle
        // must really create an unsafe directory even under a private umask.
        await chmod(join(f.root, "secrets"), 0o755);
        expect((await stat(join(f.root, "secrets"))).mode & 0o077).toBe(0o055);
      } else await symlink(other, join(f.root, "secrets"));
      await expect(persistModelCredential({ store: f.store, modelId: ID, piProvider: "source", confirmed: true, readCredential: async () => KEY })).rejects.toMatchObject({ code: "credential_invalid" });
      expect(await readdir(other)).toEqual([]);
      expect(await f.store.loadModels()).toEqual(f.models);
    } finally { await f.close(); await rm(other, { recursive: true, force: true }); }
  }
});

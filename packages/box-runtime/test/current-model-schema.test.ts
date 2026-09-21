import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseModelsFile, STUB_ECHO_MODEL } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { captureHostManagedSelection } from "../src/internal/host/selection.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { MODEL_CALLER, submitModelChange } from "./model-management-fixture.ts";
import { modelConfigurationLayer } from "../src/internal/io/model-management.node.ts";
import { readModelOperation } from "@grokbox/runtime-kernel/commands";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { captureCli } from "../../../test/helpers.ts";
import { loadTitleModelIndex, titleSyncModel } from "../../cli/src/title-sync.ts";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const current = { version: 3, models: {}, assignments: { main: null, agents: { [A]: { modelId: "stub/echo" } } } };
for (const version of [1, 2]) test(`model document v${version} is preserved but rejected by the parser, runtime, Host and normal CLI`, async () => {
  const root = await mkdtemp(join(tmpdir(), "models-single-schema-"));
  const old = { ...current, version, assignments: { main: null, agents: { [A]: version === 1 ? "stub/echo" : { modelId: "stub/echo" } } } }, bytes = JSON.stringify(old);
  try {
    await writeFile(join(root, "models.json"), bytes, { mode: 0o600 });
    expect(() => parseModelsFile(old)).toThrow();
    await expect(openRuntimeStore(root, {}).loadModels()).rejects.toBeDefined();
    expect(() => captureHostManagedSelection(root, A)).toThrow();
    const native = { getExecutor() { throw Error("native-fallback-forbidden"); } };
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    expect(() => hook({ agentId: A, sessionOptions: { invocationId: "blocked-turn" }, originalSession: native })).toThrow();
    expect(hook({ originalSession: native })).toBe(native);
    const r = await captureCli(["models", "check"], { boxRuntimeRoot: root, configDir: root, env: {}, runCommand: async () => { throw Error("no-process-work"); } });
    expect(r.code).not.toBe(0); expect(await readFile(join(root, "models.json"), "utf8")).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical v3 refuses string assignments and the former contextWindow alias rather than normalizing them", () => {
  expect(parseModelsFile(current).version).toBe(3);
  expect(() => parseModelsFile({ ...current, assignments: { main: "stub/echo", agents: {} } })).toThrow();
  expect(() => parseModelsFile({ ...current, assignments: { main: null, agents: { [A]: "stub/echo" } } })).toThrow();
  for (const window of [{ contextWindow: 128000 }, { contextWindow: 128000, contextWindowTokens: 128000 }]) {
    expect(() => parseModelsFile({ ...current, models: { "stub/echo": window } })).toThrow();
  }
});

test("label readers distinguish current assignments from retired or unsafe documents without clearing a prior label", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-current-label-")), path = join(root, "models.json");
  const document = { ...current, models: { "stub/echo": STUB_ECHO_MODEL } };
  try {
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const valid = await loadTitleModelIndex(root, {});
    expect(valid.assigned?.has(A)).toBe(true);
    expect(titleSyncModel("box", A, valid.tokens, valid.assigned)).toBe("echo");
    for (const version of [1, 2]) {
      const bytes = JSON.stringify({ ...document, version });
      await writeFile(path, bytes);
      const rejected = await loadTitleModelIndex(root, {});
      expect(rejected.assigned).toBeUndefined();
      expect(titleSyncModel("box", A, rejected.tokens, rejected.assigned)).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    await writeFile(path, JSON.stringify(document)); await chmod(path, 0o660);
    const unsafe = await loadTitleModelIndex(root, {});
    expect(unsafe.assigned).toBeUndefined(); expect(unsafe.tokens.size).toBe(0);
    await chmod(path, 0o600);
    expect((await loadTitleModelIndex(root, {})).assigned?.has(A)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an old future document cannot revoke a captured TURN or reinterpret retained model receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-current-capture-")), store = openRuntimeStore(root, {});
  try {
    await store.saveModels(parseModelsFile(current));
    const original = { native: true }, hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    const captured = hook({ agentId: A, sessionOptions: { invocationId: "captured-current" }, originalSession: original });
    if (!isHostPromptSession(captured)) throw Error("current-capture-missing");
    const requestId = randomUUID(), receipt = await submitModelChange({ store, requestId, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } });
    const old = JSON.stringify({ ...current, version: 2 }); await writeFile(join(root, "models.json"), old, { mode: 0o600 });
    expect(captured.getModelId()).toBe("stub/echo");
    expect(() => hook({ agentId: A, sessionOptions: { invocationId: "new-after-old-file" }, originalSession: original })).toThrow();
    expect(await Effect.runPromise(readModelOperation(MODEL_CALLER, requestId).pipe(Effect.provide(modelConfigurationLayer(store))))).toEqual(receipt);
    await expect(submitModelChange({ store, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } })).rejects.toBeDefined();
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(old);
  } finally { await rm(root, { recursive: true, force: true }); }
});

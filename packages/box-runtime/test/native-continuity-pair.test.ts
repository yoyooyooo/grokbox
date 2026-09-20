import { expect, test } from "bun:test";
import { nativeContinuityPair } from "./native-continuity-pair.ts";
import { NATIVE_CHECKPOINT_PAIR, nativeCheckpointPair, IDLE_CHECKPOINT_PAIR } from "../src/internal/host/native-checkpoint-pair.ts";
import { hostRecipeForSourceSha } from "../src/internal/host/source-recipes.ts";
import Module from "node:module";
import { installNativeCheckpointWorkerHook, prepareNativeCheckpointWorkerCandidate } from "../src/internal/host/native-checkpoint-worker-hook.ts";

test("ordinary imports keep the original pair and cannot renew production qualification", () => {
  const original = nativeContinuityPair({});
  expect(original).toEqual(NATIVE_CHECKPOINT_PAIR);
  const candidate = nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_CONTINUITY_PAIR: "idle-candidate" });
  expect(candidate.host).not.toBe(original.host);
  expect(candidate.worker).toBe(original.worker);
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(nativeContinuityPair({})).toEqual(NATIVE_CHECKPOINT_PAIR);
});

test("candidate authoring cannot install an unreviewed native hook or accept arbitrary source", () => {
  const before = (Module.prototype as unknown as { _compile: unknown })._compile;
  const pair = { ...IDLE_CHECKPOINT_PAIR, host: "f".repeat(64) };
  const refused = installNativeCheckpointWorkerHook({ targetPath: "/tmp/not-opened/worker.cjs", hostSourceSha: pair.host, enabled: true });
  expect(refused.installed).toBe(false);
  expect((Module.prototype as unknown as { _compile: unknown })._compile).toBe(before);
  expect(() => prepareNativeCheckpointWorkerCandidate("const unqualified = true;", pair.host)).toThrow("unqualified");
  expect(() => prepareNativeCheckpointWorkerCandidate("const unqualified = true;", "\"; execute();")).toThrow("unqualified");
});

test("both qualified tuples remain exact and the new recipe never registers the former Host identity", () => {
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, NATIVE_CHECKPOINT_PAIR.worker)).toBe(NATIVE_CHECKPOINT_PAIR);
  expect(nativeCheckpointPair(IDLE_CHECKPOINT_PAIR.host, IDLE_CHECKPOINT_PAIR.worker)).toBe(IDLE_CHECKPOINT_PAIR);
  expect(nativeCheckpointPair(IDLE_CHECKPOINT_PAIR.host, "b".repeat(64))).toBeNull();
  expect(nativeCheckpointPair("f".repeat(64), IDLE_CHECKPOINT_PAIR.worker)).toBeNull();
  const recipe = hostRecipeForSourceSha(IDLE_CHECKPOINT_PAIR.host);
  for (const id of ["continuity-native-created-owner", "continuity-native-session-owner"]) {
    const replacement = recipe.currentState.find(s => s.id === id)!.replacement;
    expect(replacement).toContain(`hostSourceSha: "${IDLE_CHECKPOINT_PAIR.host}"`);
    expect(replacement).not.toContain(NATIVE_CHECKPOINT_PAIR.host);
  }
});

test("a qualified Host cannot compile unknown worker bytes and a refusal restores the hook", () => {
  const proto = Module.prototype as unknown as { _compile: (source: string, filename: string) => unknown };
  const before = proto._compile, targetPath = "/tmp/not-opened/worker.cjs";
  const hook = installNativeCheckpointWorkerHook({ targetPath, hostSourceSha: IDLE_CHECKPOINT_PAIR.host, enabled: true });
  try {
    expect(hook.installed).toBe(true);
    const module = new Module(targetPath) as unknown as { _compile: (source: string, filename: string) => unknown };
    // Exercise the installed prototype hook explicitly under either test engine;
    // the separate native-pair Node thread test exercises the real module loader.
    expect(() => Reflect.apply(proto._compile, module, ["module.exports = true;", targetPath])).toThrow("unqualified");
    expect(proto._compile).toBe(before);
  } finally { hook.restore(); }
});

test("candidate selection is explicit, finite, and has no latest/path/hash fallback", () => {
  for (const flag of [undefined, "0", "true", "yes"]) {
    expect(() => nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: flag, GROKBOX_TEST_NATIVE_CONTINUITY_PAIR: "idle-candidate" })).toThrow();
  }
  for (const name of ["latest", "2380c2c7", "/tmp/host.cjs", "", "unknown"]) {
    expect(() => nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_CONTINUITY_PAIR: name })).toThrow();
  }
});

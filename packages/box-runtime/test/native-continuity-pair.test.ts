import { expect, test } from "bun:test";
import Module from "node:module";
import { nativeContinuityPair } from "./native-continuity-pair.ts";
import { NATIVE_CHECKPOINT_PAIR, nativeCheckpointPair } from "../src/internal/host/native-checkpoint-pair.ts";
import { HOST_RECIPE } from "../src/internal/host/source-recipes.ts";
import { installNativeCheckpointWorkerHook, transformNativeCheckpointWorker } from "../src/internal/host/native-checkpoint-worker-hook.ts";

// A retired source is a negative fixture, not an executable production tuple.
const retiredHosts = ["eb4388069359a0101ac442d3b391def3c28e783161f4b6954ce50169f49e172c", "68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc", "ebd92f0d14dd065b779524989dc15a7922c848f77227c69616257be6af6db8f0", "e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e", "2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548", "6be750313bb7bb393cc3833e103d4d2cd0dc336b6d903e7671c107ea1883767f"];

test("ordinary imports expose only the independently checked current tuple", () => {
  expect(nativeContinuityPair({})).toEqual(NATIVE_CHECKPOINT_PAIR);
  expect(nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: "1" })).toEqual(NATIVE_CHECKPOINT_PAIR);
  expect(Object.isFrozen(NATIVE_CHECKPOINT_PAIR)).toBe(true);
});

for (const host of [...retiredHosts, "f".repeat(64), '\"; execute();']) test(`retired or unknown Host ${host.slice(0,8)} cannot install a worker hook`, () => {
  const before = (Module.prototype as unknown as { _compile: unknown })._compile;
  expect(installNativeCheckpointWorkerHook({ targetPath: "/tmp/not-opened/worker.cjs", hostSourceSha: host, enabled: true }).installed).toBe(false);
  expect((Module.prototype as unknown as { _compile: unknown })._compile).toBe(before);
  expect(() => transformNativeCheckpointWorker("const unqualified = true;", host)).toThrow("unqualified");
});

test("current recipe and pair have one source identity and never fall back to the former Host", () => {
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, NATIVE_CHECKPOINT_PAIR.worker)).toBe(NATIVE_CHECKPOINT_PAIR);
  for (const host of retiredHosts) expect(nativeCheckpointPair(host, NATIVE_CHECKPOINT_PAIR.worker)).toBeNull();
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, "b".repeat(64))).toBeNull();
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, "5fd47aaf6559205dc200ea9bc0593cdcf28b83664086f3305eedc9ce8d5f80aa")).toBeNull();
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, "4c154a3498de0a3fd211762a936a0f6ea5ee24760505fa2e021543f6a0f651e6")).toBeNull();
  expect(nativeCheckpointPair(NATIVE_CHECKPOINT_PAIR.host, "56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e")).toBeNull();
  for (const id of ["continuity-native-created-owner", "continuity-native-session-owner"]) {
    const replacement = HOST_RECIPE.currentState.find(s => s.id === id)!.replacement;
    expect(replacement).toContain(`hostSourceSha: "${NATIVE_CHECKPOINT_PAIR.host}"`);
    for (const host of retiredHosts) expect(replacement).not.toContain(host);
  }
});

test("a current Host cannot compile unknown worker bytes and refusal restores the hook", () => {
  const proto = Module.prototype as unknown as { _compile: (source: string, filename: string) => unknown };
  const before = proto._compile, targetPath = "/tmp/not-opened/worker.cjs";
  const hook = installNativeCheckpointWorkerHook({ targetPath, hostSourceSha: NATIVE_CHECKPOINT_PAIR.host, enabled: true });
  try {
    expect(hook.installed).toBe(true);
    const module = new Module(targetPath);
    expect(() => Reflect.apply(proto._compile, module, ["module.exports = true;", targetPath])).toThrow("unqualified");
    expect(proto._compile).toBe(before);
  } finally { hook.restore(); }
});

test("native qualification has no original/candidate/latest selector", () => {
  for (const flag of ["true", "yes"]) expect(() => nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: flag })).toThrow();
  for (const name of ["original", "idle-candidate", "latest", "2380c2c7", "/tmp/host.cjs", "", "unknown"]) {
    expect(() => nativeContinuityPair({ GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_CONTINUITY_PAIR: name })).toThrow();
  }
});

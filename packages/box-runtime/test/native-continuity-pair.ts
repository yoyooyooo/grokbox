/** Explicit test-only sources. Choosing a candidate does not edit the production
 * preload/worker gate or qualify an installed Host. No path or hash auto-detection. */
const ORIGINAL = Object.freeze({
  host: "e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e",
  worker: "56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e",
  schema: "native-checkpoint-proto-20260918",
});
const IDLE_CANDIDATE = Object.freeze({
  host: "2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548",
  worker: "56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeContinuityPair(env: Record<string, string | undefined>) {
  const flag = env.GROKBOX_TEST_NATIVE_CONTINUITY;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw Error("native_continuity_flag_invalid");
  const selection = env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR;
  if (selection === undefined || selection === "original") return ORIGINAL;
  if (selection !== "idle-candidate" || flag !== "1") throw Error("native_continuity_pair_requires_explicit_opt_in");
  return IDLE_CANDIDATE;
}

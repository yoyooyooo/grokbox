/** Independent expected bytes for the explicit isolated native qualification.
 * Advancing this expectation does not alter the production admission tuple. */
const CURRENT = Object.freeze({
  host: "216a8b6b7bdaf9410a0ffa6727bdfe864c1f9a600618a6be2788ce6f520d0e54",
  worker: "96c32f4dd4e99f91576a720f88b4e24281212faf76b341709b83bce2502f71a2",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeContinuityPair(env: Record<string, string | undefined>) {
  const flag = env.GROKBOX_TEST_NATIVE_CONTINUITY;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw Error("native_continuity_flag_invalid");
  if (env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR !== undefined) throw Error("native_continuity_pair_selection_removed");
  return CURRENT;
}

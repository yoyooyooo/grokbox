/** Independent expected bytes for the explicit isolated native qualification.
 * Advancing this expectation does not alter the production admission tuple. */
const CURRENT = Object.freeze({
  host: "2297e7bc9c392e4cc7c297bfc61f14892b0cc0b4cde5c20edb242d3aa4bdc653",
  worker: "0378b9f497f0f4b9d6f0abd281279505a48da3fe93a69640127ad081109406d3",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeContinuityPair(env: Record<string, string | undefined>) {
  const flag = env.GROKBOX_TEST_NATIVE_CONTINUITY;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw Error("native_continuity_flag_invalid");
  if (env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR !== undefined) throw Error("native_continuity_pair_selection_removed");
  return CURRENT;
}

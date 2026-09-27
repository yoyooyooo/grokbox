/** Independent expected bytes for the explicit isolated native qualification.
 * Advancing this expectation does not alter the production admission tuple. */
const CURRENT = Object.freeze({
  host: "462603791cf7516915084d175cb96125241cacb1352e2e42fb100ebe4feb71e0",
  worker: "0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeContinuityPair(env: Record<string, string | undefined>) {
  const flag = env.GROKBOX_TEST_NATIVE_CONTINUITY;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw Error("native_continuity_flag_invalid");
  if (env.GROKBOX_TEST_NATIVE_CONTINUITY_PAIR !== undefined) throw Error("native_continuity_pair_selection_removed");
  return CURRENT;
}

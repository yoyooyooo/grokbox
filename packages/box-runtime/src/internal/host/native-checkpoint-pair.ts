/** Current independently exercised checkpoint codec/worker transaction tuple.
 * No retired-Host fallback or environment-selected qualification. This is not
 * profile approval, adoption, ownership or complete execution qualification. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "2297e7bc9c392e4cc7c297bfc61f14892b0cc0b4cde5c20edb242d3aa4bdc653",
  worker: "0378b9f497f0f4b9d6f0abd281279505a48da3fe93a69640127ad081109406d3",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return host === NATIVE_CHECKPOINT_PAIR.host && (worker === undefined || worker === NATIVE_CHECKPOINT_PAIR.worker)
    ? NATIVE_CHECKPOINT_PAIR : null;
}

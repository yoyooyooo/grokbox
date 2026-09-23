/** Current independently exercised checkpoint codec/worker transaction tuple.
 * No retired-Host fallback or environment-selected qualification. This is not
 * profile approval, adoption, ownership or complete execution qualification. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be",
  worker: "da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return host === NATIVE_CHECKPOINT_PAIR.host && (worker === undefined || worker === NATIVE_CHECKPOINT_PAIR.worker)
    ? NATIVE_CHECKPOINT_PAIR : null;
}

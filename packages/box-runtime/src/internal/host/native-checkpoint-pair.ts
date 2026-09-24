/** Current independently exercised checkpoint codec/worker transaction tuple.
 * No retired-Host fallback or environment-selected qualification. This is not
 * profile approval, adoption, ownership or complete execution qualification. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "7e245862872b56d6be470f20588b24d7a064d045bf8f56d4ce1a154f3a0e8bc7",
  worker: "81c247f581ceb28b7b0cf2cac2e2407715a5712c7a2adbf8095eee804591180a",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return host === NATIVE_CHECKPOINT_PAIR.host && (worker === undefined || worker === NATIVE_CHECKPOINT_PAIR.worker)
    ? NATIVE_CHECKPOINT_PAIR : null;
}

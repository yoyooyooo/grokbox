/** Current independently exercised checkpoint codec/worker transaction tuple.
 * No retired-Host fallback or environment-selected qualification. This is not
 * profile approval, adoption, ownership or complete execution qualification. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "68a020b8483656c3eb89d0ce991bacdf089ceabb16f95549ba3084061375a68e",
  worker: "96c32f4dd4e99f91576a720f88b4e24281212faf76b341709b83bce2502f71a2",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return host === NATIVE_CHECKPOINT_PAIR.host && (worker === undefined || worker === NATIVE_CHECKPOINT_PAIR.worker)
    ? NATIVE_CHECKPOINT_PAIR : null;
}

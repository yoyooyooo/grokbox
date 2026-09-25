/** Current independently exercised checkpoint codec/worker transaction tuple.
 * No retired-Host fallback or environment-selected qualification. This is not
 * profile approval, adoption, ownership or complete execution qualification. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "83be8f81ebfeca0625a2b084d6c516545734e6764697168672257c472b2bc006",
  worker: "0378b9f497f0f4b9d6f0abd281279505a48da3fe93a69640127ad081109406d3",
  schema: "native-checkpoint-proto-20260918",
});
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return host === NATIVE_CHECKPOINT_PAIR.host && (worker === undefined || worker === NATIVE_CHECKPOINT_PAIR.worker)
    ? NATIVE_CHECKPOINT_PAIR : null;
}

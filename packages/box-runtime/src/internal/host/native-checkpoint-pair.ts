/** Finite independently exercised checkpoint codec/worker transaction tuples.
 * Selection is exact, never inferred from a parser pass, disk similarity or a
 * test environment flag. These entries are not profile review, adoption,
 * current ownership, Provider execution or complete Host capability proof. */
export type NativeCheckpointPair = Readonly<{ host: string; worker: string; schema: string }>;
export const NATIVE_CHECKPOINT_PAIR = Object.freeze({
  host: "e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e",
  worker: "56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e",
  schema: "native-checkpoint-proto-20260918",
});
/** Current tuple: native schema/AgentStore/worker/GC-fence/startup experiments
 * are recorded in the 2026-09-21 native-pair report. The old tuple is retained. */
export const IDLE_CHECKPOINT_PAIR = Object.freeze({
  host: "2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548",
  worker: "56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e",
  schema: "native-checkpoint-proto-20260918",
});
const pairs = Object.freeze([NATIVE_CHECKPOINT_PAIR, IDLE_CHECKPOINT_PAIR]);
export function nativeCheckpointPair(host: string, worker?: string): NativeCheckpointPair | null {
  return pairs.find(pair => pair.host === host && (worker === undefined || pair.worker === worker)) ?? null;
}

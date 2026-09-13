// The former stick policy is retired. This module is now a pure rejection
// boundary for persisted profiles that could restore local-over-Server writes.
// No hook, profile writer, scope state or fallback implementation remains here.
export const RETIRED_HARNESS_WRITE_SLICE_IDS: ReadonlySet<string> = new Set([
  "harness-profile-rpc",
  "harness-update-trim",
  "harness-agent-write",
  "harness-local-write",
  "harness-server-write",
]);

export function containsRetiredHarnessWrite(slices: readonly { id: string }[]): boolean {
  return slices.some(slice => RETIRED_HARNESS_WRITE_SLICE_IDS.has(slice.id));
}

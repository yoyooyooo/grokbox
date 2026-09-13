/** A roster declaration is evidence, not a default or a desktop-cache reading. */
export type DeclaredHarness = "box" | "temporal";
export type ObservedHarness = DeclaredHarness | "unknown";

export function observeRosterHarness(row: unknown): ObservedHarness {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return "unknown";
  const field = Object.getOwnPropertyDescriptor(row, "harness");
  if (!field || !("value" in field)) return "unknown";
  return field.value === "box" || field.value === "temporal" ? field.value : "unknown";
}

export type TranscriptRouteObservation = {
  initial: ObservedHarness;
  before: ObservedHarness;
  after: ObservedHarness;
  expected?: DeclaredHarness;
};

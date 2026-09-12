import { HOST_HARNESS_STICK_SYMBOL } from "./profile.ts";

export { HOST_HARNESS_STICK_SYMBOL };

export type ProfileHarness = "box" | "temporal";

export function asProfileHarness(value: unknown): ProfileHarness | undefined {
  return value === "box" || value === "temporal" ? value : undefined;
}

/** Fail-closed persist policy. Invalid input declines so official Host write stays official. */
export function applyHarnessStick(input: unknown): ProfileHarness | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  if (row.kind === "local") {
    return asProfileHarness(row.incoming) ?? asProfileHarness(row.existing);
  }
  if (row.kind !== "server") return undefined;
  if (row.fileExists === true) return asProfileHarness(row.existing) ?? "box";
  if (row.fileExists === false) return asProfileHarness(row.remote);
  return undefined;
}

/** Effect-free Host hook. Missing/throw must not change official writes. */
export function bindHarnessStickHook(): (input: unknown) => ProfileHarness | undefined {
  return (input) => {
    try {
      return applyHarnessStick(input);
    } catch {
      return undefined;
    }
  };
}

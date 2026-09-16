import { existsSync } from "node:fs";
import { LIVE_HOST_BUNDLE } from "../src/internal/host/live-slices.ts";

/** Ordinary tests use public fixtures, never auto-discover private native code. */
export function nativeHostQualificationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  available: (path: string) => boolean = existsSync,
): boolean {
  const flag = env.GROKBOX_TEST_NATIVE_HOST;
  if (flag === undefined || flag === "" || flag === "0") return false;
  if (flag !== "1") throw new Error("GROKBOX_TEST_NATIVE_HOST must be 0 or 1");
  if (!available(LIVE_HOST_BUNDLE)) throw new Error("Explicit native Host qualification requires the installed Host bundle");
  return true;
}

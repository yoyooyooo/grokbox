import { existsSync } from "node:fs";
import { LIVE_HOST_BUNDLE } from "../src/internal/host/live-slices.ts";

/** Exact installed source selected for read-only native qualification. A pin is
 * not acceptance: the retry/compact behavior and unique-slice tests must pass.
 * Unknown source generations still fail closed rather than accepting their own hash. */
// 2026-09-17 candidate: alert observer locals were renamed description7 ->
// description9. The context/summary and full unique-slice tests must execute
// against these exact bytes; selecting this pin alone never qualifies a release.
export const QUALIFIED_NATIVE_HOST_SHA = "dfd1d0773c07d66fb90a336b0960bf65a0c61e1305239ad40f81cb3e2b4e33c7";

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

import { readFileSync } from "node:fs";
import { LIVE_HOST_BUNDLE } from "../src/internal/host/live-slices.ts";
import { readHostSourceWindow } from "../src/internal/io/host-source-window.node.mjs";

/** Test-only routing. A runner's immutable locator is inherited by all nested
 * native Node/worker children; never override the production Host path or pin. */
export function nativeSourcePath(role: "source" | "worker"): string {
  if (process.env.GROKBOX_TEST_NATIVE_WINDOW !== undefined || process.env.GROKBOX_TEST_NATIVE_WINDOW_KEY !== undefined)
    return readHostSourceWindow(process.env, role).paths[role];
  return role === "source" ? LIVE_HOST_BUNDLE : "/home/box/sand-host/agent-isolation/agent-store-worker.cjs";
}
export function readNativeSource(role: "source" | "worker"): Buffer {
  if (process.env.GROKBOX_TEST_NATIVE_WINDOW !== undefined || process.env.GROKBOX_TEST_NATIVE_WINDOW_KEY !== undefined)
    return readHostSourceWindow(process.env, role).bytes!;
  return readFileSync(nativeSourcePath(role));
}
export function nativeWindowEnv(): NodeJS.ProcessEnv {
  const window = process.env.GROKBOX_TEST_NATIVE_WINDOW, key = process.env.GROKBOX_TEST_NATIVE_WINDOW_KEY;
  if (window === undefined && key === undefined) return {};
  if (!window || !key) throw Error("native_window_inheritance_incomplete");
  return { GROKBOX_TEST_NATIVE_WINDOW: window, GROKBOX_TEST_NATIVE_WINDOW_KEY: key };
}
export const NATIVE_HOST_BUNDLE = nativeSourcePath("source");

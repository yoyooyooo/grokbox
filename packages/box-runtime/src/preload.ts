import { writeFileSync } from "node:fs";
import { installCompileHook } from "./hook.ts";
import { LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { ROUTE_SESSION_SYMBOL, type PatchProfile } from "./transform.ts";
import { readFileSync } from "node:fs";

const target = process.env.GROKBOX_HOST_BUNDLE ?? LIVE_HOST_BUNDLE;
const profilePath = process.env.GROKBOX_PATCH_PROFILE;
const allowLiveHost = process.env.GROKBOX_ALLOW_LIVE_HOST === "1";
const mode = process.env.GROKBOX_PRELOAD_MODE ?? "identity";
const markerPath = process.env.GROKBOX_PRELOAD_MARKER;

if (allowLiveHost && profilePath && mode === "identity") {
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as PatchProfile;
  (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTE_SESSION_SYMBOL)] = (args: {
    originalSession: unknown;
  }) => args.originalSession;
  installCompileHook({
    targetPath: target,
    profile,
    argv: process.argv,
    allowLiveHost: true,
    onTransformed: () => {
      if (!markerPath) return;
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          mode: "identity",
          pid: process.pid,
          transformed: true,
          modeld: false,
        })}\n`,
        { mode: 0o600 },
      );
    },
  });
}

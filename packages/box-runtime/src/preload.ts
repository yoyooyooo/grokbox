import { writeFileSync } from "node:fs";
import { installCompileHook } from "./hook.ts";
import { isLiveHostPath, LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { DEFAULT_DURABLE_ROOT } from "./paths.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { bindHostSessionHook } from "./seam.ts";
import { ROUTE_SESSION_SYMBOL, type PatchProfile } from "./transform.ts";
import { readFileSync } from "node:fs";

const target = process.env.GROKBOX_HOST_BUNDLE ?? LIVE_HOST_BUNDLE;
const profilePath = process.env.GROKBOX_PATCH_PROFILE;
const allowLiveHost = process.env.GROKBOX_ALLOW_LIVE_HOST === "1";
const mode = process.env.GROKBOX_PRELOAD_MODE ?? "identity";
const markerPath = process.env.GROKBOX_PRELOAD_MARKER;
const operationId = process.env.GROKBOX_OPERATION_ID;
const runRoot = process.env.GROKBOX_RUN_ROOT ?? ephemeralRuntimeRoot();
const durableRoot = process.env.GROKBOX_BOX_RUNTIME_ROOT ?? DEFAULT_DURABLE_ROOT;

const liveBlocked = isLiveHostPath(target) && !allowLiveHost;
const admittedMode = mode === "identity" || mode === "route" ? mode : null;

if (!liveBlocked && profilePath && admittedMode && operationId) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as PatchProfile;
  (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTE_SESSION_SYMBOL)] = bindHostSessionHook({
    mode: admittedMode,
    durableRoot,
    runRoot,
  });
  installCompileHook({
    targetPath: target,
    profile,
    argv: process.argv,
    allowLiveHost,
    onTransformed: () => {
      if (!markerPath) return;
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          operationId,
          pid: process.pid,
          mode: admittedMode,
          transformed: true,
          compiled: true,
          modeld: false,
        })}\n`,
        { mode: 0o600 },
      );
    },
  });
}

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { inspectPid } from "./internal/host/self-identity.node.ts";
import { installCompileHook } from "./internal/host/compile-hook.ts";
import { isLiveHostPath, LIVE_HOST_BUNDLE } from "./internal/host/live-slices.ts";
import { bindHostSessionHook } from "./internal/host/session-hook.ts";
import { bindCompiledHost } from "./internal/host/host-binding.ts";
import { ROUTE_SESSION_SYMBOL, type PatchProfile } from "./internal/host/profile.ts";

const target = process.env.GROKBOX_HOST_BUNDLE ?? LIVE_HOST_BUNDLE;
const profilePath = process.env.GROKBOX_PATCH_PROFILE;
const allowLiveHost = process.env.GROKBOX_ALLOW_LIVE_HOST === "1";
const mode = process.env.GROKBOX_PRELOAD_MODE ?? "identity";
const markerPath = process.env.GROKBOX_PRELOAD_MARKER;
const operationId = process.env.GROKBOX_OPERATION_ID;
const runRoot = process.env.GROKBOX_RUN_ROOT ?? join(homedir(), ".grokbox", "run");
const durableRoot = process.env.GROKBOX_BOX_RUNTIME_ROOT ?? "/workspace/.grokbox/box-runtime";

function requiredPreloadPath(): string | null {
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--require" && argv[i + 1]) return argv[i + 1]!;
    if (part.startsWith("--require=")) return part.slice("--require=".length);
  }
  return null;
}

const liveBlocked = isLiveHostPath(target) && !allowLiveHost;
const admittedMode = mode === "identity" || mode === "route" ? mode : null;

if (!liveBlocked && profilePath && admittedMode && operationId) {
  const bytes = readFileSync(profilePath);
  const profile = JSON.parse(bytes.toString("utf8")) as PatchProfile;
  const profileSha256 = sha256Bytes(bytes);
  const self = inspectPid(process.pid);
  const binding = self ? bindCompiledHost(self, operationId, { profileId: profile.profileId, profileSha256,
    sourceSha256: profile.sourceSha256, transformedSha256: profile.transformedSourceSha256 }) : undefined;
  (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTE_SESSION_SYMBOL)] = bindHostSessionHook({
    mode: admittedMode,
    durableRoot,
    runRoot,
    binding,
    compile: {
      profileId: profile.profileId,
      profileSha256,
      sourceSha256: profile.sourceSha256,
      transformedSha256: profile.transformedSourceSha256,
    },
  });
  installCompileHook({
    targetPath: target,
    profile,
    argv: process.argv,
    allowLiveHost,
    onTransformed: (actual) => {
      if (!markerPath) return;
      const staging = `${markerPath}.${randomUUID()}.tmp`;
      writeFileSync(
        staging,
        `${JSON.stringify({
          operationId,
          pid: process.pid,
          start: inspectPid(process.pid)?.start,
          mode: admittedMode,
          transformed: true,
          compiled: true,
          modeld: false,
          compile: { profileId: profile.profileId, profileSha256, ...actual },
          ...(requiredPreloadPath() ? { preloadSha256: sha256Bytes(readFileSync(requiredPreloadPath()!)) } : {}),
        })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(staging, markerPath);
    },
  });
}

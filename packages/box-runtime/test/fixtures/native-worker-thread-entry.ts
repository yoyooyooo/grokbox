import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { installNativeCheckpointWorkerHook } from "../../src/internal/host/native-checkpoint-worker-hook.ts";
import { nativeContinuityPair } from "../native-continuity-pair.ts";
import { nativeSourcePath } from "../native-host-source.ts";

// Exercise the production compile hook and the ORIGINAL worker entrypoint, but
// only with caller-owned databases. No installed Bot, main Host or private data.
if (process.env.GROKBOX_TEST_NATIVE_CONTINUITY !== "1" || typeof workerData?.fixtureRoot !== "string"
  || readFileSync(join(workerData.fixtureRoot, "owned-marker"), "utf8") !== "grokbox-original-worker"
  || ![join(workerData.fixtureRoot, "source.db"), join(workerData.fixtureRoot, "target.db")].includes(workerData.blobDbPath)
  || workerData.legacyBlobDbPath !== undefined) throw Error("unowned_native_worker_test");
const originalPath = nativeSourcePath("worker");
const pair = nativeContinuityPair(process.env);
const hook = installNativeCheckpointWorkerHook({ targetPath: originalPath, hostSourceSha: pair.host, enabled: true });
if (!hook.installed) throw Error("native_worker_hook_not_installed");
try { createRequire(originalPath)(originalPath); } finally { hook.restore(); }

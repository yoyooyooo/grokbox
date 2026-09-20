import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import { projectHostCompileReceipt, type HostRuntimeObservation } from "@grokbox/runtime-kernel/host-health";
import { inspectPid } from "../host/self-identity.node.ts";
import { assertSafeDirectory } from "./config-layout.node.ts";

export type CompilationReadPorts = { inspect?: typeof inspectPid; now?: () => number };
/** Read the existing launch marker, not a process census, Gateway or source
 * compiler. A stale/dead/PID-reused marker remains historical. The disk source
 * is deliberately not compared here: a new disk version cannot revoke proof
 * of bytes previously evaluated by an independently still-running generation. */
export async function observeHostCompilation(root: string, runRoot: string, target: string, ports: CompilationReadPorts = {}): Promise<HostRuntimeObservation> {
  const now = ports.now ?? Date.now;
  const empty = (state: HostRuntimeObservation["state"]): HostRuntimeObservation => ({ state, process: "not-checked", observedAtMs: now(), receipt: null,
    coverage: "selected-launch-marker", attachment: "not-observed", exercised: "not-exercised", qualified: false });
  const path = join(runRoot, "state/preload-marker.json");
  let fd;
  try {
    const found = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!found) return empty("not-observed");
    await assertSafeDirectory(dirname(path));
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 8192 || before.uid !== process.getuid?.() || (before.mode & 0o077)) return empty("invalid");
    const bytes = Buffer.alloc(8193); let total = 0;
    while (total < bytes.length) { const read = await fd.read(bytes, total, bytes.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
    const after = await fd.stat(), named = await lstat(path);
    if (total !== before.size || total > 8192 || before.dev !== named.dev || before.ino !== named.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return empty("unavailable");
    const marker = parseConfigJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))) as any;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return empty("invalid");
    // Old positive markers remain admissible to their original controller, but
    // they do not acquire this newer, stronger observation contract by inference.
    if (!Object.hasOwn(marker, "compilationObservation")) return empty("not-observed");
    const receipt = projectHostCompileReceipt(marker.compilationObservation);
    if (!receipt || receipt.rootDigest !== sha256Text(resolve(root)) || receipt.targetDigest !== sha256Text(resolve(target))
      || typeof marker.operationId !== "string" || receipt.operationDigest !== sha256Text(marker.operationId)
      || marker.pid !== receipt.pid || marker.start !== receipt.start || marker.mode !== receipt.mode || receipt.uid !== process.getuid?.()
      || marker.transformed !== (receipt.patch === "applied") || marker.compiled !== (receipt.patch === "applied" && receipt.nativeCompilation === "returned") || marker.modeld !== false
      || marker.compile?.profileSha256 !== receipt.profileDigest || marker.compile?.sourceSha256 !== receipt.sourceSha
      || (marker.compile?.transformedSha256 ?? null) !== receipt.candidateSha || marker.preloadSha256 !== receipt.preloadDigest || Date.parse(receipt.at) > now()) return empty("invalid");
    const p = (ports.inspect ?? inspectPid)(receipt.pid);
    const same = p?.pid === receipt.pid && p.start === receipt.start && p.uid === receipt.uid
      && sha256Text(p.exe) === receipt.exeDigest && sha256Text(canonicalJson(p.cmdline)) === receipt.argvDigest;
    return { ...empty("historical"), state: same ? "current" : "historical", process: same ? "same-generation" : p ? "different-generation" : "absent-or-unverifiable", receipt };
  } catch { return empty("unavailable"); }
  finally { await fd?.close(); }
}

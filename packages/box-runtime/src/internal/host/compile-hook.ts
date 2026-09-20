import { realpathSync } from "node:fs";
import Module from "node:module";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_COMPILE_CODES, type HostCompileCode } from "@grokbox/runtime-kernel/host-health";

export type CompileObservation = {
  patch: "applied" | "refused"; nativeCompilation: "returned" | "threw";
  code: HostCompileCode; sourceSha: string; candidateSha: string | null;
};
import { shouldTransformArgv } from "./argv.ts";
import { isLiveHostPath } from "./live-slices.ts";
import { applyPatchProfile, type PatchProfile } from "./profile.ts";

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export type CompileTransform = {
  content: string;
  transformed: boolean;
  sourceSha256?: string;
  transformedSha256?: string;
  code?: string;
  refused?: "live-host-blocked" | "argv-blocked";
};

export function transformCompileInput(input: {
  content: string;
  filename: string;
  targetPath: string;
  profile: PatchProfile;
  allowLiveHost?: boolean;
}): CompileTransform {
  if (isLiveHostPath(input.targetPath) && input.allowLiveHost !== true) {
    return { content: input.content, transformed: false, refused: "live-host-blocked" };
  }
  if (!sameFile(input.filename, input.targetPath)) {
    return { content: input.content, transformed: false };
  }
  const result = applyPatchProfile(input.content, input.profile);
  if (!result.ok) return { content: input.content, transformed: false, code: result.code };
  return { content: result.source, transformed: true, sourceSha256: result.sourceSha256, transformedSha256: result.transformedSha256 };
}

export function installCompileHook(input: {
  targetPath: string;
  profile: PatchProfile;
  argv?: readonly string[];
  allowLiveHost?: boolean;
  /** Observation bootstrap only, after exact target/profile validation and
   * before native constructors run. It cannot prevent native compilation. */
  onTransforming?: () => void;
  onTransformed?: (actual: { sourceSha256: string; transformedSha256: string }) => void;
  /** Positive and negative observations; no source or exception payload.
   * A diagnostic consumer cannot change native module semantics. */
  onCompilation?: (actual: CompileObservation) => void;
}): { restore: () => void; applied: () => boolean; refused?: CompileTransform["refused"] } {
  if (!shouldTransformArgv(input.argv ?? process.argv)) {
    return { restore() {}, applied: () => false, refused: "argv-blocked" };
  }
  if (isLiveHostPath(input.targetPath) && input.allowLiveHost !== true) {
    return { restore() {}, applied: () => false, refused: "live-host-blocked" };
  }

  const proto = Module.prototype as unknown as {
    _compile: (this: NodeModule, content: string, filename: string) => unknown;
  };
  const original = proto._compile;
  let applied = false;
  proto._compile = function grokboxCompile(content: string, filename: string) {
    if (!sameFile(filename, input.targetPath)) return original.call(this, content, filename);
    // Restore before evaluating the native module, even on refusal or failure.
    proto._compile = original;
    let next: CompileTransform;
    try {
      next = transformCompileInput({ content, filename, targetPath: input.targetPath, profile: input.profile, allowLiveHost: input.allowLiveHost });
    } catch { next = { content, transformed: false, code: "transform-failed" }; }
    const sourceSha = sha256Text(content), candidateSha = next.transformed ? sha256Text(next.content) : null;
    const observe = (nativeCompilation: CompileObservation["nativeCompilation"]) => {
      const code: HostCompileCode = nativeCompilation === "threw" ? "native-compile-failed" : next.transformed ? "compiled"
        : HOST_COMPILE_CODES.includes(next.code as HostCompileCode) ? next.code as HostCompileCode : "transform-failed";
      try { input.onCompilation?.({ patch: next.transformed ? "applied" : "refused", nativeCompilation, code, sourceSha, candidateSha }); }
      catch { /* Evidence failure is not a new Host failure. */ }
    };
    if (next.transformed) { try { input.onTransforming?.(); } catch { /* observation is not compilation authority */ } }
    let compiled: unknown;
    try { compiled = original.call(this, next.content, filename); }
    catch (error) { observe("threw"); throw error; }
    applied = next.transformed;
    observe("returned");
    if (next.transformed) {
      try { input.onTransformed?.({ sourceSha256: next.sourceSha256!, transformedSha256: next.transformedSha256! }); }
      catch { /* A missing receipt cannot change a successful native result. */ }
    }
    return compiled;
  };

  return {
    restore: () => {
      proto._compile = original;
    },
    applied: () => applied,
  };
}

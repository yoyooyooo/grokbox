import Module from "node:module";
import { shouldTransformArgv } from "./argv.ts";
import { isLiveHostPath } from "./live-slices.ts";
import { applyPatchProfile, type PatchProfile } from "./transform.ts";

export type CompileTransform = {
  content: string;
  transformed: boolean;
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
  if (input.filename !== input.targetPath) {
    return { content: input.content, transformed: false };
  }
  const result = applyPatchProfile(input.content, input.profile);
  if (!result.ok) return { content: input.content, transformed: false, code: result.code };
  return { content: result.source, transformed: true };
}

export function installCompileHook(input: {
  targetPath: string;
  profile: PatchProfile;
  argv?: readonly string[];
  allowLiveHost?: boolean;
  onTransformed?: () => void;
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
    const next = transformCompileInput({
      content,
      filename,
      targetPath: input.targetPath,
      profile: input.profile,
      allowLiveHost: input.allowLiveHost,
    });
    if (filename === input.targetPath) {
      proto._compile = original;
      applied = next.transformed;
      if (next.transformed) input.onTransformed?.();
    }
    return original.call(this, next.content, filename);
  };

  return {
    restore: () => {
      proto._compile = original;
    },
    applied: () => applied,
  };
}

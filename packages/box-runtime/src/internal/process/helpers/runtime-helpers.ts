import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Node-runnable Host preload. Packed layout is `dist/preload.cjs`, never `dist/preload.ts`. */
export const RUNTIME_HELPER_PRELOAD = "preload.cjs";
export const RUNTIME_HELPER_GUARDIAN_CHILD = "guardian-child.cjs";
export const RUNTIME_HELPER_INJECTOR_HOLD = "injector-hold.cjs";
export const RUNTIME_HELPER_TEMP_SUPERVISOR = "grokbox-temp-supervisor.cjs";

export const RUNTIME_HELPER_FILES = [
  RUNTIME_HELPER_PRELOAD,
  RUNTIME_HELPER_GUARDIAN_CHILD,
  RUNTIME_HELPER_INJECTOR_HOLD,
  RUNTIME_HELPER_TEMP_SUPERVISOR,
] as const;

/** Resolve a sibling of the published bundle (`dist/index.js`) or this source module. */
export function resolveRuntimeHelper(fileName: string, base = import.meta.url): string {
  return fileURLToPath(new URL(`./${fileName}`, base));
}

/**
 * Packed installs must ship `preload.cjs`. Source tests may fall back to `preload.ts`
 * beside this module; Node `--require` cannot load that fallback.
 */
export function resolvePreloadPath(base = import.meta.url): string {
  const published = resolveRuntimeHelper(RUNTIME_HELPER_PRELOAD, base);
  if (existsSync(published)) return published;
  const source = join(fileURLToPath(new URL("../../..", base)), "preload.ts");
  if (existsSync(source)) return source;
  return published;
}

/** Live Host is Node. Prefer a built CJS; `--require` cannot load the source `.ts` fallback. */
export function resolveNodeRequireablePreload(
  base = import.meta.url,
  extraCandidates: readonly string[] = [],
): string {
  const resolved = resolvePreloadPath(base);
  const repoDist = fileURLToPath(new URL("../../../../../../dist/preload.cjs", import.meta.url));
  const match = [resolved, repoDist, ...extraCandidates].find((path) => path.endsWith(".cjs") && existsSync(path));
  return match ?? resolved;
}

export function resolveRuntimeHelpers(base = import.meta.url): {
  preload: string;
  guardianChild: string;
  injectorHold: string;
  tempSupervisor: string;
} {
  return {
    preload: resolvePreloadPath(base),
    guardianChild: resolveRuntimeHelper(RUNTIME_HELPER_GUARDIAN_CHILD, base),
    injectorHold: resolveRuntimeHelper(RUNTIME_HELPER_INJECTOR_HOLD, base),
    tempSupervisor: resolveRuntimeHelper(RUNTIME_HELPER_TEMP_SUPERVISOR, base),
  };
}

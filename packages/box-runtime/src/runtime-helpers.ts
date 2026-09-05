import { existsSync } from "node:fs";
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
  const source = resolveRuntimeHelper("preload.ts", base);
  if (existsSync(source)) return source;
  return published;
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

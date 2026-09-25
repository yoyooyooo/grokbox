import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node-runnable Host preload. Packed layout is `dist/preload.cjs`, never `dist/preload.ts`. */
export const RUNTIME_HELPER_PRELOAD = "preload.cjs";
export const RUNTIME_HELPER_GUARDIAN_CHILD = "guardian-child.cjs";
export const RUNTIME_HELPER_INJECTOR_HOLD = "injector-hold.cjs";
export const RUNTIME_HELPER_RETIREMENT_OBSERVER = "retirement-observer.py";
export const RUNTIME_HELPER_TEMP_SUPERVISOR = "grokbox-temp-supervisor.cjs";

export const RUNTIME_HELPER_FILES = [
  RUNTIME_HELPER_PRELOAD,
  RUNTIME_HELPER_GUARDIAN_CHILD,
  RUNTIME_HELPER_INJECTOR_HOLD,
  RUNTIME_HELPER_TEMP_SUPERVISOR,
  RUNTIME_HELPER_RETIREMENT_OBSERVER,
] as const;

/** Resolve a sibling of the published bundle (`dist/index.js`) or this source module. */
export function resolveRuntimeHelper(fileName: string, base = import.meta.url): string {
  return fileURLToPath(new URL(`./${fileName}`, base));
}

/** The current build has one preload. Source execution uses its own root dist;
 * an installed bundle uses its sibling. Neither may borrow an old run-root copy
 * or another checkout when its own artifact is missing. Resolution is lazy. */
export function resolveNodeRequireablePreload(base = import.meta.url): string {
  const url = new URL(base);
  const path = url.pathname.endsWith("/internal/process/helpers/runtime-helpers.ts")
    ? fileURLToPath(new URL("../../../../../../dist/preload.cjs", base))
    : resolveRuntimeHelper(RUNTIME_HELPER_PRELOAD, base);
  if (!existsSync(path)) throw new Error("runtime_preload_missing");
  return path;
}

export function resolveRuntimeHelpers(base = import.meta.url): {
  preload: string;
  guardianChild: string;
  injectorHold: string;
  tempSupervisor: string;
  retirementObserver: string;
} {
  return {
    preload: resolveNodeRequireablePreload(base),
    guardianChild: resolveRuntimeHelper(RUNTIME_HELPER_GUARDIAN_CHILD, base),
    injectorHold: resolveRuntimeHelper(RUNTIME_HELPER_INJECTOR_HOLD, base),
    tempSupervisor: resolveRuntimeHelper(RUNTIME_HELPER_TEMP_SUPERVISOR, base),
    retirementObserver: resolveRuntimeHelper(RUNTIME_HELPER_RETIREMENT_OBSERVER, base),
  };
}

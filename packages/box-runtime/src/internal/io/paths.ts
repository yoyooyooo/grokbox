import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";

export const DEFAULT_DURABLE_ROOT = "/workspace/.grokbox/box-runtime";
export const CLI_INSTALL_ROOT = join(homedir(), ".grokbox", "runtime");

export function resolveDurableRoot(override?: string, env: NodeJS.Dict<string> = process.env): string {
  const configured = override ?? env.GROKBOX_BOX_RUNTIME_ROOT;
  const root = configured && configured.length > 0 ? configured : DEFAULT_DURABLE_ROOT;
  if (!isAbsolute(root)) {
    throw new BoxRuntimeError("invalid_usage", "Box-runtime root must be an absolute path.");
  }
  const resolved = resolve(root);
  const install = resolve(CLI_INSTALL_ROOT);
  if (resolved === install || resolved.startsWith(`${install}${sep}`)) {
    throw new BoxRuntimeError(
      "invalid_usage",
      "Box-runtime durable state must not use the CLI install directory ~/.grokbox/runtime/.",
    );
  }
  return resolved;
}

export function modelsPath(root: string): string {
  return join(root, "models.json");
}

export function runtimeConfigPath(root: string): string {
  return join(root, "config.json");
}

export function coordinatorStatePath(root: string): string {
  return join(root, "state", "coordinator.json");
}

export function eventsPath(root: string): string {
  return join(root, "log", "events.ndjson");
}

export function contractsDir(root: string): string {
  return join(root, "contracts");
}

/** Append-only full Host source archive. Isolated from contracts/ slices and transform. */
export function hostBundlesDir(root: string): string {
  return join(root, "host-bundles");
}

export function retainedGenerationDir(root: string, sha: string): string {
  return join(hostBundlesDir(root), "generations", sha);
}

export function retainedGenerationSourcePath(root: string, sha: string): string {
  return join(retainedGenerationDir(root, sha), "source");
}

export function reviewedProfilePath(root: string): string {
  return join(root, "profiles", "reviewed.json");
}

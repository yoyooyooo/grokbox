import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.ts";
import { isRecord } from "../util.ts";

export type DaemonNetworkConfig = {
  host: "127.0.0.1";
  port: number;
  tokenSha256: string;
};

export type DaemonServeConfig = {
  httpsPort: number;
  dnsName: string;
  proxyUrl: string;
};

export type DaemonFilesystemRootConfig = {
  name: string;
  path: string;
  operations: Array<
    "stat" | "list" | "read" | "download" |
    "write" | "mkdir" | "upload" | "remove" | "remove-recursive" | "exec"
  >;
};

export type DaemonProcessConfig = {
  cwdRoots: string[];
  defaultCwdRoot: string;
  executables: Array<{ name: string; path: string }>;
  environment: string[];
  maxConcurrent: number;
  maxQueued: number;
  maxRuntimeMs: number;
  maxOutputBytes: number;
  shell?: { executable: string };
};

export type DaemonFilesystemConfig = {
  roots: DaemonFilesystemRootConfig[];
};

export type DaemonDesktopConfig = {
  stopWindowPath?: string;
  floorAgentIds?: string[];
  keepAgentIds?: string[];
  minIdleMs?: number;
  pruneEnabled?: boolean;
};

export type DaemonConfig = {
  version: 1;
  network?: DaemonNetworkConfig;
  serve?: DaemonServeConfig;
  filesystem?: DaemonFilesystemConfig;
  process?: DaemonProcessConfig;
  desktop?: DaemonDesktopConfig;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FS_OPERATIONS = new Set([
  "stat", "list", "read", "download",
  "write", "mkdir", "upload", "remove", "remove-recursive", "exec",
]);
const FORBIDDEN_ROOTS = ["/", "/dev", "/proc", "/run", "/sys"];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const EXECUTABLE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const FORBIDDEN_ENV = new Set(["PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "NODE_OPTIONS"]);

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CliError("profile_invalid", `${field} is outside its allowed range.`);
  }
  return value;
}

function validateProcess(input: unknown, filesystem: DaemonFilesystemConfig | undefined): DaemonProcessConfig {
  const fields = new Set(["cwdRoots", "defaultCwdRoot", "executables", "environment", "maxConcurrent", "maxQueued", "maxRuntimeMs", "maxOutputBytes", "shell"]);
  if (!isRecord(input) || Object.keys(input).some((key) => !fields.has(key)) ||
    !Array.isArray(input.cwdRoots) || input.cwdRoots.length === 0 || input.cwdRoots.length > 16 ||
    input.cwdRoots.some((name) => typeof name !== "string") || new Set(input.cwdRoots).size !== input.cwdRoots.length ||
    typeof input.defaultCwdRoot !== "string" || !input.cwdRoots.includes(input.defaultCwdRoot)) {
    throw new CliError("profile_invalid", "Daemon process cwd policy is invalid.");
  }
  const roots = new Map((filesystem?.roots ?? []).map((root) => [root.name, root]));
  if (input.cwdRoots.some((name) => !roots.get(name)?.operations.includes("exec"))) {
    throw new CliError("profile_invalid", "Every process cwd root must exist and admit exec.");
  }
  if (!Array.isArray(input.executables) || input.executables.length === 0 || input.executables.length > 64) {
    throw new CliError("profile_invalid", "Daemon process executable policy is invalid.");
  }
  const aliases = new Set<string>();
  const paths = new Set<string>();
  const executables = input.executables.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "name" && key !== "path") ||
      typeof entry.name !== "string" || !EXECUTABLE_NAME.test(entry.name) || aliases.has(entry.name) ||
      typeof entry.path !== "string" || !isAbsolute(entry.path) || entry.path.includes("\0")) {
      throw new CliError("profile_invalid", "Daemon process executable entry is invalid.");
    }
    const path = normalize(entry.path);
    if (paths.has(path) || FORBIDDEN_ROOTS.some((root) => path === root)) {
      throw new CliError("profile_invalid", "Daemon process executable path is duplicated or forbidden.");
    }
    aliases.add(entry.name); paths.add(path);
    return { name: entry.name, path };
  });
  if (!Array.isArray(input.environment) || input.environment.length > 32 ||
    input.environment.some((name) => typeof name !== "string" || !ENV_NAME.test(name) || FORBIDDEN_ENV.has(name) || name.startsWith("LD_") || name.startsWith("DYLD_")) ||
    new Set(input.environment).size !== input.environment.length) {
    throw new CliError("profile_invalid", "Daemon process environment policy is invalid.");
  }
  let shell: { executable: string } | undefined;
  if (input.shell !== undefined) {
    if (!isRecord(input.shell) || Object.keys(input.shell).some((key) => key !== "executable") ||
      typeof input.shell.executable !== "string" || !isAbsolute(input.shell.executable) || input.shell.executable.includes("\0")) {
      throw new CliError("profile_invalid", "Daemon process shell policy is invalid.");
    }
    shell = { executable: normalize(input.shell.executable) };
  }
  return {
    cwdRoots: [...input.cwdRoots] as string[],
    defaultCwdRoot: input.defaultCwdRoot,
    executables,
    environment: [...input.environment] as string[],
    maxConcurrent: boundedInteger(input.maxConcurrent, "process.maxConcurrent", 1, 16),
    maxQueued: boundedInteger(input.maxQueued, "process.maxQueued", 1, 256),
    maxRuntimeMs: boundedInteger(input.maxRuntimeMs, "process.maxRuntimeMs", 100, 86_400_000),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, "process.maxOutputBytes", 1024, 8 * 1024 * 1024),
    ...(shell ? { shell } : {}),
  };
}

function validateFilesystem(input: unknown): DaemonFilesystemConfig {
  if (!isRecord(input) || !Array.isArray(input.roots) || Object.keys(input).some((key) => key !== "roots")) {
    throw new CliError("profile_invalid", "Daemon filesystem config is invalid.");
  }
  if (input.roots.length > 16) throw new CliError("profile_invalid", "Daemon filesystem config has too many roots.");
  const names = new Set<string>();
  const roots: DaemonFilesystemRootConfig[] = input.roots.map((value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !new Set(["name", "path", "operations"]).has(key))) {
      throw new CliError("profile_invalid", "Daemon filesystem root is invalid.");
    }
    if (typeof value.name !== "string" || !ROOT_NAME.test(value.name) || names.has(value.name)) {
      throw new CliError("profile_invalid", "Daemon filesystem root name is invalid or duplicated.");
    }
    if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.includes("\0")) {
      throw new CliError("profile_invalid", "Daemon filesystem root path must be absolute.");
    }
    const path = normalize(value.path);
    if (FORBIDDEN_ROOTS.some((root) => path === root || (root !== "/" && path.startsWith(`${root}${sep}`)))) {
      throw new CliError("profile_invalid", "Daemon filesystem root cannot admit a pseudo-filesystem or filesystem root.");
    }
    if (!Array.isArray(value.operations) || value.operations.length === 0 ||
      value.operations.some((operation) => typeof operation !== "string" || !FS_OPERATIONS.has(operation)) ||
      new Set(value.operations).size !== value.operations.length) {
      throw new CliError("profile_invalid", "Daemon filesystem root operations are invalid.");
    }
    names.add(value.name);
    return {
      name: value.name,
      path,
      operations: [...value.operations] as DaemonFilesystemRootConfig["operations"],
    };
  });
  return { roots };
}

export function daemonConfigPath(configDir: string): string {
  return join(configDir, "daemon", "config.json");
}

function validPort(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CliError("profile_invalid", `${field} must be a valid TCP port.`);
  }
  return value;
}

function validateDesktop(input: unknown): DaemonDesktopConfig {
  if (!isRecord(input)) throw new CliError("profile_invalid", "Daemon desktop config is invalid.");
  const allowed = new Set(["stopWindowPath", "floorAgentIds", "keepAgentIds", "minIdleMs", "pruneEnabled"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new CliError("profile_invalid", "Daemon desktop config contains unknown field.");
  }
  const desktop: DaemonDesktopConfig = {};
  if (input.stopWindowPath !== undefined) {
    if (typeof input.stopWindowPath !== "string" || !isAbsolute(input.stopWindowPath) || input.stopWindowPath.includes("\0")) {
      throw new CliError("profile_invalid", "desktop.stopWindowPath must be an absolute path.");
    }
    desktop.stopWindowPath = normalize(input.stopWindowPath);
  }
  const ids = (field: "floorAgentIds" | "keepAgentIds"): string[] | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 64 || value.some((id) => typeof id !== "string" || !UUID_V4.test(id)) ||
      new Set(value).size !== value.length) {
      throw new CliError("profile_invalid", `desktop.${field} is invalid.`);
    }
    return [...value];
  };
  const floorAgentIds = ids("floorAgentIds");
  const keepAgentIds = ids("keepAgentIds");
  if (floorAgentIds) desktop.floorAgentIds = floorAgentIds;
  if (keepAgentIds) desktop.keepAgentIds = keepAgentIds;
  if (input.minIdleMs !== undefined) {
    desktop.minIdleMs = boundedInteger(input.minIdleMs, "desktop.minIdleMs", 600_000, 86_400_000);
  }
  if (input.pruneEnabled !== undefined) {
    if (input.pruneEnabled !== true && input.pruneEnabled !== false) {
      throw new CliError("profile_invalid", "desktop.pruneEnabled must be a boolean.");
    }
    desktop.pruneEnabled = input.pruneEnabled;
  }
  return desktop;
}

export function validateDaemonConfig(input: unknown): DaemonConfig {
  if (!isRecord(input) || input.version !== 1) {
    throw new CliError("profile_invalid", "Daemon config version must be 1.");
  }
  for (const key of Object.keys(input)) {
    if (!new Set(["version", "network", "serve", "filesystem", "process", "desktop"]).has(key)) {
      throw new CliError("profile_invalid", `Daemon config contains unknown field '${key}'.`);
    }
  }
  let network: DaemonNetworkConfig | undefined;
  if (input.network !== undefined) {
    if (!isRecord(input.network)) throw new CliError("profile_invalid", "Daemon network config is invalid.");
    for (const key of Object.keys(input.network)) {
      if (!new Set(["host", "port", "tokenSha256"]).has(key)) {
        throw new CliError("profile_invalid", `Daemon network config contains unknown field '${key}'.`);
      }
    }
    if (input.network.host !== "127.0.0.1") {
      throw new CliError("profile_invalid", "Daemon network host must be 127.0.0.1.");
    }
    if (typeof input.network.tokenSha256 !== "string" || !SHA256_HEX.test(input.network.tokenSha256)) {
      throw new CliError("profile_invalid", "Daemon network credential hash is invalid.");
    }
    network = {
      host: "127.0.0.1",
      port: validPort(input.network.port, "network.port"),
      tokenSha256: input.network.tokenSha256,
    };
  }
  let serve: DaemonServeConfig | undefined;
  if (input.serve !== undefined) {
    if (!isRecord(input.serve)) throw new CliError("profile_invalid", "Daemon Serve config is invalid.");
    for (const key of Object.keys(input.serve)) {
      if (!new Set(["httpsPort", "dnsName", "proxyUrl"]).has(key)) {
        throw new CliError("profile_invalid", `Daemon Serve config contains unknown field '${key}'.`);
      }
    }
    if (typeof input.serve.dnsName !== "string" || !/^[A-Za-z0-9.-]+$/.test(input.serve.dnsName)) {
      throw new CliError("profile_invalid", "serve.dnsName must be a DNS name.");
    }
    if (typeof input.serve.proxyUrl !== "string" || input.serve.proxyUrl.length === 0) {
      throw new CliError("profile_invalid", "serve.proxyUrl is required.");
    }
    if (!network || input.serve.proxyUrl !== `http://127.0.0.1:${network.port}`) {
      throw new CliError("profile_invalid", "serve.proxyUrl must match the configured loopback listener.");
    }
    serve = {
      httpsPort: validPort(input.serve.httpsPort, "serve.httpsPort"),
      dnsName: input.serve.dnsName,
      proxyUrl: input.serve.proxyUrl,
    };
  }
  const filesystem = input.filesystem === undefined ? undefined : validateFilesystem(input.filesystem);
  const processConfig = input.process === undefined ? undefined : validateProcess(input.process, filesystem);
  const desktop = input.desktop === undefined ? undefined : validateDesktop(input.desktop);
  return {
    version: 1,
    ...(network ? { network } : {}),
    ...(serve ? { serve } : {}),
    ...(filesystem ? { filesystem } : {}),
    ...(processConfig ? { process: processConfig } : {}),
    ...(desktop ? { desktop } : {}),
  };
}

export async function readDaemonConfig(configDir: string): Promise<DaemonConfig> {
  let text: string;
  try {
    text = await readFile(daemonConfigPath(configDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new CliError("profile_invalid", "Daemon config is unreadable.");
  }
  try {
    return validateDaemonConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("profile_invalid", "Daemon config is not valid JSON.");
  }
}

export async function writeDaemonConfig(configDir: string, config: DaemonConfig): Promise<void> {
  const validated = validateDaemonConfig(config);
  const path = daemonConfigPath(configDir);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = join(dir, `.config.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

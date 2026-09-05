import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { DEFAULT_DISCOVERY_PATH } from "../registry.ts";
import { isRecord } from "../util.ts";

export type Transport = "auto" | "daemon" | "local" | "gateway";
export type SecretRef = string;

export type SandboxProfile = {
  access_token_ref?: SecretRef;
  keepalive_interval_ms?: number;
};

export type QuotaProfile = {
  source: "cursor-web";
  access_token_ref: SecretRef;
};

export type ProfileFile = {
  version: 1;
  transport?: Transport;
  server_url?: string;
  daemon_token_ref?: SecretRef;
  gateway_url?: string;
  gateway_token_ref?: SecretRef;
  gateway_headers_ref?: SecretRef;
  gateway_discovery?: string;
  daemon_socket?: string;
  ssh_host?: string;
  sandbox?: SandboxProfile;
  quota?: QuotaProfile;
};

export type ResolvedProfile = ProfileFile & {
  name: string;
  transport: Transport;
  gateway_discovery: string;
  daemon_socket: string;
};

export type GlobalConfig = { version: 1; current_profile?: string };

const PROFILE_KEYS = new Set([
  "version",
  "transport",
  "server_url",
  "daemon_token_ref",
  "gateway_url",
  "gateway_token_ref",
  "gateway_headers_ref",
  "gateway_discovery",
  "daemon_socket",
  "ssh_host",
  "sandbox",
  "quota",
]);
const SANDBOX_KEYS = new Set(["access_token_ref", "keepalive_interval_ms"]);
const QUOTA_KEYS = new Set(["source", "access_token_ref"]);
const GLOBAL_KEYS = new Set(["version", "current_profile"]);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

function invalid(message: string): CliError {
  return new CliError("profile_invalid", message);
}

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) throw invalid("Profile name must use 1-64 safe filename characters.");
  return name;
}

export function assertSshHost(value: string): string {
  if (!SSH_HOST.test(value)) {
    throw invalid("ssh_host must be a safe host, user@host, or configured SSH alias.");
  }
  return value;
}

function assertKnownKeys(record: Record<string, unknown>, keys: Set<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw invalid(`${label} contains unknown field '${key}'.`);
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw invalid(`${key} must be a non-empty string.`);
  return value;
}

function isLoopbackUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateUrl(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`${key} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`${key} must use HTTP or HTTPS.`);
  }
  if (parsed.protocol === "http:" && !isLoopbackUrlHost(parsed.hostname)) {
    throw invalid(`${key} must use HTTPS unless its host is loopback.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid(`${key} must not contain credentials, query parameters, or fragments.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateSecretRef(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("env:")) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(4))) throw invalid(`${key} has an invalid env reference.`);
    return value;
  }
  if (value.startsWith("file:")) {
    if (!isAbsolute(value.slice(5))) throw invalid(`${key} file reference must be absolute.`);
    return value;
  }
  if (value.startsWith("keychain:")) {
    const payload = value.slice(9);
    const slash = payload.indexOf("/");
    if (slash <= 0 || slash === payload.length - 1) {
      throw invalid(`${key} keychain reference must be service/account.`);
    }
    return value;
  }
  throw invalid(`${key} must use env:, file:, or keychain:.`);
}

export function validateProfile(input: unknown): ProfileFile {
  if (!isRecord(input)) throw invalid("Profile must be a JSON object.");
  assertKnownKeys(input, PROFILE_KEYS, "Profile");
  if (input.version !== 1) throw invalid("Profile version must be 1.");
  const transport = optionalString(input, "transport");
  if (transport !== undefined && !["auto", "daemon", "local", "gateway"].includes(transport)) {
    throw invalid("transport must be auto, daemon, local, or gateway.");
  }
  const gatewayDiscovery = optionalString(input, "gateway_discovery");
  const daemonSocket = optionalString(input, "daemon_socket");
  if (gatewayDiscovery !== undefined && !isAbsolute(gatewayDiscovery)) {
    throw invalid("gateway_discovery must be absolute.");
  }
  if (daemonSocket !== undefined && !isAbsolute(daemonSocket)) {
    throw invalid("daemon_socket must be absolute.");
  }
  let sandbox: SandboxProfile | undefined;
  if (input.sandbox !== undefined) {
    if (!isRecord(input.sandbox)) throw invalid("sandbox must be an object.");
    assertKnownKeys(input.sandbox, SANDBOX_KEYS, "sandbox");
    const interval = input.sandbox.keepalive_interval_ms;
    if (interval !== undefined && (!Number.isInteger(interval) || (interval as number) < 1000)) {
      throw invalid("sandbox.keepalive_interval_ms must be an integer >= 1000.");
    }
    sandbox = {
      access_token_ref: validateSecretRef(
        optionalString(input.sandbox, "access_token_ref"),
        "sandbox.access_token_ref",
      ),
      keepalive_interval_ms: interval as number | undefined,
    };
    if (sandbox.access_token_ref === undefined) delete sandbox.access_token_ref;
    if (sandbox.keepalive_interval_ms === undefined) delete sandbox.keepalive_interval_ms;
  }
  let quota: QuotaProfile | undefined;
  if (input.quota !== undefined) {
    if (!isRecord(input.quota)) throw invalid("quota must be an object.");
    assertKnownKeys(input.quota, QUOTA_KEYS, "quota");
    const source = optionalString(input.quota, "source");
    if (source !== "cursor-web") throw invalid("quota.source must be cursor-web.");
    const accessTokenRef = validateSecretRef(
      optionalString(input.quota, "access_token_ref"),
      "quota.access_token_ref",
    );
    if (accessTokenRef === undefined) throw invalid("quota.access_token_ref is required.");
    quota = { source, access_token_ref: accessTokenRef };
  }
  const profile: ProfileFile = {
    version: 1,
    transport: transport as Transport | undefined,
    server_url: validateUrl(optionalString(input, "server_url"), "server_url"),
    daemon_token_ref: validateSecretRef(optionalString(input, "daemon_token_ref"), "daemon_token_ref"),
    gateway_url: validateUrl(optionalString(input, "gateway_url"), "gateway_url"),
    gateway_token_ref: validateSecretRef(optionalString(input, "gateway_token_ref"), "gateway_token_ref"),
    gateway_headers_ref: validateSecretRef(optionalString(input, "gateway_headers_ref"), "gateway_headers_ref"),
    gateway_discovery: gatewayDiscovery,
    daemon_socket: daemonSocket,
    ssh_host: (() => {
      const value = optionalString(input, "ssh_host");
      return value === undefined ? undefined : assertSshHost(value);
    })(),
    sandbox,
    quota,
  };
  for (const key of Object.keys(profile) as Array<keyof ProfileFile>) {
    if (profile[key] === undefined) delete profile[key];
  }
  return profile;
}

export function validateGlobalConfig(input: unknown): GlobalConfig {
  if (!isRecord(input)) throw invalid("Global config must be a JSON object.");
  assertKnownKeys(input, GLOBAL_KEYS, "Global config");
  if (input.version !== 1) throw invalid("Global config version must be 1.");
  const current = optionalString(input, "current_profile");
  if (current !== undefined) assertProfileName(current);
  return current === undefined ? { version: 1 } : { version: 1, current_profile: current };
}

async function readJson(path: string, missing: "null" | "error"): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missing === "null") return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError("profile_not_found", "Profile does not exist.");
    }
    throw invalid("Configuration file is unreadable.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("Configuration file is not valid JSON.");
  }
}

export function globalConfigPath(configDir: string): string {
  return join(configDir, "config.json");
}

export function profileConfigPath(configDir: string, name: string): string {
  return join(configDir, "profiles", assertProfileName(name), "config.json");
}

export async function readGlobalConfig(configDir: string): Promise<GlobalConfig> {
  const raw = await readJson(globalConfigPath(configDir), "null");
  return raw === null ? { version: 1 } : validateGlobalConfig(raw);
}

export async function readProfileFile(configDir: string, name: string): Promise<ProfileFile | null> {
  assertProfileName(name);
  const raw = await readJson(profileConfigPath(configDir, name), "null");
  if (raw === null) {
    if (name === "default") return null;
    throw new CliError("profile_not_found", `Profile '${name}' does not exist.`);
  }
  return validateProfile(raw);
}

function defaultSocket(configDir: string, env: Readonly<Record<string, string | undefined>>): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && isAbsolute(runtime)
    ? join(runtime, "grokbox", "daemon.sock")
    : join(configDir, "run", "daemon.sock");
}

export async function resolveProfile(
  deps: Pick<CliDeps, "configDir" | "env" | "discoveryPath">,
  explicitName?: string,
): Promise<ResolvedProfile> {
  const global = await readGlobalConfig(deps.configDir);
  const name = assertProfileName(
    explicitName ?? deps.env.GROKBOX_PROFILE ?? global.current_profile ?? "default",
  );
  const overlay = await readProfileFile(deps.configDir, name);
  return {
    version: 1,
    name,
    transport: overlay?.transport ?? "auto",
    gateway_discovery: overlay?.gateway_discovery ?? deps.discoveryPath ?? DEFAULT_DISCOVERY_PATH,
    daemon_socket: overlay?.daemon_socket ?? defaultSocket(deps.configDir, deps.env),
    ...overlay,
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.config.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

export async function writeProtectedSecret(path: string, value: string): Promise<void> {
  if (!isAbsolute(path)) throw invalid("Secret output path must be absolute.");
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.secret.${randomUUID()}.tmp`);
  await writeFile(temp, value, { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

export async function writeGlobalConfig(configDir: string, config: GlobalConfig): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  await atomicJson(globalConfigPath(configDir), validateGlobalConfig(config));
}

export async function writeProfileFile(
  configDir: string,
  name: string,
  profile: ProfileFile,
): Promise<void> {
  await mkdir(join(configDir, "profiles"), { recursive: true, mode: 0o700 });
  await chmod(join(configDir, "profiles"), 0o700);
  await atomicJson(profileConfigPath(configDir, name), validateProfile(profile));
}

export async function listProfileNames(configDir: string): Promise<string[]> {
  const root = join(configDir, "profiles");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["default"];
    throw invalid("Profile directory is unreadable.");
  }
  const names = new Set<string>(["default"]);
  for (const entry of entries) {
    if (!PROFILE_NAME.test(entry)) continue;
    try {
      const info = await stat(profileConfigPath(configDir, entry));
      if (info.isFile()) names.add(entry);
    } catch {
      // Ignore incomplete directories; profile show reports explicit errors.
    }
  }
  return [...names].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

export async function profileExists(configDir: string, name: string): Promise<boolean> {
  if (name === "default") return true;
  try {
    await readProfileFile(configDir, name);
    return true;
  } catch (error) {
    if (error instanceof CliError && error.code === "profile_not_found") return false;
    throw error;
  }
}

export async function removeProfile(configDir: string, name: string): Promise<void> {
  assertProfileName(name);
  if (name === "default") throw invalid("The built-in default Profile cannot be removed.");
  if (!(await profileExists(configDir, name))) {
    throw new CliError("profile_not_found", `Profile '${name}' does not exist.`);
  }
  await rm(join(configDir, "profiles", name), { recursive: true, force: false });
  const global = await readGlobalConfig(configDir);
  if (global.current_profile === name) await writeGlobalConfig(configDir, { version: 1, current_profile: "default" });
}

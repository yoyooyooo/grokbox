import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { openConfigStore, readConfigLayout, commitConfigChange } from "@grokbox/box-runtime/runtime";
import { configSchemaAt, validateNode, type ConnectionProfile } from "@grokbox/runtime-kernel/config";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { DEFAULT_DISCOVERY_PATH } from "../registry.ts";
import { isRecord } from "../util.ts";

export type Transport = "auto" | "daemon" | "local" | "gateway";
export type SecretRef = string;
export type SandboxProfile = { access_token_ref?: SecretRef; keepalive_interval_ms?: number };
export type QuotaProfile = { source: "cursor-web"; access_token_ref: SecretRef };
/** Transport DTO used by Gateway/bootstrap. Persistence is exclusively the
 * camelCase client.profiles map in config v2, never a separate Profile file. */
export type ProfileFile = {
  version: 1; transport?: Transport; server_url?: string; daemon_token_ref?: SecretRef; installation_id?: string;
  gateway_url?: string; gateway_token_ref?: SecretRef; gateway_headers_ref?: SecretRef;
  gateway_discovery?: string; daemon_socket?: string; ssh_host?: string;
  sandbox?: SandboxProfile; quota?: QuotaProfile;
};
export type ResolvedProfile = ProfileFile & { name: string; transport: Transport; gateway_discovery: string; daemon_socket: string };
export type GlobalConfig = { version: 1; current_profile?: string };
const FIELD_MAP = {
  transport: "transport", server_url: "serverUrl", daemon_token_ref: "daemonTokenRef", installation_id: "installationId",
  gateway_url: "gatewayUrl", gateway_token_ref: "gatewayTokenRef", gateway_headers_ref: "gatewayHeadersRef",
  gateway_discovery: "gatewayDiscovery", daemon_socket: "daemonSocket", ssh_host: "sshHost",
} as const;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function invalid(message: string): CliError { return new CliError("profile_invalid", message); }
export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) throw invalid("Profile name must use 1-64 safe characters.");
  return name;
}
export function assertSshHost(value: string): string {
  try { validateNode(value, configSchemaAt(["client", "profiles", "default", "sshHost"])); }
  catch { throw invalid("ssh_host must be a safe host or configured SSH alias."); }
  return value;
}
export function validateSecretRef(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  try { validateNode(value, configSchemaAt(["client", "profiles", "default", "daemonTokenRef"])); }
  catch { throw invalid(`${key} must be a protected env:, file:, or keychain: reference.`); }
  return value;
}
export function profileToConfig(input: unknown): ConnectionProfile {
  if (!isRecord(input) || input.version !== 1 || Object.keys(input).some((key) => !["version", ...Object.keys(FIELD_MAP), "sandbox", "quota"].includes(key))) throw invalid("Invalid Profile transport description.");
  const result: Record<string, unknown> = {};
  for (const [field, destination] of Object.entries(FIELD_MAP)) if (input[field] !== undefined) result[destination] = input[field];
  if (input.sandbox !== undefined) {
    if (!isRecord(input.sandbox) || Object.keys(input.sandbox).some((key) => !["access_token_ref", "keepalive_interval_ms"].includes(key))) throw invalid("Invalid sandbox settings.");
    result.sandbox = {
      ...(input.sandbox.access_token_ref !== undefined ? { accessTokenRef: input.sandbox.access_token_ref } : {}),
      ...(input.sandbox.keepalive_interval_ms !== undefined ? { keepaliveIntervalMs: input.sandbox.keepalive_interval_ms } : {}),
    };
  }
  if (input.quota !== undefined) {
    if (!isRecord(input.quota) || Object.keys(input.quota).some((key) => !["source", "access_token_ref"].includes(key))) throw invalid("Invalid quota settings.");
    result.quota = { source: input.quota.source, accessTokenRef: input.quota.access_token_ref };
  }
  try { validateNode(result, configSchemaAt(["client", "profiles", "default"])); }
  catch { throw invalid("Profile does not satisfy the connection schema."); }
  return result as ConnectionProfile;
}
export function profileFromConfig(input: ConnectionProfile): ProfileFile {
  const result: Record<string, unknown> = { version: 1 };
  for (const [field, source] of Object.entries(FIELD_MAP)) if (input[source] !== undefined) result[field] = input[source];
  if (input.sandbox) result.sandbox = {
    ...(input.sandbox.accessTokenRef !== undefined ? { access_token_ref: input.sandbox.accessTokenRef } : {}),
    ...(input.sandbox.keepaliveIntervalMs !== undefined ? { keepalive_interval_ms: input.sandbox.keepaliveIntervalMs } : {}),
  };
  if (input.quota) result.quota = { source: input.quota.source, access_token_ref: input.quota.accessTokenRef };
  return result as ProfileFile;
}
export function validateProfile(input: unknown): ProfileFile { return profileFromConfig(profileToConfig(input)); }
async function storeFor(configDir: string) { return openConfigStore(await readConfigLayout(configDir)); }
export async function readGlobalConfig(configDir: string): Promise<GlobalConfig> {
  const snapshot = await (await storeFor(configDir)).read();
  return { version: 1, current_profile: snapshot.document.client.currentProfile };
}
export async function readProfileFile(configDir: string, name: string): Promise<ProfileFile | null> {
  assertProfileName(name);
  const document = (await (await storeFor(configDir)).read()).document;
  if (!Object.hasOwn(document.client.profiles, name)) throw new CliError("profile_not_found", "Profile does not exist.");
  return profileFromConfig(document.client.profiles[name]!);
}
function defaultSocket(configDir: string, env: Readonly<Record<string, string | undefined>>): string {
  return env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)
    ? join(env.XDG_RUNTIME_DIR, "grokbox", "daemon.sock") : join(configDir, "run", "daemon.sock");
}
export async function resolveProfile(deps: Pick<CliDeps, "configDir" | "env" | "discoveryPath">, explicitName?: string): Promise<ResolvedProfile> {
  const snapshot = await (await storeFor(deps.configDir)).read();
  const name = assertProfileName(explicitName ?? deps.env.GROKBOX_PROFILE ?? snapshot.document.client.currentProfile);
  const config = snapshot.document.client.profiles[name];
  if (!config) throw new CliError("profile_not_found", "Profile does not exist.");
  const overlay = profileFromConfig(config);
  return { ...overlay, name, transport: overlay.transport ?? "auto",
    gateway_discovery: overlay.gateway_discovery ?? deps.discoveryPath ?? DEFAULT_DISCOVERY_PATH,
    daemon_socket: overlay.daemon_socket ?? defaultSocket(deps.configDir, deps.env) };
}
export async function writeGlobalConfig(configDir: string, config: GlobalConfig): Promise<void> {
  if (config.version !== 1 || Object.keys(config).some((key) => !["version", "current_profile"].includes(key))) throw invalid("Invalid Profile selection request.");
  const current = assertProfileName(config.current_profile ?? "default");
  const store = await storeFor(configDir);
  await commitConfigChange(store, { operationId: randomUUID(), scope: "client", kind: "set", path: "client.currentProfile", value: current, confirm: true });
}
export async function writeProfileFile(configDir: string, name: string, profile: ProfileFile): Promise<void> {
  const value = profileToConfig(profile); assertProfileName(name);
  const store = await storeFor(configDir);
  await commitConfigChange(store, { operationId: randomUUID(), scope: "client", kind: "set", path: `/client/profiles/${name}`, value, confirm: true });
}
export async function listProfileNames(configDir: string): Promise<string[]> {
  const document = (await (await storeFor(configDir)).read()).document;
  return Object.keys(document.client.profiles).sort((a, b) => a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b));
}
export async function profileExists(configDir: string, name: string): Promise<boolean> {
  assertProfileName(name);
  const document = (await (await storeFor(configDir)).read()).document;
  return Object.hasOwn(document.client.profiles, name);
}
export async function removeProfile(configDir: string, name: string): Promise<void> {
  assertProfileName(name);
  if (name === "default") throw invalid("The built-in default Profile cannot be removed.");
  const store = await storeFor(configDir); const snapshot = await store.read();
  if (!Object.hasOwn(snapshot.document.client.profiles, name)) throw new CliError("profile_not_found", "Profile does not exist.");
  const document = structuredClone(snapshot.document); delete document.client.profiles[name];
  if (document.client.currentProfile === name) document.client.currentProfile = "default";
  await commitConfigChange(store, { operationId: randomUUID(), scope: "client", kind: "replace", value: document, expectedRevision: snapshot.revision, confirm: true, replaceArrays: true });
}

/** Secret provider operation, deliberately not a generic config mutation. */
export async function writeProtectedSecret(path: string, value: string): Promise<void> {
  if (!isAbsolute(path)) throw invalid("Secret output path must be absolute.");
  const dir = dirname(path); await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.secret-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(value, "utf8"); await handle.sync();
    await rename(temporary, path); published = true; await chmod(path, 0o600);
  } finally { await handle.close(); if (!published) await unlink(temporary).catch(() => undefined); }
}

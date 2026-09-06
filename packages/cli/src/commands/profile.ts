import { isAbsolute } from "node:path";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { parseInteger, stripOneTrailingNewline, utf8Bytes } from "../util.ts";
import {
  listProfileNames,
  profileExists,
  readGlobalConfig,
  readProfileFile,
  removeProfile,
  resolveProfile,
  validateProfile,
  writeGlobalConfig,
  writeProfileFile,
  writeProtectedSecret,
  type ProfileFile,
} from "../config/profile.ts";

export type ProfileOptions = {
  json?: boolean;
  table?: boolean;
  transport?: string;
  serverUrl?: string;
  daemonTokenRef?: string;
  gatewayUrl?: string;
  gatewayTokenRef?: string;
  gatewayHeadersRef?: string;
  gatewayDiscovery?: string;
  daemonSocket?: string;
  sshHost?: string;
  sandboxAccessTokenRef?: string;
  keepaliveIntervalMs?: string;
  quotaSource?: string;
  quotaAccessTokenRef?: string;
  secretStdinFile?: string;
};

type ProfilePatch = Omit<ProfileFile, "version" | "quota"> & {
  quota?: Partial<NonNullable<ProfileFile["quota"]>>;
};

type SecretInput = { path: string; field: "daemon" | "gateway" | "headers" | "sandbox" | "quota" };

function applySecretInput(
  patch: ProfilePatch,
  raw: ProfileOptions,
): SecretInput | null {
  if (raw.secretStdinFile === undefined) return null;
  const equals = raw.secretStdinFile.indexOf("=");
  if (equals <= 0) throw usage("--secret-stdin-file must be <field>=<absolute-path>.");
  const field = raw.secretStdinFile.slice(0, equals);
  const path = raw.secretStdinFile.slice(equals + 1);
  if (!isAbsolute(path)) throw usage("--secret-stdin-file path must be absolute.");
  const ref = `file:${path}`;
  if (field === "daemon-token") {
    if (patch.daemon_token_ref !== undefined) throw usage("Choose one daemon token input.");
    patch.daemon_token_ref = ref;
    return { path, field: "daemon" };
  }
  if (field === "gateway-token") {
    if (patch.gateway_token_ref !== undefined) throw usage("Choose one Gateway token input.");
    patch.gateway_token_ref = ref;
    return { path, field: "gateway" };
  }
  if (field === "gateway-headers") {
    if (patch.gateway_headers_ref !== undefined) throw usage("Choose one Gateway headers input.");
    patch.gateway_headers_ref = ref;
    return { path, field: "headers" };
  }
  if (field === "sandbox-access-token") {
    patch.sandbox ??= {};
    if (patch.sandbox.access_token_ref !== undefined) throw usage("Choose one Sandbox token input.");
    patch.sandbox.access_token_ref = ref;
    return { path, field: "sandbox" };
  }
  if (field === "quota-access-token") {
    patch.quota ??= {};
    if (patch.quota.access_token_ref !== undefined) throw usage("Choose one quota token input.");
    patch.quota.access_token_ref = ref;
    return { path, field: "quota" };
  }
  throw usage("Secret field must be daemon-token, gateway-token, gateway-headers, sandbox-access-token, or quota-access-token.");
}

async function persistSecretInput(deps: CliDeps, input: SecretInput | null): Promise<void> {
  if (!input) return;
  if (deps.stdinIsTTY) throw usage("--secret-stdin-file requires non-TTY stdin; secrets are never read from argv.");
  const secret = stripOneTrailingNewline(await deps.readStdin());
  if (secret.length === 0) throw usage("Secret stdin is empty.");
  if (utf8Bytes(secret) > 1024 * 1024) throw usage("Secret stdin exceeds 1 MiB.");
  await writeProtectedSecret(input.path, secret);
}

function patchFromOptions(raw: ProfileOptions): ProfilePatch {
  const patch: ProfilePatch = {};
  if (raw.transport !== undefined) patch.transport = raw.transport as ProfileFile["transport"];
  if (raw.serverUrl !== undefined) patch.server_url = raw.serverUrl;
  if (raw.daemonTokenRef !== undefined) patch.daemon_token_ref = raw.daemonTokenRef;
  if (raw.gatewayUrl !== undefined) patch.gateway_url = raw.gatewayUrl;
  if (raw.gatewayTokenRef !== undefined) patch.gateway_token_ref = raw.gatewayTokenRef;
  if (raw.gatewayHeadersRef !== undefined) patch.gateway_headers_ref = raw.gatewayHeadersRef;
  if (raw.gatewayDiscovery !== undefined) patch.gateway_discovery = raw.gatewayDiscovery;
  if (raw.daemonSocket !== undefined) patch.daemon_socket = raw.daemonSocket;
  if (raw.sshHost !== undefined) patch.ssh_host = raw.sshHost;
  if (raw.sandboxAccessTokenRef !== undefined || raw.keepaliveIntervalMs !== undefined) {
    patch.sandbox = {};
    if (raw.sandboxAccessTokenRef !== undefined) {
      patch.sandbox.access_token_ref = raw.sandboxAccessTokenRef;
    }
    if (raw.keepaliveIntervalMs !== undefined) {
      patch.sandbox.keepalive_interval_ms = parseInteger(raw.keepaliveIntervalMs, {
        name: "--keepalive-interval-ms",
        min: 1000,
        max: Number.MAX_SAFE_INTEGER,
      });
    }
  }
  const quotaSecret = raw.secretStdinFile?.startsWith("quota-access-token=") ?? false;
  if (raw.quotaSource !== undefined || raw.quotaAccessTokenRef !== undefined || quotaSecret) {
    if (raw.quotaSource !== "cursor-web") {
      throw usage("Quota configuration requires --quota-source cursor-web.");
    }
    patch.quota = { source: "cursor-web" };
    if (raw.quotaAccessTokenRef !== undefined) {
      patch.quota.access_token_ref = raw.quotaAccessTokenRef;
    }
    if (raw.quotaAccessTokenRef === undefined && !quotaSecret) {
      throw usage("Quota configuration requires --quota-access-token-ref or quota-access-token stdin.");
    }
  }
  return patch;
}

export async function runProfileList(deps: CliDeps, raw: ProfileOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const global = await readGlobalConfig(deps.configDir);
  const names = await listProfileNames(deps.configDir);
  const current = deps.env.GROKBOX_PROFILE ?? global.current_profile ?? "default";
  const profiles = names.map((name) => ({ name, current: name === current, builtIn: name === "default" }));
  if (io.table) {
    deps.stdout.write(
      formatTable(profiles.map((profile) => ({
        name: profile.name,
        current: String(profile.current),
        builtIn: String(profile.builtIn),
      }))),
    );
    return;
  }
  writeSuccess(deps.stdout, { current, profiles });
}

export async function runProfileShow(
  deps: CliDeps,
  name: string | undefined,
  raw: ProfileOptions,
): Promise<void> {
  ioFromOpts(raw);
  const profile = await resolveProfile(deps, name);
  writeSuccess(deps.stdout, { profile });
}

export async function runProfileUse(deps: CliDeps, name: string, raw: ProfileOptions): Promise<void> {
  ioFromOpts(raw);
  if (!(await profileExists(deps.configDir, name))) {
    throw new CliError("profile_not_found", `Profile '${name}' does not exist.`);
  }
  await writeGlobalConfig(deps.configDir, { version: 1, current_profile: name });
  writeSuccess(deps.stdout, { current_profile: name });
}

export async function runProfileAdd(
  deps: CliDeps,
  name: string,
  raw: ProfileOptions,
): Promise<void> {
  ioFromOpts(raw);
  const existingOverlay = await readProfileFile(deps.configDir, name).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "profile_not_found") return null;
    throw error;
  });
  if (existingOverlay !== null) throw new CliError("profile_invalid", `Profile '${name}' already exists.`);
  if (name !== "default" && (await profileExists(deps.configDir, name))) {
    throw new CliError("profile_invalid", `Profile '${name}' already exists.`);
  }
  const patch = patchFromOptions(raw);
  const secretInput = applySecretInput(patch, raw);
  const profile = validateProfile({ version: 1, ...patch });
  await persistSecretInput(deps, secretInput);
  await writeProfileFile(deps.configDir, name, profile);
  writeSuccess(deps.stdout, { name, created: true });
}

export async function runProfileUpdate(
  deps: CliDeps,
  name: string,
  raw: ProfileOptions,
): Promise<void> {
  ioFromOpts(raw);
  const current = await readProfileFile(deps.configDir, name);
  if (current === null && name !== "default") {
    throw new CliError("profile_not_found", `Profile '${name}' does not exist.`);
  }
  const patch = patchFromOptions(raw);
  const secretInput = applySecretInput(patch, raw);
  if (Object.keys(patch).length === 0) throw usage("profile update requires at least one connection option.");
  const sandbox = patch.sandbox
    ? { ...(current?.sandbox ?? {}), ...patch.sandbox }
    : current?.sandbox;
  const quota = patch.quota
    ? { ...(current?.quota ?? {}), ...patch.quota }
    : current?.quota;
  const next = validateProfile({ version: 1, ...(current ?? {}), ...patch, sandbox, quota });
  await persistSecretInput(deps, secretInput);
  await writeProfileFile(deps.configDir, name, next);
  writeSuccess(deps.stdout, { name, updated: true });
}

export async function runProfileRemove(
  deps: CliDeps,
  name: string,
  raw: ProfileOptions,
): Promise<void> {
  ioFromOpts(raw);
  await removeProfile(deps.configDir, name);
  writeSuccess(deps.stdout, { name, removed: true });
}

export async function runProfileCapabilities(
  deps: CliDeps,
  name: string | undefined,
  raw: ProfileOptions,
): Promise<void> {
  ioFromOpts(raw);
  const profile = await resolveProfile(deps, name);
  const local = profile.transport === "auto" || profile.transport === "local";
  const directGateway = profile.transport === "gateway" || Boolean(profile.gateway_url);
  const daemon = profile.transport === "daemon"
    || (profile.transport === "auto" && Boolean(profile.server_url));
  const sandboxConfigured = Boolean(profile.sandbox?.access_token_ref);
  const sandboxCapability = sandboxConfigured ? "provider-authorization-dependent" : false;
  const quotaCapability = profile.quota?.access_token_ref
    ? "provider-authorization-dependent"
    : false;
  writeSuccess(deps.stdout, {
    profile: profile.name,
    transport: profile.transport,
    connection: {
      endpoint: daemon
        ? (profile.server_url ?? profile.daemon_socket)
        : (profile.gateway_url ?? profile.gateway_discovery ?? null),
      protocolMajor: daemon ? 1 : null,
      credentialReference: daemon
        ? profile.daemon_token_ref ?? null
        : profile.gateway_token_ref ?? null,
      credentialConfigured: daemon
        ? Boolean(profile.daemon_token_ref)
        : Boolean(profile.gateway_token_ref),
      gatewayGeneration: "reported-by-doctor-at-runtime",
    },
    capabilities: {
      "grok.roster.read": local || directGateway || daemon,
      "grok.transcript.read": local || directGateway || daemon,
      "grok.transcript.write": local || directGateway || daemon,
      "grok.memory.read": local || directGateway || daemon,
      "grok.events.read": local || directGateway || daemon,
      "host.fs.read": daemon,
      "host.fs.write": daemon ? "runtime-policy-dependent" : false,
      "host.process.run": daemon ? "runtime-policy-dependent" : false,
      "host.process.manage": daemon ? "runtime-policy-dependent" : false,
      "host.process.shell": daemon ? "runtime-policy-dependent" : false,
      "host.desktop.read": daemon,
      "host.desktop.reap": daemon ? "runtime-policy-dependent" : false,
      "sandbox.inspect": sandboxCapability,
      "sandbox.wake": sandboxCapability,
      "sandbox.keepalive": sandboxCapability,
      "quota.read": quotaCapability,
    },
  });
}

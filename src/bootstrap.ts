import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProfileFile } from "./config/profile.ts";
import { assertSshHost, writeProtectedSecret } from "./config/profile.ts";
import type { CliDeps, CommandOptions, CommandResult } from "./deps.ts";
import { RemoteDaemonClient } from "./daemon/client.ts";
import type { DaemonConfig } from "./daemon/config.ts";
import { CliError } from "./errors.ts";
import { isRecord } from "./util.ts";

export const DAEMON_PORT = 37134;
export const SERVE_HTTPS_PORT = 8443;
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] as const;

export type BootstrapPeer = {
  name: string;
  dnsName: string;
  ipv4: string | null;
};

export type BootstrapResult = {
  profile: ProfileFile;
  serverUrl: string;
  secretPath: string;
  daemonPort: number;
  serveHttpsPort: number;
  operationId: string;
};

function sshArgv(host: string, command: string): string[] {
  return ["ssh", ...SSH_OPTIONS, host, command];
}

function commandFailure(code: "bootstrap_unavailable" | "tailscale_not_ready", message: string): CliError {
  return new CliError(code, message);
}

async function requireSuccess(
  deps: CliDeps,
  argv: readonly string[],
  code: "bootstrap_unavailable" | "tailscale_not_ready",
  message: string,
  options?: CommandOptions,
): Promise<CommandResult> {
  const result = await deps.runCommand(argv, options);
  if (result.code !== 0) throw commandFailure(code, message);
  return result;
}

function containsPort(value: unknown, port: number): boolean {
  const wanted = String(port);
  if (typeof value === "string" || typeof value === "number") return String(value) === wanted;
  if (Array.isArray(value)) return value.some((entry) => containsPort(entry, port));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => key === wanted || containsPort(entry, port));
}

export type ServePortState = { inUse: boolean; exact: boolean };

export type RecordedServeMappingState = "exact" | "absent" | "drifted" | "unrecorded";

export type ServeMappingResult = {
  state: RecordedServeMappingState;
  changed: boolean;
};

async function inspectServePort(
  deps: CliDeps,
  sshHost: string,
  dnsName: string,
  timeoutMs = 10_000,
): Promise<ServePortState> {
  const result = await requireSuccess(
    deps,
    sshArgv(sshHost, "sudo -n tailscale serve status --json"),
    "tailscale_not_ready",
    "The peer cannot inspect Tailscale Serve with passwordless sudo.",
    { timeoutMs, signal: deps.signal },
  );
  try {
    const parsed = JSON.parse(result.stdout);
    const inUse = containsPort(parsed, SERVE_HTTPS_PORT);
    const web = isRecord(parsed) && isRecord(parsed.Web) ? parsed.Web : {};
    const siteValue = web[`${dnsName}:${SERVE_HTTPS_PORT}`];
    const site: Record<string, unknown> | null = isRecord(siteValue) ? siteValue : null;
    const handlers: Record<string, unknown> = site && isRecord(site.Handlers) ? site.Handlers : {};
    const rootValue = handlers["/"];
    const root: Record<string, unknown> | null = isRecord(rootValue) ? rootValue : null;
    const exact = root?.Proxy === `http://127.0.0.1:${DAEMON_PORT}`;
    return { inUse, exact };
  } catch {
    throw commandFailure("tailscale_not_ready", "The peer returned invalid Tailscale Serve status.");
  }
}

export function ownedMappingProbeCommand(dnsName: string): string {
  const script = [
    "const fs=require('node:fs');",
    "try{",
    "const c=JSON.parse(fs.readFileSync(process.env.HOME+'/.grokbox/daemon/config.json','utf8'));",
    `process.exit(c?.serve?.httpsPort===${SERVE_HTTPS_PORT}&&c?.serve?.dnsName===${JSON.stringify(dnsName)}&&c?.serve?.proxyUrl===${JSON.stringify(`http://127.0.0.1:${DAEMON_PORT}`)}?0:1)`,
    "}catch{process.exit(1)}",
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

async function existingMappingIsOurs(
  deps: CliDeps,
  sshHost: string,
  dnsName: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  return (await deps.runCommand(
    sshArgv(sshHost, ownedMappingProbeCommand(dnsName)),
    { timeoutMs, signal: deps.signal },
  )).code === 0;
}

export async function inspectRecordedServeMapping(
  deps: CliDeps,
  sshHost: string,
  dnsName: string,
  timeoutMs = 10_000,
): Promise<RecordedServeMappingState> {
  assertSshHost(sshHost);
  const [port, recorded] = await Promise.all([
    inspectServePort(deps, sshHost, dnsName, timeoutMs),
    existingMappingIsOurs(deps, sshHost, dnsName, timeoutMs),
  ]);
  if (port.exact && recorded) return "exact";
  if (!port.inUse && recorded) return "absent";
  if (!port.inUse) return "unrecorded";
  return "drifted";
}

export async function ensureRecordedServeMapping(
  deps: CliDeps,
  sshHost: string,
  dnsName: string,
  timeoutMs = 10_000,
): Promise<ServeMappingResult> {
  const state = await inspectRecordedServeMapping(deps, sshHost, dnsName, timeoutMs);
  if (state === "exact") return { state, changed: false };
  if (state !== "absent") {
    throw new CliError(
      "recover_failed",
      state === "drifted"
        ? "The recorded Tailscale Serve mapping has drifted or is occupied."
        : "Bootstrap did not record ownership of the required Tailscale Serve mapping.",
      {
        failureCode: state === "drifted" ? "serve_mapping_drifted" : "serve_mapping_unrecorded",
        retryable: false,
      },
    );
  }
  const applied = await deps.runCommand(
    sshArgv(sshHost, `sudo -n tailscale serve --bg --yes --https=${SERVE_HTTPS_PORT} http://127.0.0.1:${DAEMON_PORT}`),
    { timeoutMs, signal: deps.signal },
  );
  const after = await inspectRecordedServeMapping(deps, sshHost, dnsName, timeoutMs);
  if (applied.code !== 0 || after !== "exact") {
    throw new CliError(
      "recover_failed",
      "The recorded private Tailscale Serve mapping could not be restored exactly.",
      { failureCode: "serve_restore_failed", retryable: true },
    );
  }
  return { state: after, changed: true };
}

export function remoteEnsureInstalledDaemonCommand(): string {
  const binary = "$HOME/.grokbox/runtime/bin/grokbox";
  return [
    "set -eu",
    `binary=${JSON.stringify(binary)}`,
    'config="$HOME/.grokbox/daemon/config.json"',
    'pidfile="$HOME/.grokbox/daemon/daemon.pid"',
    'test -x "$binary"',
    'test -f "$config"',
    'if "$binary" daemon status >/dev/null 2>&1; then printf "%s\\n" unchanged; exit 0; fi',
    'if [ -f "$pidfile" ]; then pid="$(cat "$pidfile" 2>/dev/null || true)"; case "$pid" in *[!0-9]*|"") ;; *) if kill -0 "$pid" 2>/dev/null; then exit 3; fi ;; esac; fi',
    'nohup "$binary" daemon serve >"$HOME/.grokbox/daemon/daemon.log" 2>&1 </dev/null & daemon_pid=$!; printf "%s\\n" "$daemon_pid" >"$pidfile"',
    'i=0; while [ ! -S "$HOME/.grokbox/run/daemon.sock" ] && kill -0 "$daemon_pid" 2>/dev/null && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.1; done',
    'kill -0 "$daemon_pid" 2>/dev/null',
    '"$binary" daemon status >/dev/null',
    'printf "%s\\n" changed',
  ].join("; ");
}

export async function ensureInstalledDaemonThroughSsh(
  deps: CliDeps,
  sshHost: string,
  timeoutMs = 20_000,
): Promise<{ changed: boolean }> {
  assertSshHost(sshHost);
  const result = await deps.runCommand(
    sshArgv(sshHost, remoteEnsureInstalledDaemonCommand()),
    { timeoutMs, signal: deps.signal },
  );
  if (result.code !== 0) {
    throw new CliError(
      "bootstrap_unavailable",
      result.code === 3
        ? "An installed daemon process is present but unhealthy; explicit bootstrap is required before replacement."
        : "The installed daemon could not be verified or started; run daemon ensure --bootstrap with confirmation.",
      { failureCode: result.code === 3 ? "daemon_process_unhealthy" : "daemon_install_required" },
    );
  }
  const outcome = result.stdout.trim().split(/\r?\n/).at(-1);
  if (outcome !== "changed" && outcome !== "unchanged") {
    throw new CliError(
      "recover_failed",
      "The SSH daemon ensure adapter returned an invalid outcome.",
      { failureCode: "daemon_ensure_invalid" },
    );
  }
  return { changed: outcome === "changed" };
}

async function restoreServeState(
  deps: CliDeps,
  sshHost: string,
  dnsName: string,
  previous: ServePortState,
): Promise<boolean> {
  const current = await inspectServePort(deps, sshHost, dnsName).catch(() => null);
  if (!current) return false;
  if (previous.inUse) {
    if (current.exact) return true;
    const restored = await deps.runCommand(
      sshArgv(sshHost, `sudo -n tailscale serve --bg --yes --https=${SERVE_HTTPS_PORT} http://127.0.0.1:${DAEMON_PORT}`),
    );
    const after = await inspectServePort(deps, sshHost, dnsName).catch(() => null);
    return restored.code === 0 && after?.exact === true;
  }
  if (!current.inUse) return true;
  if (!current.exact) return false;
  const removed = await deps.runCommand(
    sshArgv(sshHost, `sudo -n tailscale serve --yes --https=${SERVE_HTTPS_PORT} off`),
  );
  const after = await inspectServePort(deps, sshHost, dnsName).catch(() => null);
  return removed.code === 0 && after?.inUse === false;
}

async function bootstrapFixtureDirectory(deps: CliDeps): Promise<string> {
  const root = process.platform === "darwin"
    ? join(homedir(), ".Trash")
    : join(deps.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(root, "grokbox-bootstrap-"));
}

async function packRuntime(deps: CliDeps, destination: string): Promise<string> {
  let result = await deps.runCommand([
    "npm", "pack", "--ignore-scripts", "--pack-destination", destination, deps.packageRoot,
  ]);
  if (result.code === 127) {
    result = await deps.runCommand([
      "bun", "pm", "pack", "--cwd", deps.packageRoot, "--ignore-scripts", "--destination", destination, "--quiet",
    ]);
  }
  if (result.code !== 0) {
    throw commandFailure("bootstrap_unavailable", "Unable to pack the installed grokbox runtime for bootstrap.");
  }
  const candidates = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  const reported = result.stdout.trim().split(/\r?\n/).at(-1);
  const filename = reported && candidates.includes(reported) ? reported : candidates.length === 1 ? candidates[0] : undefined;
  if (!filename) throw commandFailure("bootstrap_unavailable", "The grokbox runtime package was not produced.");
  return join(destination, filename);
}

export function remoteFilesystemPolicyMergeCommand(): string {
  return `node -e "const f=require('node:fs');const old=process.env.HOME+'/.grokbox/daemon/config.json';const staged=process.env.HOME+'/.grokbox/bootstrap/daemon-config.json';if(f.existsSync(old)){const prior=JSON.parse(f.readFileSync(old,'utf8'));const next=JSON.parse(f.readFileSync(staged,'utf8'));if(next.process===undefined&&prior.process!==undefined)next.process=prior.process;if(next.desktop===undefined&&prior.desktop!==undefined)next.desktop=prior.desktop;const priorRoots=prior.filesystem?.roots;const additions=next.filesystem?.roots;if(Array.isArray(priorRoots)){if(Array.isArray(additions)){const byName=new Map(additions.map((root)=>[root.name,root]));next.filesystem={roots:[...priorRoots.map((root)=>{const addition=byName.get(root.name);return addition?{...addition,operations:[...new Set([...(Array.isArray(root.operations)?root.operations:[]),...(Array.isArray(addition.operations)?addition.operations:[])])]}:root}),...additions.filter((root)=>!priorRoots.some((priorRoot)=>priorRoot.name===root.name))]};}else{next.filesystem={roots:priorRoots};}}f.writeFileSync(staged,JSON.stringify(next,null,2),{mode:384});}"`;
}

export function remotePackageIntegrityCommand(packageSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(packageSha256)) {
    throw new CliError("bootstrap_unavailable", "The local package digest is invalid.");
  }
  const script = [
    "const fs=require('node:fs'),crypto=require('node:crypto');",
    "const path=process.env.HOME+'/.grokbox/bootstrap/package.tgz';",
    "const actual=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');",
    `process.exit(actual===${JSON.stringify(packageSha256)}?0:1);`,
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

export function remoteInstallCommand(rollbackId: string, packageSha256: string): string {
  const binary = "$HOME/.grokbox/runtime/bin/grokbox";
  const rollback = `$HOME/.grokbox/daemon/config.rollback-${rollbackId}.json`;
  const integrityCheck = remotePackageIntegrityCommand(packageSha256);
  return [
    "set -eu",
    `binary=${JSON.stringify(binary)}`,
    'mkdir -p "$HOME/.grokbox/runtime" "$HOME/.grokbox/daemon" "$HOME/.grokbox/run"',
    'chmod 700 "$HOME/.grokbox" "$HOME/.grokbox/runtime" "$HOME/.grokbox/daemon" "$HOME/.grokbox/run"',
    `if [ -f "$HOME/.grokbox/daemon/config.json" ]; then cp "$HOME/.grokbox/daemon/config.json" "${rollback}"; chmod 600 "${rollback}"; fi`,
    integrityCheck,
    'tar -xzf "$HOME/.grokbox/bootstrap/package.tgz" --strip-components=1 -C "$HOME/.grokbox/runtime"',
    'chmod 755 "$HOME/.grokbox/runtime/bin/grokbox"',
    remoteFilesystemPolicyMergeCommand(),
    'install -m 600 "$HOME/.grokbox/bootstrap/daemon-config.json" "$HOME/.grokbox/daemon/config.json"',
    'pidfile="$HOME/.grokbox/daemon/daemon.pid"',
    `if [ -f "$pidfile" ]; then pid="$(cat "$pidfile" 2>/dev/null || true)"; case "$pid" in *[!0-9]*|"") ;; *) if kill -0 "$pid" 2>/dev/null; then status="$("$binary" daemon status 2>/dev/null || true)"; observed="$(printf "%s" "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)?.data?.daemonPid;if(Number.isSafeInteger(v))process.stdout.write(String(v))}catch{}})")"; [ "$observed" = "$pid" ] || exit 3; kill "$pid" 2>/dev/null || true; fi ;; esac; fi`,
    'i=0; while [ -S "$HOME/.grokbox/run/daemon.sock" ] && [ "$i" -lt 20 ]; do i=$((i+1)); sleep 0.1; done',
    `nohup ${binary} daemon serve >"$HOME/.grokbox/daemon/daemon.log" 2>&1 </dev/null & daemon_pid=$!; printf "%s\\n" "$daemon_pid" >"$pidfile"`,
    'i=0; while [ ! -S "$HOME/.grokbox/run/daemon.sock" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done',
    '[ -S "$HOME/.grokbox/run/daemon.sock" ]',
  ].join("; ");
}

export function remotePrepareRollbackCommand(rollbackId: string): string {
  const rollback = `$HOME/.grokbox/daemon/config.rollback-${rollbackId}.json`;
  return [
    "set -eu",
    'mkdir -p "$HOME/.grokbox/daemon"',
    'chmod 700 "$HOME/.grokbox" "$HOME/.grokbox/daemon"',
    `if [ -f "$HOME/.grokbox/daemon/config.json" ]; then cp "$HOME/.grokbox/daemon/config.json" "${rollback}"; chmod 600 "${rollback}"; fi`,
  ].join("; ");
}

export function remoteRollbackCommand(rollbackId: string): string {
  const binary = "$HOME/.grokbox/runtime/bin/grokbox";
  const rollback = `$HOME/.grokbox/daemon/config.rollback-${rollbackId}.json`;
  return [
    "set -eu",
    `binary=${JSON.stringify(binary)}`,
    'pidfile="$HOME/.grokbox/daemon/daemon.pid"',
    `if [ -f "$pidfile" ]; then pid="$(cat "$pidfile" 2>/dev/null || true)"; case "$pid" in *[!0-9]*|"") ;; *) if kill -0 "$pid" 2>/dev/null; then status="$("$binary" daemon status 2>/dev/null || true)"; observed="$(printf "%s" "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)?.data?.daemonPid;if(Number.isSafeInteger(v))process.stdout.write(String(v))}catch{}})")"; [ "$observed" = "$pid" ] || exit 3; kill "$pid" 2>/dev/null || true; fi ;; esac; fi`,
    'i=0; while [ -S "$HOME/.grokbox/run/daemon.sock" ] && [ "$i" -lt 20 ]; do i=$((i+1)); sleep 0.1; done',
    '[ ! -S "$HOME/.grokbox/run/daemon.sock" ]',
    `if [ -f "${rollback}" ]; then install -m 600 "${rollback}" "$HOME/.grokbox/daemon/config.json"; nohup ${binary} daemon serve >"$HOME/.grokbox/daemon/daemon.log" 2>&1 </dev/null & daemon_pid=$!; printf "%s\\n" "$daemon_pid" >"$pidfile"; i=0; while [ ! -S "$HOME/.grokbox/run/daemon.sock" ] && kill -0 "$daemon_pid" 2>/dev/null && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done; kill -0 "$daemon_pid" 2>/dev/null; cmd="$(ps -p "$daemon_pid" -o command= 2>/dev/null || true)"; case "$cmd" in *grokbox*daemon*serve*) ;; *) exit 1 ;; esac; [ "$(cat "$pidfile")" = "$daemon_pid" ]; [ -S "$HOME/.grokbox/run/daemon.sock" ]; ${binary} daemon status >/dev/null; else mv "$HOME/.grokbox/daemon/config.json" "$HOME/.grokbox/daemon/config.failed-${rollbackId}.json" 2>/dev/null || true; fi`,
  ].join("; ");
}

export async function checkBatchModeSsh(
  deps: CliDeps,
  host: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  assertSshHost(host);
  const result = await deps.runCommand(sshArgv(host, "true"), { timeoutMs, signal: deps.signal });
  return result.code === 0;
}

export async function inspectPeerThroughSsh(deps: CliDeps, host: string): Promise<BootstrapPeer | null> {
  assertSshHost(host);
  if (!(await checkBatchModeSsh(deps, host))) return null;
  const result = await deps.runCommand(sshArgv(host, "tailscale status --json"));
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.Self)) return null;
  const dnsName = typeof parsed.Self.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : "";
  const name = typeof parsed.Self.HostName === "string" ? parsed.Self.HostName : dnsName.split(".")[0] ?? host;
  const ips = Array.isArray(parsed.Self.TailscaleIPs) ? parsed.Self.TailscaleIPs : [];
  const ipv4 = ips.find((value): value is string => typeof value === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(value)) ?? null;
  return dnsName ? { name, dnsName, ipv4 } : null;
}

async function bootstrapPeerDaemonOperation(
  deps: CliDeps,
  profileName: string,
  peer: BootstrapPeer,
  sshHost: string,
  operationId: string,
  options: { admitHomeRead?: boolean } = {},
): Promise<BootstrapResult> {
  assertSshHost(sshHost);
  if (!peer.dnsName) throw commandFailure("tailscale_not_ready", "The selected peer has no MagicDNS name.");
  if (!(await checkBatchModeSsh(deps, sshHost))) {
    throw commandFailure("bootstrap_unavailable", "Passwordless BatchMode SSH is unavailable for the selected peer.");
  }
  await requireSuccess(
    deps,
    sshArgv(sshHost, "node -e \"process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)\""),
    "bootstrap_unavailable",
    "The peer requires Node.js 20 or newer.",
  );

  let remoteHome: string | undefined;
  if (options.admitHomeRead) {
    const remoteHomeResult = await requireSuccess(
      deps,
      sshArgv(sshHost, "node -p \"require('node:os').homedir()\""),
      "bootstrap_unavailable",
      "Unable to resolve the peer home directory for filesystem policy.",
    );
    remoteHome = remoteHomeResult.stdout.trim();
    if (!isAbsolute(remoteHome) || remoteHome.includes("\0") || remoteHome.includes("\n")) {
      throw commandFailure("bootstrap_unavailable", "The peer returned an invalid home directory.");
    }
  }

  const servePort = await inspectServePort(deps, sshHost, peer.dnsName);
  const mappingRecorded = servePort.inUse && await existingMappingIsOurs(deps, sshHost, peer.dnsName);
  const mappingOwned = mappingRecorded && servePort.exact;
  if (servePort.inUse && !mappingOwned) {
    throw commandFailure("bootstrap_unavailable", `Tailscale Serve HTTPS port ${SERVE_HTTPS_PORT} is already owned by another mapping.`);
  }

  const token = `gbox_${deps.randomUUID().replaceAll("-", "")}${deps.randomUUID().replaceAll("-", "")}`;
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const secretPath = join(
    deps.configDir,
    "secrets",
    `${profileName}-daemon-token-${tokenSha256.slice(0, 12)}`,
  );
  const proxyUrl = `http://127.0.0.1:${DAEMON_PORT}`;
  const serverUrl = `https://${peer.dnsName}:${SERVE_HTTPS_PORT}`;
  const config: DaemonConfig = {
    version: 1,
    network: { host: "127.0.0.1", port: DAEMON_PORT, tokenSha256 },
    serve: { httpsPort: SERVE_HTTPS_PORT, dnsName: peer.dnsName, proxyUrl },
    ...(options.admitHomeRead
      ? {
          filesystem: {
            roots: [{
              name: "home",
              path: remoteHome!,
              operations: ["stat", "list", "read", "download"] as const,
            }],
          },
        }
      : {}),
  };
  const temporary = await bootstrapFixtureDirectory(deps);
  const rollbackId = tokenSha256.slice(0, 12);
  let daemonMutationAttempted = false;
  let serveMutationAttempted = false;
  try {
    await writeProtectedSecret(secretPath, token);
    const packagePath = await packRuntime(deps, temporary);
    const packageSha256 = createHash("sha256").update(await readFile(packagePath)).digest("hex");
    const configPath = join(temporary, "daemon-config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await requireSuccess(
      deps,
      sshArgv(sshHost, 'mkdir -p "$HOME/.grokbox/bootstrap" && chmod 700 "$HOME/.grokbox/bootstrap"'),
      "bootstrap_unavailable",
      "Unable to prepare the peer bootstrap directory.",
    );
    await requireSuccess(
      deps,
      ["scp", ...SSH_OPTIONS, packagePath, `${sshHost}:.grokbox/bootstrap/package.tgz`],
      "bootstrap_unavailable",
      "Unable to transfer the grokbox runtime to the peer.",
    );
    await requireSuccess(
      deps,
      ["scp", ...SSH_OPTIONS, configPath, `${sshHost}:.grokbox/bootstrap/daemon-config.json`],
      "bootstrap_unavailable",
      "Unable to transfer the daemon configuration to the peer.",
    );
    await requireSuccess(
      deps,
      sshArgv(sshHost, remotePackageIntegrityCommand(packageSha256)),
      "bootstrap_unavailable",
      "The transferred grokbox runtime package failed SHA-256 verification.",
    );
    await requireSuccess(
      deps,
      sshArgv(sshHost, remotePrepareRollbackCommand(rollbackId)),
      "bootstrap_unavailable",
      "Unable to stage the previous daemon configuration for rollback.",
    );
    daemonMutationAttempted = true;
    await requireSuccess(
      deps,
      sshArgv(sshHost, remoteInstallCommand(rollbackId, packageSha256)),
      "bootstrap_unavailable",
      "The peer daemon did not start successfully.",
    );
    serveMutationAttempted = true;
    const serveResult = await deps.runCommand(
      sshArgv(sshHost, `sudo -n tailscale serve --bg --yes --https=${SERVE_HTTPS_PORT} ${proxyUrl}`),
    );
    const appliedServe = await inspectServePort(deps, sshHost, peer.dnsName);
    if (serveResult.code !== 0 || !appliedServe.exact) {
      throw new CliError("tailscale_not_ready", "Unable to apply and verify the private Tailscale Serve mapping.");
    }

    const handshake = await new RemoteDaemonClient(
      serverUrl,
      token,
      10_000,
      deps.fetch,
      deps.signal,
    ).handshake();
    if (!handshake.capabilities.includes("grok.health.read")) {
      throw new CliError("capability_unavailable", "The bootstrapped daemon lacks health capability.");
    }
    if (options.admitHomeRead) {
      const home = handshake.filesystemRoots.find((root) => root.name === "home");
      const required = ["stat", "list", "read", "download"] as const;
      if (!home || required.some((operation) => !home.operations.includes(operation))) {
        throw new CliError("capability_unavailable", "The bootstrapped daemon did not admit the requested home read policy.");
      }
    }

    return {
      profile: {
        version: 1,
        transport: "daemon",
        server_url: serverUrl,
        daemon_token_ref: `file:${secretPath}`,
        ssh_host: sshHost,
      },
      serverUrl,
      secretPath,
      daemonPort: DAEMON_PORT,
      serveHttpsPort: SERVE_HTTPS_PORT,
      operationId,
    };
  } catch (error) {
    const serveRestored = !serveMutationAttempted || await restoreServeState(
      deps,
      sshHost,
      peer.dnsName,
      servePort,
    );
    const daemonRollback = !daemonMutationAttempted
      ? { code: 0 }
      : await deps.runCommand(sshArgv(sshHost, remoteRollbackCommand(rollbackId)));
    await writeProtectedSecret(secretPath, "revoked");
    if (!serveRestored || daemonRollback.code !== 0) {
      throw new CliError(
        "bootstrap_unavailable",
        "Bootstrap failed and rollback could not restore the previous daemon/Serve state.",
      );
    }
    throw error;
  }
}

export async function bootstrapPeerDaemon(
  deps: CliDeps,
  profileName: string,
  peer: BootstrapPeer,
  sshHost: string,
  options: { admitHomeRead?: boolean } = {},
): Promise<BootstrapResult> {
  const operationId = deps.randomUUID();
  try {
    return await bootstrapPeerDaemonOperation(
      deps,
      profileName,
      peer,
      sshHost,
      operationId,
      options,
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(error.code, error.message, {
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.failureCode === undefined ? {} : { failureCode: error.failureCode }),
      retryable: error.retryable,
      context: { operationId, phase: "bootstrap" },
    });
  }
}

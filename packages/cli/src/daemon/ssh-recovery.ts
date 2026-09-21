import { assertSshHost } from "../config/profile.ts";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";

const ssh = (host: string, command: string) => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command];

/** Bounded recovery of the existing installation. No package transfer, secret
 * rotation, service replacement, network discovery or proxy configuration. */
export function remoteEnsureInstalledDaemonCommand(): string {
  return [
    "set -eu",
    'binary="$HOME/.grokbox/runtime/bin/grokbox"',
    'config="$HOME/.grokbox/config.json"',
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
export async function ensureInstalledDaemonThroughSsh(deps: CliDeps, host: string, timeoutMs = 20_000): Promise<{ changed: boolean }> {
  assertSshHost(host);
  const result = await deps.runCommand(ssh(host, remoteEnsureInstalledDaemonCommand()), { timeoutMs, signal: deps.signal });
  if (result.code !== 0) throw new CliError("recover_unavailable", result.code === 3
    ? "An installed daemon process is present but unhealthy; inspect the installation before replacing it."
    : "The installed daemon could not be verified or started. Repair the installation inside the Box.",
    { failureCode: result.code === 3 ? "daemon_process_unhealthy" : "daemon_install_required" });
  const outcome = result.stdout.trim().split(/\r?\n/).at(-1);
  if (outcome !== "changed" && outcome !== "unchanged") throw new CliError("recover_failed", "The SSH daemon ensure adapter returned an invalid outcome.", { failureCode: "daemon_ensure_invalid" });
  return { changed: outcome === "changed" };
}
export async function checkBatchModeSsh(deps: CliDeps, host: string, timeoutMs = 10_000): Promise<boolean> {
  assertSshHost(host);
  const result = await deps.runCommand(ssh(host, "true"), { timeoutMs, signal: deps.signal });
  return result.code === 0;
}

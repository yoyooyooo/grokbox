import { ensureInstalledDaemonThroughSsh } from "../daemon/ssh-recovery.ts";
import { resolveDaemonCredential } from "../config/secret.ts";
import type { CliDeps } from "../deps.ts";
import { LocalDaemonClient, RemoteDaemonClient } from "../daemon/client.ts";
import { readDaemonConfig } from "../daemon/config.ts";
import { startDaemonHost } from "../daemon/host.ts";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";

/** Ensure is not installation, credential rotation or network provisioning. */
export async function runDaemonEnsure(deps: CliDeps, raw: { json?: boolean; timeoutMs?: string }): Promise<void> {
  const io = ioFromOpts(raw);
  const token = deps.daemonServerUrl ? deps.daemonToken ?? await resolveDaemonCredential(deps, deps.daemonTokenRef) : undefined;
  const client = deps.daemonServerUrl
    ? new RemoteDaemonClient(deps.daemonServerUrl, token!, io.timeoutMs, deps.fetch, deps.signal)
    : new LocalDaemonClient(deps.daemonSocket, io.timeoutMs, deps.signal);
  try {
    const handshake = await client.handshake();
    writeSuccess(deps.stdout, { ensured: true, changed: false, ...handshake });
    return;
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "daemon_unreachable" || !deps.daemonServerUrl || !deps.sshHost || deps.signal?.aborted) throw error;
  }
  const operationId = deps.randomUUID();
  let ensured: Awaited<ReturnType<typeof ensureInstalledDaemonThroughSsh>>;
  try { ensured = await ensureInstalledDaemonThroughSsh(deps, deps.sshHost, io.timeoutMs); }
  catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (deps.signal?.aborted) throw new CliError("daemon_unreachable", error.message, { retryable: true });
    throw new CliError(error.code, error.message, {
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.failureCode === undefined ? {} : { failureCode: error.failureCode }), retryable: error.retryable,
      context: { operationId, phase: "daemon-ensure" },
    });
  }
  const handshake = await client.handshake();
  writeSuccess(deps.stdout, { ensured: true, changed: ensured.changed, operationId,
    audit: { action: "daemon-ensure-installed", outcome: ensured.changed ? "started" : "already-running", credential: "not-recorded" }, ...handshake });
}

export async function runDaemonStatus(deps: CliDeps, raw: { json?: boolean; timeoutMs?: string }): Promise<void> {
  const io = ioFromOpts(raw);
  const token = deps.daemonServerUrl ? deps.daemonToken ?? await resolveDaemonCredential(deps, deps.daemonTokenRef) : undefined;
  const client = deps.daemonServerUrl
    ? new RemoteDaemonClient(deps.daemonServerUrl, token!, io.timeoutMs, deps.fetch, deps.signal)
    : new LocalDaemonClient(deps.daemonSocket, io.timeoutMs, deps.signal);
  const handshake = await client.handshake();
  writeSuccess(deps.stdout, { transport: deps.daemonServerUrl ? "https" : "unix", endpoint: deps.daemonServerUrl ?? deps.daemonSocket,
    ...(deps.daemonServerUrl ? {} : { socket: deps.daemonSocket }), ...handshake });
}

export async function runDaemonServe(deps: CliDeps, raw: { json?: boolean; socket?: string }): Promise<void> {
  const socketPath = raw.socket ?? deps.daemonSocket, config = await readDaemonConfig(deps.configDir);
  const host = await startDaemonHost(deps, socketPath, config.network);
  try {
    const handshake = await host.handshake();
    writeSuccess(deps.stdout, { socket: socketPath, network: host.network, ready: true, ...handshake });
    await new Promise<void>(resolve => {
      if (deps.signal) {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener("abort", () => resolve(), { once: true });
        return;
      }
      const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  } finally { await host.close(); }
}

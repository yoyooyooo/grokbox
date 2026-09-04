import {
  bootstrapPeerDaemon,
  ensureInstalledDaemonThroughSsh,
  inspectPeerThroughSsh,
} from "../bootstrap.ts";
import { writeProfileFile } from "../config/profile.ts";
import { resolveDaemonCredential, retireOwnedFileSecret } from "../config/secret.ts";
import type { CliDeps } from "../deps.ts";
import { LocalDaemonClient, RemoteDaemonClient } from "../daemon/client.ts";
import { readDaemonConfig } from "../daemon/config.ts";
import { startDaemonHost } from "../daemon/host.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";

export async function runDaemonEnsure(
  deps: CliDeps,
  raw: {
    json?: boolean;
    timeoutMs?: string;
    bootstrap?: boolean;
    admitHomeRead?: boolean;
    yes?: boolean;
  },
): Promise<void> {
  const io = ioFromOpts(raw);
  if (raw.yes && !raw.bootstrap) throw usage("--yes is only valid with --bootstrap.");
  if (raw.admitHomeRead && !raw.bootstrap) {
    throw usage("--admit-home-read is only valid with --bootstrap.");
  }
  if (!raw.bootstrap) {
    const token = deps.daemonServerUrl
      ? deps.daemonToken ?? await resolveDaemonCredential(deps, deps.daemonTokenRef)
      : undefined;
    const client = deps.daemonServerUrl
      ? new RemoteDaemonClient(deps.daemonServerUrl, token!, io.timeoutMs, deps.fetch, deps.signal)
      : new LocalDaemonClient(deps.daemonSocket, io.timeoutMs, deps.signal);
    try {
      const handshake = await client.handshake();
      writeSuccess(deps.stdout, { ensured: true, changed: false, ...handshake });
      return;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "daemon_unreachable" ||
        !deps.daemonServerUrl || !deps.sshHost) throw error;
    }
    const operationId = deps.randomUUID();
    let ensured: Awaited<ReturnType<typeof ensureInstalledDaemonThroughSsh>>;
    try {
      ensured = await ensureInstalledDaemonThroughSsh(deps, deps.sshHost, io.timeoutMs);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      throw new CliError(error.code, error.message, {
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        ...(error.failureCode === undefined ? {} : { failureCode: error.failureCode }),
        retryable: error.retryable,
        context: { operationId, phase: "daemon-ensure" },
      });
    }
    const handshake = await client.handshake();
    writeSuccess(deps.stdout, {
      ensured: true,
      changed: ensured.changed,
      operationId,
      audit: {
        action: "daemon-ensure-installed",
        outcome: ensured.changed ? "started" : "already-running",
        credential: "not-recorded",
      },
      ...handshake,
    });
    return;
  }
  if (!deps.stdinIsTTY && !raw.yes) throw usage("Headless bootstrap requires --bootstrap --yes.");
  if (!deps.profileName || !deps.sshHost || !deps.daemonServerUrl) {
    throw new CliError(
      "bootstrap_unavailable",
      "Bootstrap ensure requires a remote Profile with server_url and ssh_host; run grokbox init <name> --peer <peer> --bootstrap --yes.",
    );
  }
  if (deps.stdinIsTTY && !raw.yes) {
    const action = raw.admitHomeRead
      ? `Bootstrap or rotate ${deps.profileName} and admit read/download access to its home root? [y/N] `
      : `Bootstrap or rotate the private grokbox daemon for ${deps.profileName}? [y/N] `;
    const confirmed = await deps.confirm(action);
    if (!confirmed) throw usage("Bootstrap was not confirmed.");
  }
  const peer = await inspectPeerThroughSsh(deps, deps.sshHost);
  if (!peer) throw new CliError("bootstrap_unavailable", "The Profile peer is unavailable through BatchMode SSH.");
  if (new URL(deps.daemonServerUrl).hostname !== peer.dnsName) {
    throw new CliError("profile_invalid", "The Profile endpoint and SSH peer resolve to different tailnet nodes.");
  }
  const result = await bootstrapPeerDaemon(
    deps,
    deps.profileName,
    peer,
    deps.sshHost,
    { admitHomeRead: raw.admitHomeRead === true },
  );
  await writeProfileFile(deps.configDir, deps.profileName, result.profile);
  await retireOwnedFileSecret(deps.configDir, deps.daemonTokenRef, result.profile.daemon_token_ref);
  writeSuccess(deps.stdout, {
    ensured: true,
    changed: true,
    operationId: result.operationId,
    profile: deps.profileName,
    endpoint: result.serverUrl,
    credential: "rotated-and-stored-by-reference",
    filesystemPolicy: raw.admitHomeRead ? "home-read-explicitly-admitted" : "existing-policy-preserved",
    audit: {
      action: "daemon-bootstrap",
      outcome: "installed-and-verified",
      operationId: result.operationId,
      credential: "stored-by-reference",
      serve: "exact-private-mapping",
    },
  });
}

export async function runDaemonStatus(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const token = deps.daemonServerUrl
    ? deps.daemonToken ?? await resolveDaemonCredential(deps, deps.daemonTokenRef)
    : undefined;
  const client = deps.daemonServerUrl
    ? new RemoteDaemonClient(deps.daemonServerUrl, token!, io.timeoutMs, deps.fetch, deps.signal)
    : new LocalDaemonClient(deps.daemonSocket, io.timeoutMs, deps.signal);
  const handshake = await client.handshake();
  writeSuccess(deps.stdout, {
    transport: deps.daemonServerUrl ? "https" : "unix",
    endpoint: deps.daemonServerUrl ?? deps.daemonSocket,
    ...(deps.daemonServerUrl ? {} : { socket: deps.daemonSocket }),
    ...handshake,
  });
}

export async function runDaemonServe(
  deps: CliDeps,
  raw: { json?: boolean; socket?: string },
): Promise<void> {
  const socketPath = raw.socket ?? deps.daemonSocket;
  const config = await readDaemonConfig(deps.configDir);
  const host = await startDaemonHost(
    deps,
    socketPath,
    config.network,
    config.filesystem?.roots ?? [],
    config.process,
    config.desktop,
  );
  try {
    const handshake = await host.handshake();
    writeSuccess(deps.stdout, {
      socket: socketPath,
      network: host.network,
      serve: config.serve
        ? { httpsPort: config.serve.httpsPort, dnsName: config.serve.dnsName, configured: true }
        : null,
      ready: true,
      ...handshake,
    });

    await new Promise<void>((resolve) => {
      if (deps.signal) {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener("abort", () => resolve(), { once: true });
        return;
      }
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await host.close();
  }
}

import {
  checkBatchModeSsh,
  ensureInstalledDaemonThroughSsh,
  ensureRecordedServeMapping,
} from "../bootstrap.ts";
import { resolveSecretRef } from "../config/secret.ts";
import type { CliDeps } from "../deps.ts";
import { diagnose, inspectTailnetPeer } from "../diagnostics.ts";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import {
  CursorSandboxCancelledError,
  CursorSandboxClient,
  CursorSandboxError,
} from "../sandbox/cursor.ts";

type RecoveryAction = {
  action: "sandbox-wake" | "tailnet-wait" | "serve-restore" | "daemon-ensure";
  changed: boolean;
  outcome: string;
};

function recoverError(
  operationId: string,
  message: string,
  failureCode: string,
  retryable = false,
): CliError {
  return new CliError("recover_failed", message, {
    failureCode,
    retryable,
    context: { operationId, phase: failureCode },
  });
}

function recoveryPhaseError(error: unknown, operationId: string, phase: string): CliError {
  if (error instanceof CliError) {
    return new CliError(error.code, error.message, {
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.failureCode === undefined ? {} : { failureCode: error.failureCode }),
      retryable: error.retryable,
      context: { operationId, phase },
    });
  }
  return recoverError(operationId, "The recovery adapter failed unexpectedly.", phase, true);
}

async function wakeSandbox(deps: CliDeps, timeoutMs: number, operationId: string): Promise<void> {
  if (!deps.sandboxAccessTokenRef) {
    throw new CliError(
      "recover_unavailable",
      "The unreachable Profile does not declare Sandbox wake authority.",
      { failureCode: "sandbox_wake_not_configured", context: { operationId, phase: "sandbox-wake" } },
    );
  }
  try {
    const accessToken = await resolveSecretRef(deps, deps.sandboxAccessTokenRef);
    await new CursorSandboxClient({
      accessToken,
      fetch: deps.fetch,
      timeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
      randomUUID: deps.randomUUID,
      now: deps.now,
    }).tick();
  } catch (error) {
    const failureCode = error instanceof CursorSandboxError
      ? error.kind
      : error instanceof CursorSandboxCancelledError
        ? "cancelled"
        : error instanceof CliError
          ? error.code
          : "provider_unavailable";
    throw recoverError(
      operationId,
      "The configured Cursor Sandbox could not be woken and verified.",
      `sandbox_${failureCode}`,
      error instanceof CursorSandboxError ? error.retryable : true,
    );
  }
}

async function waitForTailnet(
  deps: CliDeps,
  hostname: string,
  timeoutMs: number,
  operationId: string,
): Promise<void> {
  const probeTimeoutMs = Math.min(2_000, timeoutMs);
  const delayMs = Math.min(2_000, timeoutMs);
  const attempts = Math.max(
    1,
    Math.ceil(timeoutMs / Math.max(1, probeTimeoutMs + delayMs)),
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const peer = await inspectTailnetPeer(deps, hostname, probeTimeoutMs);
    if (peer.status.status === "pass" && peer.ipv4Present) return;
    if (attempt === attempts - 1 || !(await deps.wait(delayMs, deps.signal))) break;
  }
  throw recoverError(
    operationId,
    "The box did not regain tailnet reachability and an IPv4 assignment before the recovery deadline.",
    "tailnet_restore_timeout",
    true,
  );
}

export async function runRecover(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const operationId = deps.randomUUID();
  if (!deps.daemonServerUrl || !deps.sshHost || deps.transport === "local" || deps.transport === "gateway") {
    throw new CliError(
      "recover_unavailable",
      "Recover requires a remote daemon Profile with server_url and the declared ssh_host adapter.",
      { failureCode: "remote_recovery_not_configured", context: { operationId, phase: "preflight" } },
    );
  }
  const endpoint = new URL(deps.daemonServerUrl);
  const initial = await diagnose(deps, io.timeoutMs);
  if (initial.ok) {
    writeSuccess(deps.stdout, {
      recovered: true,
      changed: false,
      operationId,
      actions: [],
      doctor: initial,
    });
    return;
  }
  if (initial.checks.secretSession.status === "fail") {
    throw new CliError(
      "recover_unavailable",
      "Recovery requires the selected Profile credential references to resolve before mutation.",
      {
        failureCode: initial.checks.secretSession.code,
        context: { operationId, phase: "credential-preflight" },
      },
    );
  }
  if (initial.checks.daemonAuth.status === "fail" &&
    initial.checks.daemonAuth.code !== "daemon_unreachable") {
    throw new CliError(
      "recover_unavailable",
      "Recovery cannot replace credentials, protocol versions, or daemon policy; use confirmed bootstrap when appropriate.",
      {
        failureCode: initial.checks.daemonAuth.code,
        context: { operationId, phase: "daemon-authority-preflight" },
      },
    );
  }

  const actions: RecoveryAction[] = [];
  if (initial.checks.tailnet.status !== "pass") {
    await wakeSandbox(deps, io.timeoutMs, operationId);
    actions.push({ action: "sandbox-wake", changed: true, outcome: "brokered-noop-verified" });
  }
  await waitForTailnet(deps, endpoint.hostname, io.timeoutMs, operationId);
  actions.push({ action: "tailnet-wait", changed: false, outcome: "peer-and-ipv4-reachable" });

  if (!(await checkBatchModeSsh(deps, deps.sshHost, io.timeoutMs))) {
    throw new CliError(
      "recover_unavailable",
      "The declared BatchMode SSH recovery adapter is unavailable.",
      { failureCode: "ssh_recovery_unavailable", context: { operationId, phase: "ssh-preflight" } },
    );
  }

  let mapping: Awaited<ReturnType<typeof ensureRecordedServeMapping>>;
  try {
    mapping = await ensureRecordedServeMapping(deps, deps.sshHost, endpoint.hostname, io.timeoutMs);
  } catch (error) {
    throw recoveryPhaseError(error, operationId, "serve-restore");
  }
  actions.push({ action: "serve-restore", changed: mapping.changed, outcome: mapping.state });

  let daemon: Awaited<ReturnType<typeof ensureInstalledDaemonThroughSsh>>;
  try {
    daemon = await ensureInstalledDaemonThroughSsh(deps, deps.sshHost, io.timeoutMs);
  } catch (error) {
    throw recoveryPhaseError(error, operationId, "daemon-ensure");
  }
  actions.push({ action: "daemon-ensure", changed: daemon.changed, outcome: daemon.changed ? "started" : "already-running" });

  const final = await diagnose(deps, io.timeoutMs);
  if (!final.ok) {
    throw recoverError(
      operationId,
      "Recovery completed its bounded actions but the final read-only doctor remains unhealthy.",
      "post_recovery_doctor_failed",
      true,
    );
  }
  writeSuccess(deps.stdout, {
    recovered: true,
    changed: actions.some((action) => action.changed),
    operationId,
    actions,
    doctor: final,
  }, final.discovery ? { pid: final.discovery.pid, startedAt: final.discovery.startedAt } : undefined);
}

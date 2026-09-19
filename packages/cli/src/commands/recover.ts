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
    if (
      error instanceof CliError &&
      (error.code === "credential_unavailable" || error.code === "credential_locked" || error.code === "credential_invalid")
    ) {
      throw new CliError(
        "recover_unavailable",
        "Recovery requires the selected Profile credential references to resolve before mutation.",
        {
          failureCode: error.code,
          retryable: false,
          context: { operationId, phase: "sandbox-wake" },
        },
      );
    }
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

async function waitForSsh(deps: CliDeps, host: string, timeoutMs: number): Promise<boolean> {
  const probeMs = Math.min(2_000, timeoutMs);
  const attempts = Math.max(1, Math.ceil(timeoutMs / (probeMs * 2)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkBatchModeSsh(deps, host, probeMs)) return true;
    if (attempt === attempts - 1 || !(await deps.wait(probeMs, deps.signal))) break;
  }
  return false;
}

export async function runRecover(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string; legacyTailnet?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const operationId = deps.randomUUID();
  if (!deps.daemonServerUrl || deps.transport === "local" || deps.transport === "gateway") {
    throw new CliError(
      "recover_unavailable",
      "Recover requires a configured daemon endpoint; local runtime lifecycle remains Box-local.",
      { failureCode: "remote_recovery_not_configured", context: { operationId, phase: "preflight" } },
    );
  }
  const endpoint = new URL(deps.daemonServerUrl);
  const initial = await diagnose(deps, io.timeoutMs);
  if (initial.ok && !raw.legacyTailnet) {
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

  if (initial.checks.capabilities.status === "fail" || initial.checks.daemonHttp.code === "daemon_listener_mismatch") {
    const failureCode = initial.checks.capabilities.status === "fail"
      ? initial.checks.capabilities.code : initial.checks.daemonHttp.code;
    throw new CliError("recover_unavailable", "Repair the configured endpoint or application policy; recovery does not replace either.", {
      failureCode, context: { operationId, phase: "daemon-authority-preflight" },
    });
  }
  if (!deps.sshHost) {
    throw new CliError("recover_unavailable", "The endpoint is unhealthy and no SSH recovery adapter is configured. Repair the operator-managed network or start the installed daemon inside the Box.", {
      failureCode: "remote_recovery_not_configured", context: { operationId, phase: "preflight" },
    });
  }

  const actions: RecoveryAction[] = [];
  // A connection failure (or missing networking tool) is not evidence of sleep.
  // Only the configured control plane can establish a wake candidate.
  const asleep = initial.checks.sandbox.status === "pass" &&
    (initial.checks.sandbox.state === "hibernated" || initial.checks.sandbox.state === "absent");
  if (initial.checks.daemonHttp.code === "daemon_endpoint_unreachable" && asleep) {
    await wakeSandbox(deps, io.timeoutMs, operationId);
    actions.push({ action: "sandbox-wake", changed: true, outcome: "brokered-noop-verified" });
  }
  // Frozen compatibility path only: never infer it from an address or sshHost.
  if (raw.legacyTailnet) {
    await waitForTailnet(deps, endpoint.hostname, io.timeoutMs, operationId);
    actions.push({ action: "tailnet-wait", changed: false, outcome: "peer-and-ipv4-reachable" });
  }

  if (!(await waitForSsh(deps, deps.sshHost, io.timeoutMs))) {
    const sandboxCredentialFailed = initial.checks.sandbox.status === "fail" &&
      ["credential_unavailable", "credential_locked", "credential_invalid"].includes(initial.checks.sandbox.code);
    throw new CliError(
      "recover_unavailable",
      "The declared SSH recovery adapter is unavailable. Repair network access; wake requires verified Sandbox state and credentials.",
      { failureCode: sandboxCredentialFailed ? initial.checks.sandbox.code : "ssh_recovery_unavailable", context: { operationId, phase: "ssh-preflight" } },
    );
  }

  if (raw.legacyTailnet) {
    let mapping: Awaited<ReturnType<typeof ensureRecordedServeMapping>>;
    try {
      mapping = await ensureRecordedServeMapping(deps, deps.sshHost, endpoint.hostname, io.timeoutMs);
    } catch (error) {
      throw recoveryPhaseError(error, operationId, "serve-restore");
    }
    actions.push({ action: "serve-restore", changed: mapping.changed, outcome: mapping.state });
  }

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

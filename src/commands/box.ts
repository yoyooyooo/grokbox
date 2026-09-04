import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSecretRef } from "../config/secret.ts";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { writeJsonLine, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import {
  CursorSandboxCancelledError,
  CursorSandboxClient,
  CursorSandboxError,
  type SandboxFailureKind,
} from "../sandbox/cursor.ts";
import { isRecord, parseInteger } from "../util.ts";

const DEFAULT_KEEPALIVE_INTERVAL_MS = 600_000;
const MAX_KEEPALIVE_INTERVAL_MS = 86_400_000;
const MAX_TICK_ATTEMPTS = 3;
const JITTER_RATIO = 0.1;
const FAILURE_BASE_BACKOFF_MS = 60_000;
const FAILURE_MAX_BACKOFF_MS = 30 * 60_000;
const TERMINAL_FAILURE_COOLDOWN_MS = 15 * 60_000;

type KeeperFailure = SandboxFailureKind | "credential_unavailable";
type KeeperState = {
  version: 1;
  profile: string;
  status: "starting" | "healthy" | "degraded" | "stopped";
  running: boolean;
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
  lastTickAtMs: number | null;
  nextTickAtMs: number | null;
  tickCount: number;
  consecutiveFailures: number;
  lastFailure: KeeperFailure | null;
  descriptorRotated: boolean | null;
};

type LockRecord = { version: 1; pid: number; nonce: string; startedAtMs: number };

type BoxOptions = { json?: boolean; table?: boolean; timeoutMs?: string };
type KeepaliveRunOptions = BoxOptions & { intervalMs?: string };

function sandboxTokenRef(deps: CliDeps): string {
  if (!deps.sandboxAccessTokenRef) {
    throw new CliError(
      "capability_unavailable",
      "The selected Profile does not declare sandbox.access_token_ref.",
    );
  }
  return deps.sandboxAccessTokenRef;
}

async function sandboxClient(
  deps: CliDeps,
  timeoutMs: number,
  machineId?: string,
): Promise<CursorSandboxClient> {
  const accessToken = await resolveSecretRef(deps, sandboxTokenRef(deps));
  return new CursorSandboxClient({
    accessToken,
    fetch: deps.fetch,
    timeoutMs,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(machineId ? { machineId } : {}),
    randomUUID: deps.randomUUID,
    now: deps.now,
  });
}

function publicSandboxError(error: unknown, wake: boolean): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof CursorSandboxCancelledError) {
    return new CliError(
      wake ? "sandbox_wake_failed" : "sandbox_unavailable",
      wake ? "The Cursor Sandbox wake was cancelled." : "The Cursor Sandbox status request was cancelled.",
      { failureCode: "cancelled", retryable: true },
    );
  }
  const kind = error instanceof CursorSandboxError ? error.kind : "provider_unavailable";
  const retryable = error instanceof CursorSandboxError ? error.retryable : true;
  return new CliError(
    wake ? "sandbox_wake_failed" : "sandbox_unavailable",
    wake ? "The Cursor Sandbox could not be woken and verified." : "The Cursor Sandbox status is unavailable.",
    { failureCode: kind, retryable },
  );
}

function keeperRoot(deps: CliDeps): string {
  return join(deps.configDir, "run", "keepers", deps.profileName ?? "default");
}

function keeperStatePath(deps: CliDeps): string {
  return join(keeperRoot(deps), "state.json");
}

function keeperLockPath(deps: CliDeps): string {
  return join(keeperRoot(deps), "keeper.lock");
}

async function atomicJson(path: string, value: unknown, nonce: string): Promise<void> {
  const root = dirname(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const temp = join(root, `.state.${nonce}.tmp`);
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function persistKeeperState(deps: CliDeps, state: KeeperState): Promise<void> {
  try {
    await atomicJson(keeperStatePath(deps), state, deps.randomUUID());
  } catch {
    throw new CliError(
      "sandbox_keepalive_degraded",
      "The keeper state could not be persisted.",
      { failureCode: "state_persistence_failed", retryable: true },
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.version !== 1 || typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) || typeof value.nonce !== "string" ||
      typeof value.startedAtMs !== "number" || !Number.isSafeInteger(value.startedAtMs)) return null;
    return value as LockRecord;
  } catch {
    return null;
  }
}

async function acquireKeeperLock(deps: CliDeps): Promise<LockRecord> {
  const path = keeperLockPath(deps);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      nonce: deps.randomUUID(),
      startedAtMs: deps.now(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
      } finally {
        await handle.close();
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLock(path);
      if (existing && processIsAlive(existing.pid)) {
        throw new CliError(
          "sandbox_keepalive_degraded",
          "A keeper is already running for the selected Profile.",
          { failureCode: "already_running", retryable: false },
        );
      }
      if (attempt > 0) break;
      const stale = `${path}.stale.${record.nonce}`;
      try {
        await rename(path, stale);
        await unlink(stale);
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
    }
  }
  throw new CliError(
    "sandbox_keepalive_degraded",
    "The keeper lock could not be acquired.",
    { failureCode: "lock_unavailable", retryable: true },
  );
}

async function releaseKeeperLock(deps: CliDeps, owned: LockRecord): Promise<void> {
  const path = keeperLockPath(deps);
  const current = await readLock(path);
  if (!current || current.nonce !== owned.nonce || current.pid !== owned.pid) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function jitteredInterval(intervalMs: number, randomUUID: () => string): number {
  const sample = Number.parseInt(randomUUID().replaceAll("-", "").slice(-8), 16) / 0xffffffff;
  const factor = 1 - JITTER_RATIO + sample * JITTER_RATIO * 2;
  return Math.max(1000, Math.round(intervalMs * factor));
}

function failureDelay(
  intervalMs: number,
  failure: KeeperFailure,
  consecutiveFailures: number,
  retryAfterMs?: number,
): number {
  if (failure === "rate_limited") {
    return Math.max(intervalMs, retryAfterMs ?? FAILURE_BASE_BACKOFF_MS);
  }
  if (failure === "provider_unavailable" || failure === "request_timeout") {
    const backoff = Math.min(
      FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, consecutiveFailures - 1),
      FAILURE_MAX_BACKOFF_MS,
    );
    return Math.max(intervalMs, backoff);
  }
  return Math.max(intervalMs, TERMINAL_FAILURE_COOLDOWN_MS);
}

type KeeperTickResult =
  | { ok: true; descriptorRotated: boolean }
  | { ok: false; failure: KeeperFailure; retryAfterMs?: number }
  | { cancelled: true };

async function performKeeperTick(
  deps: CliDeps,
  timeoutMs: number,
  machineId: string,
): Promise<KeeperTickResult> {
  for (let attempt = 0; attempt < MAX_TICK_ATTEMPTS; attempt += 1) {
    try {
      const result = await (await sandboxClient(deps, timeoutMs, machineId)).tick();
      return { ok: true, descriptorRotated: result.descriptorRotated };
    } catch (error) {
      if (error instanceof CursorSandboxCancelledError || deps.signal?.aborted) return { cancelled: true };
      if (error instanceof CliError) return { ok: false, failure: "credential_unavailable" };
      const provider = error instanceof CursorSandboxError
        ? error
        : new CursorSandboxError("provider_unavailable", true);
      if (provider.kind === "rate_limited") {
        return {
          ok: false,
          failure: provider.kind,
          ...(provider.retryAfterMs === undefined ? {} : { retryAfterMs: provider.retryAfterMs }),
        };
      }
      if (!provider.retryable || attempt === MAX_TICK_ATTEMPTS - 1) {
        return {
          ok: false,
          failure: provider.kind,
          ...(provider.retryAfterMs === undefined ? {} : { retryAfterMs: provider.retryAfterMs }),
        };
      }
      const backoff = provider.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 30_000);
      if (!(await deps.wait(backoff, deps.signal))) return { cancelled: true };
    }
  }
  return { ok: false, failure: "provider_unavailable" };
}

const KEEPER_FAILURES = new Set<KeeperFailure>([
  "credential_unavailable",
  "unauthorized",
  "rate_limited",
  "provider_refused",
  "provider_unavailable",
  "request_timeout",
  "protocol_invalid",
  "exec_failed",
  "exec_outcome_unknown",
]);
const KEEPER_STATE_KEYS = new Set([
  "version",
  "profile",
  "status",
  "running",
  "pid",
  "startedAtMs",
  "updatedAtMs",
  "lastTickAtMs",
  "nextTickAtMs",
  "tickCount",
  "consecutiveFailures",
  "lastFailure",
  "descriptorRotated",
]);

function safeIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function validateKeeperState(value: unknown): KeeperState | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !KEEPER_STATE_KEYS.has(key)) ||
    value.version !== 1 || typeof value.profile !== "string" ||
    !["starting", "healthy", "degraded", "stopped"].includes(String(value.status)) ||
    typeof value.running !== "boolean" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) ||
    typeof value.startedAtMs !== "number" || !Number.isSafeInteger(value.startedAtMs) ||
    typeof value.updatedAtMs !== "number" || !Number.isSafeInteger(value.updatedAtMs) ||
    !safeIntegerOrNull(value.lastTickAtMs) || !safeIntegerOrNull(value.nextTickAtMs) ||
    typeof value.tickCount !== "number" || !Number.isSafeInteger(value.tickCount) || value.tickCount < 0 ||
    typeof value.consecutiveFailures !== "number" || !Number.isSafeInteger(value.consecutiveFailures) ||
    value.consecutiveFailures < 0 ||
    (value.lastFailure !== null && (typeof value.lastFailure !== "string" ||
      !KEEPER_FAILURES.has(value.lastFailure as KeeperFailure))) ||
    (value.descriptorRotated !== null && typeof value.descriptorRotated !== "boolean")) return null;
  return {
    version: 1,
    profile: value.profile,
    status: value.status as KeeperState["status"],
    running: value.running,
    pid: value.pid,
    startedAtMs: value.startedAtMs,
    updatedAtMs: value.updatedAtMs,
    lastTickAtMs: value.lastTickAtMs,
    nextTickAtMs: value.nextTickAtMs,
    tickCount: value.tickCount,
    consecutiveFailures: value.consecutiveFailures,
    lastFailure: value.lastFailure as KeeperFailure | null,
    descriptorRotated: value.descriptorRotated,
  };
}

async function readKeeperState(deps: CliDeps): Promise<KeeperState | null> {
  try {
    return validateKeeperState(JSON.parse(await readFile(keeperStatePath(deps), "utf8")));
  } catch {
    return null;
  }
}

export async function runBoxStatus(deps: CliDeps, raw: BoxOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("box status does not support --table.");
  try {
    const status = await (await sandboxClient(deps, io.timeoutMs)).status();
    writeSuccess(deps.stdout, {
      provider: "cursor",
      state: status.state,
      imageUpdateAvailable: status.imageUpdateAvailable,
      observedAtMs: deps.now(),
    });
  } catch (error) {
    throw publicSandboxError(error, false);
  }
}

export async function runBoxWake(deps: CliDeps, raw: BoxOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("box wake does not support --table.");
  try {
    const result = await (await sandboxClient(deps, io.timeoutMs)).tick();
    writeSuccess(deps.stdout, {
      provider: "cursor",
      woken: true,
      execVerified: true,
      descriptorRotated: result.descriptorRotated,
      observedAtMs: deps.now(),
    });
  } catch (error) {
    throw publicSandboxError(error, true);
  }
}

export async function runBoxKeepaliveStatus(deps: CliDeps, raw: BoxOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("box keepalive status does not support --table.");
  const state = await readKeeperState(deps);
  const lock = await readLock(keeperLockPath(deps));
  const running = Boolean(lock && processIsAlive(lock.pid));
  writeSuccess(deps.stdout, state
    ? { ...state, running, configured: Boolean(deps.sandboxAccessTokenRef) }
    : {
        version: 1,
        profile: deps.profileName ?? "default",
        status: "never_started",
        running,
        configured: Boolean(deps.sandboxAccessTokenRef),
      });
}

export async function runBoxKeepalive(
  deps: CliDeps,
  raw: KeepaliveRunOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("box keepalive run does not support --table.");
  sandboxTokenRef(deps);
  const intervalMs = parseInteger(raw.intervalMs ?? deps.sandboxKeepaliveIntervalMs, {
    name: "--interval-ms",
    min: 1000,
    max: MAX_KEEPALIVE_INTERVAL_MS,
    defaultValue: DEFAULT_KEEPALIVE_INTERVAL_MS,
  });
  const lock = await acquireKeeperLock(deps);
  const machineId = deps.randomUUID();
  let state: KeeperState = {
    version: 1,
    profile: deps.profileName ?? "default",
    status: "starting",
    running: true,
    pid: process.pid,
    startedAtMs: deps.now(),
    updatedAtMs: deps.now(),
    lastTickAtMs: null,
    nextTickAtMs: null,
    tickCount: 0,
    consecutiveFailures: 0,
    lastFailure: null,
    descriptorRotated: null,
  };
  try {
    await persistKeeperState(deps, state);
    while (!deps.signal?.aborted) {
      const result = await performKeeperTick(deps, io.timeoutMs, machineId);
      if ("cancelled" in result) break;
      const now = deps.now();
      const consecutiveFailures = result.ok ? 0 : state.consecutiveFailures + 1;
      const delay = result.ok
        ? jitteredInterval(intervalMs, deps.randomUUID)
        : failureDelay(intervalMs, result.failure, consecutiveFailures, result.retryAfterMs);
      state = {
        ...state,
        status: result.ok ? "healthy" : "degraded",
        running: true,
        updatedAtMs: now,
        lastTickAtMs: now,
        nextTickAtMs: deps.signal?.aborted ? null : now + delay,
        tickCount: state.tickCount + 1,
        consecutiveFailures,
        lastFailure: result.ok ? null : result.failure,
        descriptorRotated: result.ok ? result.descriptorRotated : null,
      };
      await persistKeeperState(deps, state);
      writeJsonLine(deps.stdout, { ok: true, data: state });
      if (deps.signal?.aborted || !(await deps.wait(delay, deps.signal))) break;
    }
  } finally {
    const stopped = {
      ...state,
      status: "stopped" as const,
      running: false,
      updatedAtMs: deps.now(),
      nextTickAtMs: null,
    };
    try {
      await persistKeeperState(deps, stopped);
    } finally {
      await releaseKeeperLock(deps, lock);
    }
    writeJsonLine(deps.stdout, { ok: true, data: stopped });
  }
}

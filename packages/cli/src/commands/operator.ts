import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoxRuntimeError, openRuntimeStore, projectLiveStatus } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { LocalDaemonClient } from "../daemon/client.ts";
import { readDaemonConfig, writeDaemonConfig } from "../daemon/config.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import {
  classifySourceMatch,
  hostSourcePorts,
  isFullSourceSha,
  overlaySourceMatch,
  profileWriteNext,
  shaPrefix,
} from "../host-source.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { agentKind, compactRosterRow } from "../redaction.ts";
import { applyHostDisable, applyHostEnable, ensureHostStartDesired } from "./runtime.ts";

const HOST_SWITCH_HINT = "Host switch kills Host and interrupts running bots.";
const HOST_START = "grokbox host start";

export type OperatorHost = "official" | "custom" | "unknown";
export type OperatorDaemon = "up" | "down";
export type RunningBot = { id: string; name: string };
export type HostLifecycleCommand = "start" | "stop" | "restart";
export type HostDesired = "custom" | "official";
export type HostOutcome = "started" | "already_started" | "stopped" | "already_stopped" | "restarted";

export type OperatorReport = {
  daemon: OperatorDaemon;
  titleSync: boolean;
  screenIdle: boolean;
  host: OperatorHost;
  hostReason: string | null;
  next: string;
  liveShaPrefix?: string;
  profileShaPrefix?: string;
  liveSourceSha?: string;
};

type HostClass = { host: OperatorHost; hostReason: string | null };
type SourceFacts = { liveSha?: string; liveShaPrefix?: string; profileShaPrefix?: string };

export const hostSwitchPorts = {
  enable: applyHostEnable,
  disable: applyHostDisable,
};

export const hostObservePorts = {
  classifyLive: classifyLiveHost,
};

async function classifyLiveHost(deps: CliDeps): Promise<HostClass> {
  try {
    const runtime = openRuntimeStore(deps.boxRuntimeRoot, deps.env);
    const status = await projectLiveStatus({
      root: runtime.root,
      ...(deps.env.GROKBOX_RUN_ROOT ? { ephemeralRoot: deps.env.GROKBOX_RUN_ROOT } : {}),
    });
    return classifyOperatorHost(status);
  } catch {
    return { host: "unknown", hostReason: "observation_unavailable" };
  }
}

function operatorPidPath(deps: CliDeps): string {
  return join(dirname(deps.daemonSocket), "operator-daemon.pid");
}

async function handshakeDaemon(deps: CliDeps, timeoutMs: number): Promise<boolean> {
  if (deps.daemonServerUrl) return false;
  try {
    await new LocalDaemonClient(deps.daemonSocket, timeoutMs, deps.signal).handshake();
    return true;
  } catch {
    return false;
  }
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedReason(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Live `projectLiveStatus` exposes Host origin on `facets.bridge.value`, not a top-level `host`. */
export function classifyOperatorHost(status: unknown): HostClass {
  const root = rec(status);
  const bridgeValue = rec(rec(rec(root.facets).bridge).value);
  const legacyHost = rec(root.host);
  const origin = typeof bridgeValue.origin === "string" ? bridgeValue.origin
    : typeof legacyHost.origin === "string" ? legacyHost.origin
    : null;
  const reason = boundedReason(bridgeValue.reason) ?? boundedReason(legacyHost.reason);
  // YELLOW: operator host class uses 4-window driftedSlices only; envelopeDrift is not a heal signal.
  const drifted = Array.isArray(root.driftedSlices) && root.driftedSlices.length > 0;
  if (origin === "official") return { host: "official", hostReason: null };
  if (origin === "grokbox-attested" && !drifted && reason === null) return { host: "custom", hostReason: null };
  if (origin === "grokbox-attested") return { host: "unknown", hostReason: reason ?? "stale_attestation" };
  if (origin === "grokbox-unattested") return { host: "unknown", hostReason: reason ?? "unattested" };
  if (origin === "ambiguous") return { host: "unknown", hostReason: reason ?? "ambiguous" };
  return { host: "unknown", hostReason: reason ?? "observation_unavailable" };
}

export function operatorNext(input: {
  daemon: OperatorDaemon;
  host: OperatorHost;
  hostReason: string | null;
  liveSha?: string | null;
}): string {
  if (input.hostReason === "source_mismatch") return profileWriteNext(input.liveSha);
  if (input.host === "unknown" && (input.hostReason === "stale_attestation" || input.hostReason === "unmanaged_preload")) {
    return "grokbox upgrade --yes";
  }
  if (input.daemon === "down") return "grokbox on";
  if (input.host === "official") return HOST_START;
  return "none";
}

export function powerOnNext(host: OperatorHost): string {
  return host === "custom" ? "none" : HOST_START;
}

export function mismatchNext(hostReason: string | null, liveSha?: string | null): string {
  if (hostReason === "source_mismatch") return profileWriteNext(liveSha);
  if (hostReason === "stale_attestation" || hostReason === "unmanaged_preload") return "grokbox upgrade --yes";
  return "grokbox doctor";
}

async function inspectHostClass(deps: CliDeps, overlay: boolean): Promise<HostClass & SourceFacts> {
  const live = await hostObservePorts.classifyLive(deps);
  const liveSha = await hostSourcePorts.readLiveSha(deps);
  const profileSha = await hostSourcePorts.readProfileSha(deps);
  const match = classifySourceMatch(liveSha, profileSha);
  const classified = overlay ? overlaySourceMatch(live, match) : live;
  const facts: SourceFacts = isFullSourceSha(liveSha) ? { liveSha } : {};
  if (match !== "mismatch") return { ...classified, ...facts };
  return {
    ...classified,
    ...facts,
    ...(shaPrefix(liveSha) ? { liveShaPrefix: shaPrefix(liveSha) } : {}),
    ...(shaPrefix(profileSha) ? { profileShaPrefix: shaPrefix(profileSha) } : {}),
  };
}

export async function inspectOperator(deps: CliDeps, timeoutMs: number): Promise<OperatorReport> {
  const daemon: OperatorDaemon = await handshakeDaemon(deps, timeoutMs) ? "up" : "down";
  const classified = await inspectHostClass(deps, true);
  let pruneEnabled = false;
  try {
    pruneEnabled = (await readDaemonConfig(deps.configDir)).desktop?.pruneEnabled === true;
  } catch {
    pruneEnabled = false;
  }
  return {
    daemon,
    titleSync: daemon === "up",
    screenIdle: daemon === "up" && pruneEnabled,
    host: classified.host,
    hostReason: classified.hostReason,
    next: operatorNext({
      daemon,
      host: classified.host,
      hostReason: classified.hostReason,
      liveSha: classified.liveSha,
    }),
    ...(classified.liveShaPrefix ? { liveShaPrefix: classified.liveShaPrefix } : {}),
    ...(classified.profileShaPrefix ? { profileShaPrefix: classified.profileShaPrefix } : {}),
    ...(classified.hostReason === "source_mismatch" && classified.liveSha
      ? { liveSourceSha: classified.liveSha }
      : {}),
  };
}

async function persistPruneEnabled(deps: CliDeps, enabled: boolean): Promise<void> {
  const current = await readDaemonConfig(deps.configDir);
  await writeDaemonConfig(deps.configDir, {
    ...current,
    desktop: { ...(current.desktop ?? {}), pruneEnabled: enabled },
  });
}

async function rpcPruneEnabled(deps: CliDeps, timeoutMs: number, enabled: boolean): Promise<void> {
  try {
    await new LocalDaemonClient(deps.daemonSocket, timeoutMs, deps.signal).call(
      enabled ? "desktopPruneEnable" : "desktopPruneDisable",
      {},
    );
  } catch {
    // Persist is the durable switch; live tick follows the next daemon start if RPC misses.
  }
}

function spawnArgs(): [string, string[]] | null {
  const exec = process.argv[0];
  const script = process.argv[1];
  if (!exec || !script) return null;
  if (!/\/dist\/index\.js$|\/packages\/cli\/src\/index\.ts$|\/bin\/grokbox$/.test(script)) return null;
  return [exec, [script, "daemon", "serve"]];
}

async function ensureLocalDaemon(deps: CliDeps, timeoutMs: number): Promise<"up" | "started" | "down"> {
  if (await handshakeDaemon(deps, timeoutMs)) return "up";
  const spawned = spawnArgs();
  if (!spawned) return "down";
  const [exec, args] = spawned;
  const child = spawn(exec, args, { detached: true, stdio: "ignore", env: { ...process.env, ...deps.env } });
  if (child.pid) await writeFile(operatorPidPath(deps), String(child.pid), { encoding: "utf8", mode: 0o600 });
  child.unref();
  const deadline = deps.now() + Math.min(timeoutMs, 8_000);
  while (deps.now() < deadline) {
    if (await handshakeDaemon(deps, 500)) return "started";
    await deps.wait(200, deps.signal);
  }
  return (await handshakeDaemon(deps, 500)) ? "started" : "down";
}

async function stopSpawnedDaemon(deps: CliDeps): Promise<"stopped" | "absent" | "external"> {
  if (await handshakeDaemon(deps, 1_000) === false) return "absent";
  let pid: number | null = null;
  try {
    pid = Number.parseInt(await readFile(operatorPidPath(deps), "utf8"), 10);
  } catch {
    return "external";
  }
  if (!Number.isInteger(pid) || pid <= 0) return "external";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await unlink(operatorPidPath(deps)).catch(() => undefined);
    return "absent";
  }
  await deps.wait(500, deps.signal);
  await unlink(operatorPidPath(deps)).catch(() => undefined);
  return (await handshakeDaemon(deps, 500)) ? "external" : "stopped";
}

export async function listRunningBots(deps: CliDeps, timeoutMs: number): Promise<
  { ok: true; running: RunningBot[] } | { ok: false; running: RunningBot[] }
> {
  try {
    const { agents } = await new GatewayClient(deps).listAgents(timeoutMs);
    const running = agents.flatMap((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return [];
      const compact = compactRosterRow(row as Record<string, unknown>);
      if (agentKind(row as Record<string, unknown>) !== "agent") return [];
      if (!compact.isRunning && !compact.isRunningTurn) return [];
      return [{ id: compact.id, name: compact.name }];
    });
    return { ok: true, running };
  } catch {
    return { ok: false, running: [] };
  }
}

function sourceMismatchError(facts: SourceFacts = {}): CliError {
  const next = profileWriteNext(facts.liveSha);
  return new CliError(
    "host_source_mismatch",
    `Live Host SHA does not match the reviewed profile. Observe the live Host, then write from the retained SHA. Next: ${next}`,
    {
      next,
      hostReason: "source_mismatch",
      ...(facts.liveShaPrefix ? { liveShaPrefix: facts.liveShaPrefix } : {}),
      ...(facts.profileShaPrefix ? { profileShaPrefix: facts.profileShaPrefix } : {}),
    },
  );
}

function hostMismatchError(hostReason: string | null, liveSha?: string): CliError {
  const next = mismatchNext(hostReason, liveSha);
  const reason = hostReason ?? "observation_unavailable";
  return new CliError(
    "host_mismatch",
    `Host channel is unknown (${reason}). Next: ${next}`,
    { next, hostReason: reason },
  );
}

function hostSwitchBlockedError(input: { running: RunningBot[]; next: string; hint: string }): CliError {
  const listed = input.running.length > 0
    ? ` Running bots: ${input.running.map((bot) => `${bot.name} (${bot.id})`).join(", ")}.`
    : "";
  return new CliError(
    "host_switch_blocked",
    `${input.hint}${listed} Next: ${input.next}`,
    { running: input.running, next: input.next },
  );
}

function isSourceMismatchReceipt(value: unknown): boolean {
  const row = rec(value);
  return row.outcome === "refused" && row.reason === "source-mismatch";
}

function isRefusedReceipt(value: unknown): value is { outcome: "refused"; reason: string } {
  const row = rec(value);
  return row.outcome === "refused" && typeof row.reason === "string" && row.reason.length > 0;
}

function admitEnableReceipt(receipt: unknown, facts: SourceFacts = {}): unknown {
  if (isSourceMismatchReceipt(receipt)) throw sourceMismatchError(facts);
  if (isRefusedReceipt(receipt) && receipt.reason === "desired-disabled") {
    throw new CliError(
      "host_mismatch",
      "Host start is blocked because desired mode is disabled. Next: grokbox runtime activate --mode route",
      { next: "grokbox runtime activate --mode route", hostReason: "desired-disabled" },
    );
  }
  return receipt;
}

function refuseUnknown(classified: HostClass & SourceFacts): void {
  if (classified.hostReason === "source_mismatch") throw sourceMismatchError(classified);
  if (classified.host === "unknown") throw hostMismatchError(classified.hostReason, classified.liveSha);
}

function successNext(actual: HostClass & SourceFacts): string {
  if (actual.host !== "unknown") return "none";
  return mismatchNext(actual.hostReason, actual.liveSha);
}

function lifecyclePayload(input: {
  command: HostLifecycleCommand;
  outcome: HostOutcome;
  actual: HostClass & SourceFacts;
  forced: boolean;
  running: RunningBot[];
  receipt?: unknown;
}): Record<string, unknown> {
  return {
    command: input.command,
    desired: input.command === "stop" ? "official" : "custom",
    actual: input.actual.host,
    outcome: input.outcome,
    next: successNext(input.actual),
    hostReason: input.actual.hostReason,
    forced: input.forced,
    running: input.running,
    ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
  };
}

async function gateRunningBots(
  deps: CliDeps,
  command: HostLifecycleCommand,
  force: boolean,
  timeoutMs: number,
): Promise<RunningBot[]> {
  const listed = await listRunningBots(deps, timeoutMs);
  const next = `grokbox host ${command} --force`;
  if (!force && !listed.ok) {
    throw hostSwitchBlockedError({
      running: [],
      next,
      hint: `${HOST_SWITCH_HINT} Running bots could not be listed.`,
    });
  }
  if (!force && listed.ok && listed.running.length > 0) {
    throw hostSwitchBlockedError({
      running: listed.running,
      next,
      hint: HOST_SWITCH_HINT,
    });
  }
  return listed.running;
}

async function runHostLifecycle(
  deps: CliDeps,
  command: HostLifecycleCommand,
  raw: { json?: boolean; timeoutMs?: string; force?: boolean },
): Promise<void> {
  const io = ioFromOpts(raw);
  const force = raw.force === true;
  const pre = await inspectHostClass(deps, command !== "stop");
  refuseUnknown(pre);
  if (command === "start" && pre.host === "custom") {
    await ensureHostStartDesired(deps);
    writeSuccess(deps.stdout, lifecyclePayload({
      command, outcome: "already_started", actual: pre, forced: false, running: [],
    }));
    return;
  }
  if (command === "stop" && pre.host === "official") {
    writeSuccess(deps.stdout, lifecyclePayload({
      command, outcome: "already_stopped", actual: pre, forced: false, running: [],
    }));
    return;
  }
  const running = await gateRunningBots(deps, command, force, io.timeoutMs);
  let receipt: unknown;
  if (command === "start") {
    receipt = admitEnableReceipt(await hostSwitchPorts.enable(deps), pre);
  } else if (command === "stop") {
    receipt = await hostSwitchPorts.disable(deps);
  } else {
    const disable = await hostSwitchPorts.disable(deps);
    const enable = admitEnableReceipt(await hostSwitchPorts.enable(deps), pre);
    receipt = { disable, enable };
  }
  const post = await inspectHostClass(deps, true);
  if (command === "stop" && post.host === "custom") {
    throw new CliError(
      "host_mismatch",
      "Host stop did not reach official coverage (still custom). Next: grokbox doctor",
      { next: "grokbox doctor", hostReason: post.hostReason ?? "still_custom" },
    );
  }
  writeSuccess(deps.stdout, lifecyclePayload({
    command,
    outcome: command === "start" ? "started" : command === "stop" ? "stopped" : "restarted",
    actual: post,
    forced: force,
    running,
    receipt,
  }));
}

export async function runOperatorStatus(deps: CliDeps, raw: { json?: boolean; timeoutMs?: string }): Promise<void> {
  const io = ioFromOpts(raw);
  writeSuccess(deps.stdout, await inspectOperator(deps, io.timeoutMs));
}

export async function runOperatorOn(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const daemon = await ensureLocalDaemon(deps, io.timeoutMs);
  if (daemon === "down") {
    throw new CliError("daemon_unreachable", "grokbox services are down. Retry grokbox on from the grokbox CLI on this computer.");
  }
  await persistPruneEnabled(deps, true);
  await rpcPruneEnabled(deps, io.timeoutMs, true);
  const report = await inspectOperator(deps, io.timeoutMs);
  writeSuccess(deps.stdout, {
    daemon,
    titleSync: true,
    screenIdle: true,
    host: "unchanged",
    next: report.next,
  });
}

export async function runOperatorOff(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  await rpcPruneEnabled(deps, io.timeoutMs, false);
  await persistPruneEnabled(deps, false);
  const daemon = await stopSpawnedDaemon(deps);
  writeSuccess(deps.stdout, {
    daemon,
    screenIdle: false,
    host: "unchanged",
  });
}

export async function runHostStart(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string; force?: boolean },
): Promise<void> {
  await runHostLifecycle(deps, "start", raw);
}

export async function runHostStop(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string; force?: boolean },
): Promise<void> {
  await runHostLifecycle(deps, "stop", raw);
}

export async function runHostRestart(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string; force?: boolean },
): Promise<void> {
  await runHostLifecycle(deps, "restart", raw);
}

export async function runHostReserved(
  _deps: CliDeps,
  command: "status" | "realign" | "logs",
): Promise<void> {
  const next = command === "realign" ? "grokbox upgrade --yes" : "grokbox doctor";
  throw new CliError("invalid_usage", `host ${command} is not implemented. Next: ${next}`, { next });
}

function rethrowRuntime(error: unknown): never {
  if (error instanceof BoxRuntimeError) throw new CliError(error.code, error.message);
  throw error;
}

export async function runOperatorUpgrade(
  deps: CliDeps,
  raw: { json?: boolean; timeoutMs?: string; yes?: boolean },
): Promise<void> {
  if (raw.yes !== true) throw usage("upgrade requires --yes.");
  const io = ioFromOpts(raw);
  const pre = await inspectHostClass(deps, true);
  if (pre.hostReason === "source_mismatch") throw sourceMismatchError(pre);
  let enable: unknown;
  try {
    enable = admitEnableReceipt(await hostSwitchPorts.enable(deps), pre);
  } catch (error) {
    rethrowRuntime(error);
  }
  const daemon = await ensureLocalDaemon(deps, io.timeoutMs);
  if (daemon !== "down") {
    await persistPruneEnabled(deps, true);
    await rpcPruneEnabled(deps, io.timeoutMs, true);
  }
  writeSuccess(deps.stdout, {
    host: "enable-requested",
    daemon,
    titleSync: daemon !== "down",
    screenIdle: daemon !== "down",
    enable,
  });
}

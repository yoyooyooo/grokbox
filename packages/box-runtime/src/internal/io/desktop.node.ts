import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readDesktopWorld } from "./desktop-source.node.ts";
import { HostResourceError as CliError } from "./host-resource-contract.ts";
import { configurationRevisions } from "@grokbox/runtime-kernel/config";
import { openConfigStore } from "./config-store.node.ts";
import { readConfigLayout } from "./config-layout.node.ts";
import { createConfigConsumerOwner, publishConfigApplication, releaseConfigApplication, type ConfigConsumerOwner } from "./config-application.node.ts";
import {
  classifyDesktop,
  DESKTOP_POLICY,
  DEFAULT_MIN_IDLE_MS,
  MAIN_DISPLAY,
  type DesktopPolicy,
  type DesktopPruneRow,
  type DesktopRow,
  type DesktopWorld,
} from "@grokbox/runtime-kernel/desktop";
import type { DesktopLaunchResources } from "@grokbox/runtime-kernel/desktop";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_STOP_WINDOW = "/usr/local/bin/stop-window";
const DEFAULT_ASSIGNMENTS = "/home/box/.sand-window-assignments.json";
const DEFAULT_AGENTS = "/home/box/agent-data/agents";
const DEFAULT_X11 = "/tmp/.X11-unix";
const DEFAULT_TICK_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;
const TRANSCRIPT_FILES = ["store.db", "store.db-wal", "conversation-blobs.db", "conversation-blobs.db-wal"];

export type PinnedStopWindow = { path: string; dev: number; ino: number; sha256: string };

export type DesktopIo = {
  readWorld(nowMs: number): Promise<DesktopWorld>;
  stopWindow(display: number, signal?: AbortSignal): Promise<void>;
  reapLogs(display: number): Promise<void>;
  unseatAgent(agentId: string): Promise<void>;
};

export type DesktopStatusResult = {
  complete: boolean;
  observedAtMs: number;
  displayIdentities: Record<number, string>;
  pruneEnabled: boolean;
  keepAgentIds: string[];
  floorAgentIds: string[];
  minIdleMs: number;
  displays: DesktopRow[];
};

export type DesktopPruneResult = {
  dryRun: boolean;
  pruneEnabled: boolean;
  rows: DesktopPruneRow[];
};

export type DesktopReapOutcome = "stopped" | "skipped_main" | "no_seat" | "unavailable";

export type DesktopReapResult = {
  display: number | null;
  outcome: DesktopReapOutcome;
};

const REAP_OUTCOMES = new Set<DesktopReapOutcome>(["stopped", "skipped_main", "no_seat", "unavailable"]);

export function readDesktopReap(value: unknown): DesktopReapResult | undefined {
  if (!isRecord(value) || !isRecord(value.desktop)) return undefined;
  const outcome = value.desktop.outcome;
  if (typeof outcome !== "string" || !REAP_OUTCOMES.has(outcome as DesktopReapOutcome)) return undefined;
  const display = value.desktop.display;
  if (display !== null && (typeof display !== "number" || !Number.isInteger(display) || display < 1)) {
    return undefined;
  }
  return { display, outcome: outcome as DesktopReapOutcome };
}

export async function liveDesktopIo(): Promise<DesktopIo | null> {
  try {
    return createLiveDesktopIo(await pinExecutable(DEFAULT_STOP_WINDOW));
  } catch {
    return null;
  }
}

export async function reapDeletedAgentSeat(
  agentId: string,
  nowMs: number,
  io: DesktopIo,
): Promise<DesktopReapResult> {
  const query = agentId.trim().toLowerCase();
  if (!UUID_V4.test(query)) return { display: null, outcome: "no_seat" };
  let world: DesktopWorld;
  try {
    world = await io.readWorld(nowMs);
  } catch {
    return { display: null, outcome: "unavailable" };
  }
  const match = Object.entries(world.assignments).find(([id]) => id.toLowerCase() === query);
  if (!match) return { display: null, outcome: "no_seat" };
  const display = match[1];
  if (display <= MAIN_DISPLAY) return { display, outcome: "skipped_main" };
  try {
    await io.stopWindow(display);
    await io.reapLogs(display);
  } catch {
    return { display, outcome: "unavailable" };
  }
  try {
    await io.unseatAgent(match[0]);
  } catch {
    return { display, outcome: "unavailable" };
  }
  return { display, outcome: "stopped" };
}

function seatTableHasAgent(table: Record<string, unknown>, query: string): boolean {
  for (const field of ["assignments", "tokens"] as const) {
    const record = table[field];
    if (!isRecord(record)) continue;
    if (Object.keys(record).some((id) => id.toLowerCase() === query)) return true;
  }
  return false;
}

function dropAgentFromSeatTable(
  table: Record<string, unknown>,
  query: string,
): { changed: boolean; value: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...table };
  let changed = false;
  for (const field of ["assignments", "tokens"] as const) {
    const record = table[field];
    if (!isRecord(record)) continue;
    const copy: Record<string, unknown> = { ...record };
    for (const id of Object.keys(copy)) {
      if (id.toLowerCase() !== query) continue;
      delete copy[id];
      changed = true;
    }
    next[field] = copy;
  }
  return { changed, value: next };
}

async function atomicWriteSeatTable(path: string, value: unknown, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.sand-window-assignments.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function unseatAgentFromAssignments(path: string, agentId: string): Promise<void> {
  const query = agentId.trim().toLowerCase();
  if (!UUID_V4.test(query)) {
    throw new CliError("desktop_unavailable", "Desktop unseat requires a UUID agent id.");
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CliError("desktop_unavailable", "Desktop seating table is unreadable.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError("desktop_unavailable", "Desktop seating table is not valid JSON.");
    }
    if (!isRecord(parsed)) {
      throw new CliError("desktop_unavailable", "Desktop seating table has the wrong shape.");
    }
    const next = dropAgentFromSeatTable(parsed, query);
    if (!next.changed) return;
    let mode = 0o644;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      // New or raced-away file uses the shared-desktop default mode.
    }
    try {
      await atomicWriteSeatTable(path, next.value, mode);
    } catch {
      throw new CliError("desktop_unavailable", "Desktop seating table could not be updated.");
    }
    let verifyRaw: string;
    try {
      verifyRaw = await readFile(path, "utf8");
    } catch {
      throw new CliError("desktop_unavailable", "Desktop seating table could not be re-read after unseat.");
    }
    let verify: unknown;
    try {
      verify = JSON.parse(verifyRaw);
    } catch {
      throw new CliError("desktop_unavailable", "Desktop seating table is not valid JSON.");
    }
    if (isRecord(verify) && !seatTableHasAgent(verify, query)) return;
  }
  throw new CliError("desktop_unavailable", "Desktop seating table could not drop the deleted agent.");
}

async function pinExecutable(path: string): Promise<PinnedStopWindow> {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!info.isFile() || canonical !== path || (info.mode & 0o111) === 0) {
      throw new CliError("desktop_unavailable", "The stop-window executable is not a pinned non-symlink file.");
    }
    if (info.nlink !== 1 || info.size > 256 * 1024) throw new CliError("desktop_unavailable", "The desktop helper is not a bounded unaliased executable.");
    const bytes = await readFile(path), after = await lstat(path);
    if (bytes.length !== info.size || info.ino !== after.ino || info.dev !== after.dev || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new CliError("desktop_unavailable", "The desktop helper changed while being inspected.");
    return { path, dev: info.dev, ino: info.ino, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("desktop_unavailable", "The stop-window executable is unavailable.");
  }
}

export function createLiveDesktopIo(stopWindow: PinnedStopWindow | null): DesktopIo {
  let unseatChain: Promise<void> = Promise.resolve();
  return {
    async readWorld(nowMs) {
      return await readDesktopWorld(nowMs);
    },
    async stopWindow(display, signal) {
      if (!stopWindow) {
        throw new CliError("desktop_unavailable", "Idle desktop prune is unavailable without a pinned stop-window.");
      }
      const current = await pinExecutable(stopWindow.path);
      if (current.dev !== stopWindow.dev || current.ino !== stopWindow.ino || current.sha256 !== stopWindow.sha256) {
        throw new CliError("desktop_unavailable", "The stop-window executable changed after daemon startup.");
      }
      await runStopWindow(current.path, display, signal);
    },
    async reapLogs(display) {
      await reapLogWrappers(display);
    },
    async unseatAgent(agentId) {
      const run = unseatChain.then(() => unseatAgentFromAssignments(DEFAULT_ASSIGNMENTS, agentId));
      unseatChain = run.then(() => undefined, () => undefined);
      await run;
    },
  };
}

export function runStopWindow(path: string, display: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(display) || display <= MAIN_DISPLAY || display > 65535) return Promise.reject(new CliError("desktop_unavailable", "The main or an invalid desktop cannot be stopped."));
  if (signal?.aborted) return Promise.reject(new CliError("desktop_unavailable", "Desktop reclaim was cancelled before helper invocation."));
  return new Promise((resolve, reject) => {
    const child = spawn(path, [String(display)], { stdio: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/box", LANG: "C.UTF-8" } });
    let aborted = false;
    const abort = () => { aborted = true; child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (!failed && !timedOut && !aborted && code === 0 && exitSignal === null) resolve();
      else reject(new CliError("desktop_unavailable", timedOut ? "stop-window exceeded its deadline." : "stop-window failed or was interrupted."));
    });
  });
}

export function isDesktopLogWrapper(cmdline: string, executable: string, display: number): boolean {
  if (!Number.isSafeInteger(display) || display <= MAIN_DISPLAY) return false;
  const args = cmdline.split("\0").filter(Boolean);
  // A command string merely mentioning the log path is not a logger identity.
  return ["tail", "tee"].includes(basename(executable)) && basename(args[0] ?? "") === basename(executable)
    && args.slice(1).some(arg => arg.startsWith(`/tmp/sand-window-${display}/`) && !arg.includes("/../"));
}
async function reapLogWrappers(display: number): Promise<void> {
  const entries = await readdir("/proc");
  if (entries.length > 16384) throw new CliError("desktop_unavailable", "Desktop logger inspection exceeds its finite bound.");
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const directory = `/proc/${entry}`;
    try {
      const owner = await lstat(directory);
      if (owner.uid !== process.getuid?.()) continue;
      const before = await readFile(`${directory}/stat`, "utf8");
      const identity = before.slice(before.lastIndexOf(")") + 2).split(" ")[19];
      const cmdline = (await readFile(`${directory}/cmdline`)).toString("utf8");
      const executable = await realpath(`${directory}/exe`);
      if (!/^[0-9]+$/.test(identity ?? "") || !isDesktopLogWrapper(cmdline, executable, display)) continue;
      const after = await readFile(`${directory}/stat`, "utf8");
      if (after.slice(after.lastIndexOf(")") + 2).split(" ")[19] !== identity || (await lstat(directory)).uid !== owner.uid
        || (await readFile(`${directory}/cmdline`)).toString("utf8") !== cmdline || await realpath(`${directory}/exe`) !== executable) continue;
      process.kill(Number(entry), "SIGTERM");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code))) throw new CliError("desktop_unavailable", "The original desktop logger could not be verified or signalled.");
    }
  }
}

export type DesktopCandidate = { display: number; agentId: string; identity: string };
export type DesktopReclaimHooks = { before: (row: DesktopCandidate) => Promise<void>; after: (row: DesktopCandidate, outcome: "stopped" | "refused" | "unknown") => Promise<void> };
export class DesktopManager {
  private keepAgentIds: string[];
  private pruneEnabled: boolean;
  private locked = false;
  private tick: ReturnType<typeof setInterval> | undefined;
  private tickWork: Promise<unknown> | undefined;
  private activeWork: Promise<void> | undefined;
  private closed = false;
  private readonly lifetime = new AbortController();
  private applicationOwner: ConfigConsumerOwner | undefined;
  private applicationRevision: string | undefined;
  readonly canReap: boolean;

  private constructor(
    private readonly configDir: string,
    private readonly now: () => number,
    private readonly io: DesktopIo,
    private readonly floorAgentIds: string[],
    private minIdleMs: number,
    keepAgentIds: string[],
    pruneEnabled: boolean,
    canReap: boolean,
    private readonly tickIntervalMs: number,
  ) {
    this.keepAgentIds = [...keepAgentIds];
    this.pruneEnabled = pruneEnabled;
    this.canReap = canReap;
  }

  static async create(
    configDir: string,
    now: () => number,
    desktop: DesktopLaunchResources | undefined,
    io?: DesktopIo,
    tickIntervalMs = DEFAULT_TICK_MS,
  ): Promise<DesktopManager> {
    const stopPath = desktop?.stopWindowPath ?? DEFAULT_STOP_WINDOW;
    let pinned: PinnedStopWindow | null = null;
    if (isAbsolute(stopPath)) {
      try {
        pinned = await pinExecutable(stopPath);
      } catch {
        pinned = null;
      }
    }
    const manager = new DesktopManager(
      configDir,
      now,
      io ?? createLiveDesktopIo(pinned),
      [...(desktop?.floorAgentIds ?? [])],
      desktop?.minIdleMs ?? DEFAULT_MIN_IDLE_MS,
      [...(desktop?.keepAgentIds ?? [])],
      desktop?.pruneEnabled === true,
      pinned !== null || io !== undefined,
      tickIntervalMs,
    );
    await manager.refreshPreferences(true);
    return manager;
  }

  async status(): Promise<DesktopStatusResult> {
    await this.refreshPreferences();
    const world = await this.io.readWorld(this.now());
    const displays = classifyDesktop(world, this.policy());
    return {
      complete: world.complete,
      observedAtMs: world.nowMs,
      displayIdentities: { ...world.displayIdentities },
      pruneEnabled: this.pruneEnabled,
      keepAgentIds: [...this.keepAgentIds],
      floorAgentIds: [...this.floorAgentIds],
      minIdleMs: this.minIdleMs,
      displays,
    };
  }

  reclaim(candidates: readonly DesktopCandidate[], hooks: DesktopReclaimHooks, automatic: boolean): Promise<void> {
    if (this.locked || this.closed || !this.canReap || candidates.length > DESKTOP_POLICY.maxBatch) return Promise.reject(new CliError("desktop_unavailable", "The original desktop owner cannot admit this reclaim batch."));
    this.locked = true;
    const run = (async () => {
      for (const row of candidates) {
        const eligible = async () => {
          if (this.closed || row.display <= MAIN_DISPLAY) return false;
          const current = await this.status();
          return current.complete && (!automatic || current.pruneEnabled) && current.displayIdentities[row.display] === row.identity
            && current.displays.some(v => v.agentId === row.agentId && v.display === row.display && v.idle);
        };
        let invoked = false, settling = false;
        const settle = async (outcome: "stopped" | "refused" | "unknown") => { settling = true; await hooks.after(row, outcome); };
        try {
          if (!await eligible()) { await settle("refused"); continue; }
          // The domain publishes its original dispatch claim and rechecks
          // authority here. No new candidate is selected during this batch.
          await hooks.before(row);
          if (!await eligible()) { await settle("refused"); continue; }
          invoked = true;
          await this.io.stopWindow(row.display, this.lifetime.signal);
          await this.io.reapLogs(row.display);
          const current = await this.io.readWorld(this.now());
          await settle(current.complete && !current.litDisplays.has(row.display) ? "stopped" : "unknown");
        } catch (error) {
          // A failed settlement acknowledgement cannot authorize another outcome.
          if (settling) throw error;
          await settle(invoked ? "unknown" : "refused");
          if (invoked) throw error;
        }
      }
    })().finally(() => { this.locked = false; this.activeWork = undefined; });
    this.activeWork = run; return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.stopTick();
    await Promise.allSettled([this.tickWork, this.activeWork]);
    if (this.applicationOwner) await releaseConfigApplication(this.applicationOwner);
  }

  private policy(): DesktopPolicy {
    return {
      minIdleMs: this.minIdleMs,
      minDisplayAgeMs: this.minIdleMs,
      floorAgentIds: this.floorAgentIds,
      keepAgentIds: this.keepAgentIds,
    };
  }

  startAutomatic(action: () => Promise<void>): void {
    if (this.tick !== undefined || this.closed) throw new CliError("desktop_unavailable", "Desktop scheduling already has an owner or is closed.");
    this.tick = setInterval(() => {
      if (this.locked || this.closed || this.tickWork) return;
      const running = action().finally(() => { if (this.tickWork === running) this.tickWork = undefined; });
      this.tickWork = running;
      void running.catch(() => undefined);
    }, this.tickIntervalMs);
    this.tick.unref?.();
  }

  private stopTick(): void {
    if (this.tick === undefined) return;
    clearInterval(this.tick);
    this.tick = undefined;
  }

  async refreshPreferences(recordApplication = false): Promise<void> {
    const layout = await readConfigLayout(this.configDir);
    const { document } = await openConfigStore(layout).read();
    this.keepAgentIds = [...(document.desktop?.keepAgentIds ?? [])];
    this.minIdleMs = document.desktop?.idleReclaim?.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
    this.pruneEnabled = document.desktop?.idleReclaim?.enabled === true;
    if (!recordApplication || this.closed || layout.role !== "box") return;
    const revision = configurationRevisions(document).desktop;
    if (revision === this.applicationRevision) return;
    this.applicationOwner ??= await createConfigConsumerOwner(layout.root, "desktop");
    if (this.applicationOwner.root !== layout.root) throw new CliError("config_layout_conflict", "Desktop consumer cannot change installation roots.");
    await publishConfigApplication(this.applicationOwner, document, this.now());
    this.applicationRevision = revision;
  }
}

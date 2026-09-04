import { spawn } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CliError } from "../errors.ts";
import {
  classifyDesktop,
  DEFAULT_MIN_IDLE_MS,
  displayFromEnviron,
  inspectDesktopProc,
  MAIN_DISPLAY,
  resolveDesktopAgent,
  type DesktopPolicy,
  type DesktopPruneRow,
  type DesktopRow,
  type DesktopWorld,
} from "../desktop.ts";
import { isRecord } from "../util.ts";
import {
  readDaemonConfig,
  writeDaemonConfig,
  type DaemonDesktopConfig,
} from "./config.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_STOP_WINDOW = "/usr/local/bin/stop-window";
const DEFAULT_ASSIGNMENTS = "/home/box/.sand-window-assignments.json";
const DEFAULT_AGENTS = "/home/box/agent-data/agents";
const DEFAULT_X11 = "/tmp/.X11-unix";
const DEFAULT_TICK_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;
const TRANSCRIPT_FILES = ["store.db", "store.db-wal", "conversation-blobs.db", "conversation-blobs.db-wal"];

export type PinnedStopWindow = { path: string; dev: number; ino: number };

export type DesktopIo = {
  readWorld(nowMs: number): Promise<DesktopWorld>;
  stopWindow(display: number): Promise<void>;
  reapLogs(display: number): Promise<void>;
};

export type DesktopStatusResult = {
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

async function pinExecutable(path: string): Promise<PinnedStopWindow> {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!info.isFile() || canonical !== path || (info.mode & 0o111) === 0) {
      throw new CliError("desktop_unavailable", "The stop-window executable is not a pinned non-symlink file.");
    }
    return { path, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("desktop_unavailable", "The stop-window executable is unavailable.");
  }
}

export function createLiveDesktopIo(stopWindow: PinnedStopWindow | null): DesktopIo {
  return {
    async readWorld(nowMs) {
      return await readLiveWorld(nowMs);
    },
    async stopWindow(display) {
      if (!stopWindow) {
        throw new CliError("desktop_unavailable", "Idle desktop prune is unavailable without a pinned stop-window.");
      }
      const current = await pinExecutable(stopWindow.path);
      if (current.dev !== stopWindow.dev || current.ino !== stopWindow.ino) {
        throw new CliError("desktop_unavailable", "The stop-window executable changed after daemon startup.");
      }
      await runStopWindow(current.path, display);
    },
    async reapLogs(display) {
      await reapLogWrappers(display);
    },
  };
}

async function readLiveWorld(nowMs: number): Promise<DesktopWorld> {
  const assignments: Record<string, number> = {};
  const names: Record<string, string> = {};
  try {
    const parsed = JSON.parse(await readFile(DEFAULT_ASSIGNMENTS, "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.assignments)) {
      for (const [agentId, display] of Object.entries(parsed.assignments)) {
        if (UUID_V4.test(agentId) && typeof display === "number" && Number.isInteger(display) && display >= 1) {
          assignments[agentId] = display;
        }
      }
    }
  } catch {
    // Missing seating table is an empty world.
  }
  const litDisplays = new Set<number>();
  const displayStartedAtMs: Record<number, number> = {};
  const displays = new Set<number>(Object.values(assignments));
  for (const display of displays) {
    try {
      const info = await stat(join(DEFAULT_X11, `X${display}`));
      litDisplays.add(display);
      displayStartedAtMs[display] = Math.round(info.ctimeMs);
    } catch {
      // Dark display.
    }
  }
  const transcriptWrittenAtMs: Record<string, number> = {};
  for (const agentId of Object.keys(assignments)) {
    let latest = 0;
    for (const file of TRANSCRIPT_FILES) {
      try {
        const info = await stat(join(DEFAULT_AGENTS, agentId, file));
        latest = Math.max(latest, Math.round(info.mtimeMs));
      } catch {
        // Missing transcript file.
      }
    }
    try {
      const raw = JSON.parse(await readFile(join(DEFAULT_AGENTS, agentId, "profile.json"), "utf8")) as unknown;
      if (isRecord(raw) && typeof raw.name === "string" && raw.name.trim().length > 0) {
        names[agentId] = raw.name.trim();
      }
    } catch {
      // Name is optional.
    }
    transcriptWrittenAtMs[agentId] = latest;
  }
  const busyMarkers = new Set<number>();
  for (const display of displays) {
    try {
      const info = await stat(`/tmp/sand-monitor-busy-${display}`);
      if (nowMs - Math.round(info.mtimeMs) < DEFAULT_MIN_IDLE_MS) busyMarkers.add(display);
    } catch {
      // Missing or stale busy marker.
    }
  }
  const { grokDisplays, taskDisplays, startWindowDisplays } = await scanProcDisplays();
  return {
    nowMs,
    assignments,
    names,
    litDisplays,
    displayStartedAtMs,
    transcriptWrittenAtMs,
    busyMarkers,
    grokDisplays,
    taskDisplays,
    startWindowDisplays,
  };
}

async function scanProcDisplays(): Promise<{
  grokDisplays: Set<number>;
  taskDisplays: Set<number>;
  startWindowDisplays: Set<number>;
}> {
  const grokDisplays = new Set<number>();
  const taskDisplays = new Set<number>();
  const startWindowDisplays = new Set<number>();
  let procEntries: string[] = [];
  try {
    procEntries = await readdir("/proc");
  } catch {
    return { grokDisplays, taskDisplays, startWindowDisplays };
  }
  for (const entry of procEntries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let cmdline = "";
    let environ = "";
    try {
      cmdline = (await readFile(`/proc/${entry}/cmdline`)).toString("utf8");
      environ = (await readFile(`/proc/${entry}/environ`)).toString("utf8");
    } catch {
      continue;
    }
    const inspected = inspectDesktopProc(cmdline);
    if (inspected.startWindow !== undefined) startWindowDisplays.add(inspected.startWindow);
    const fromEnv = displayFromEnviron(environ);
    if (fromEnv === undefined) continue;
    if (inspected.grok) grokDisplays.add(fromEnv);
    if (inspected.task) taskDisplays.add(fromEnv);
  }
  return { grokDisplays, taskDisplays, startWindowDisplays };
}

function runStopWindow(path: string, display: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [String(display)], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CliError("desktop_unavailable", "stop-window exceeded its deadline."));
    }, STOP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new CliError("desktop_unavailable", "stop-window failed."));
    });
  });
}

async function reapLogWrappers(display: number): Promise<void> {
  const needle = `/tmp/sand-window-${display}/`;
  let procEntries: string[] = [];
  try {
    procEntries = await readdir("/proc");
  } catch {
    return;
  }
  for (const entry of procEntries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let cmdline = "";
    try {
      cmdline = (await readFile(`/proc/${entry}/cmdline`)).toString("utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes(needle)) continue;
    const pid = Number.parseInt(entry, 10);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
}

export class DesktopManager {
  private keepAgentIds: string[];
  private pruneEnabled: boolean;
  private locked = false;
  private tick: ReturnType<typeof setInterval> | undefined;
  readonly canReap: boolean;

  private constructor(
    private readonly configDir: string,
    private readonly now: () => number,
    private readonly io: DesktopIo,
    private readonly floorAgentIds: string[],
    private readonly minIdleMs: number,
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
    desktop: DaemonDesktopConfig | undefined,
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
    if (manager.pruneEnabled) manager.startTick();
    return manager;
  }

  capabilities(): string[] {
    return this.canReap ? ["host.desktop.read", "host.desktop.reap"] : ["host.desktop.read"];
  }

  async status(): Promise<DesktopStatusResult> {
    const displays = classifyDesktop(await this.io.readWorld(this.now()), this.policy());
    return {
      pruneEnabled: this.pruneEnabled,
      keepAgentIds: [...this.keepAgentIds],
      floorAgentIds: [...this.floorAgentIds],
      minIdleMs: this.minIdleMs,
      displays,
    };
  }

  async keepAdd(ref: string): Promise<{ agentId: string; kept: true }> {
    const world = await this.io.readWorld(this.now());
    const agentId = UUID_V4.test(ref) ? ref : resolveDesktopAgent(ref, world);
    if (!agentId || (!UUID_V4.test(agentId))) {
      throw new CliError("target_not_found", "Desktop keep requires a seated agent id or unambiguous name.");
    }
    if (!this.keepAgentIds.includes(agentId) && !this.floorAgentIds.includes(agentId)) {
      this.keepAgentIds = [...this.keepAgentIds, agentId].sort();
      await this.persist();
    }
    return { agentId, kept: true };
  }

  async keepRemove(ref: string, yes: boolean): Promise<{ agentId: string; kept: false }> {
    if (!yes) throw new CliError("invalid_usage", "desktop keep remove requires --yes.");
    const world = await this.io.readWorld(this.now());
    const agentId = UUID_V4.test(ref) ? ref : resolveDesktopAgent(ref, world);
    if (!agentId) throw new CliError("target_not_found", "Desktop keep requires a seated agent id or unambiguous name.");
    if (this.floorAgentIds.includes(agentId)) {
      throw new CliError("invalid_usage", "Daemon-floor desktop keep ids cannot be removed.");
    }
    this.keepAgentIds = this.keepAgentIds.filter((id) => id !== agentId);
    await this.persist();
    return { agentId, kept: false };
  }

  async prune(yes: boolean): Promise<DesktopPruneResult> {
    if (!yes) {
      const displays = classifyDesktop(await this.io.readWorld(this.now()), this.policy());
      return {
        dryRun: true,
        pruneEnabled: this.pruneEnabled,
        rows: displays.map((row) => ({
          display: row.display,
          agentId: row.agentId,
          outcome: row.idle ? "planned" : "kept",
          busyReason: row.busyReason,
        })),
      };
    }
    if (!this.canReap) {
      throw new CliError("desktop_unavailable", "Idle desktop prune is unavailable without a pinned stop-window.");
    }
    return await this.pruneLocked();
  }

  async setEnabled(enabled: boolean): Promise<{ pruneEnabled: boolean }> {
    this.pruneEnabled = enabled;
    await this.persist();
    if (enabled) this.startTick();
    else this.stopTick();
    return { pruneEnabled: this.pruneEnabled };
  }

  async close(): Promise<void> {
    this.stopTick();
  }

  private policy(): DesktopPolicy {
    return {
      minIdleMs: this.minIdleMs,
      minDisplayAgeMs: this.minIdleMs,
      floorAgentIds: this.floorAgentIds,
      keepAgentIds: this.keepAgentIds,
    };
  }

  private async pruneLocked(): Promise<DesktopPruneResult> {
    if (this.locked) {
      return { dryRun: false, pruneEnabled: this.pruneEnabled, rows: [] };
    }
    this.locked = true;
    try {
      const first = classifyDesktop(await this.io.readWorld(this.now()), this.policy());
      const rows: DesktopPruneRow[] = [];
      for (const row of first) {
        if (!row.idle) {
          rows.push({
            display: row.display,
            agentId: row.agentId,
            outcome: row.busyReason === "grok" || row.busyReason === "task" || row.busyReason === "busy-marker"
              ? "busy"
              : "kept",
            busyReason: row.busyReason,
          });
          continue;
        }
        const second = classifyDesktop(await this.io.readWorld(this.now()), this.policy())
          .find((entry) => entry.display === row.display && entry.agentId === row.agentId);
        if (!second?.idle) {
          rows.push({
            display: row.display,
            agentId: row.agentId,
            outcome: "raced",
            busyReason: second?.busyReason ?? "fresh-display",
          });
          continue;
        }
        if (row.display <= MAIN_DISPLAY) {
          rows.push({ display: row.display, agentId: row.agentId, outcome: "kept", busyReason: "protected" });
          continue;
        }
        await this.io.stopWindow(row.display);
        await this.io.reapLogs(row.display);
        rows.push({ display: row.display, agentId: row.agentId, outcome: "stopped", busyReason: null });
      }
      return { dryRun: false, pruneEnabled: this.pruneEnabled, rows };
    } finally {
      this.locked = false;
    }
  }

  private startTick(): void {
    if (this.tick !== undefined) return;
    this.tick = setInterval(() => {
      if (!this.pruneEnabled || this.locked || !this.canReap) return;
      void this.pruneLocked().catch(() => undefined);
    }, this.tickIntervalMs);
    this.tick.unref?.();
  }

  private stopTick(): void {
    if (this.tick === undefined) return;
    clearInterval(this.tick);
    this.tick = undefined;
  }

  private async persist(): Promise<void> {
    const current = await readDaemonConfig(this.configDir);
    await writeDaemonConfig(this.configDir, {
      ...current,
      desktop: {
        ...(current.desktop ?? {}),
        keepAgentIds: [...this.keepAgentIds],
        floorAgentIds: [...this.floorAgentIds],
        minIdleMs: this.minIdleMs,
        pruneEnabled: this.pruneEnabled,
        ...(current.desktop?.stopWindowPath ? { stopWindowPath: current.desktop.stopWindowPath } : {}),
      },
    });
  }
}

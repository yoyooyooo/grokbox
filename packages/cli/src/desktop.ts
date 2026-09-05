export const MAIN_DISPLAY = 1;
export const DEFAULT_MIN_IDLE_MS = 600_000;

export type DesktopBusyReason =
  | "protected"
  | "dark"
  | "fresh-display"
  | "recent-transcript"
  | "grok"
  | "task"
  | "busy-marker"
  | "start-window";

export type DesktopRow = {
  display: number;
  agentId: string;
  lit: boolean;
  idle: boolean;
  protected: boolean;
  busyReason: DesktopBusyReason | null;
};

export type DesktopWorld = {
  nowMs: number;
  assignments: Record<string, number>;
  names: Record<string, string>;
  litDisplays: ReadonlySet<number>;
  displayStartedAtMs: Record<number, number>;
  transcriptWrittenAtMs: Record<string, number>;
  busyMarkers: ReadonlySet<number>;
  grokDisplays: ReadonlySet<number>;
  taskDisplays: ReadonlySet<number>;
  startWindowDisplays: ReadonlySet<number>;
};

export type DesktopPolicy = {
  minIdleMs: number;
  minDisplayAgeMs: number;
  floorAgentIds: readonly string[];
  keepAgentIds: readonly string[];
};

export type DesktopPruneOutcome = "planned" | "stopped" | "kept" | "raced" | "busy";

export type DesktopPruneRow = {
  display: number;
  agentId: string;
  outcome: DesktopPruneOutcome;
  busyReason: DesktopBusyReason | null;
};

export function classifyDesktop(world: DesktopWorld, policy: DesktopPolicy): DesktopRow[] {
  const keep = new Set([...policy.floorAgentIds, ...policy.keepAgentIds]);
  const rows: DesktopRow[] = [];
  const entries = Object.entries(world.assignments)
    .filter(([, display]) => Number.isInteger(display) && display >= 1)
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  for (const [agentId, display] of entries) {
    const lit = world.litDisplays.has(display);
    const isProtected = display <= MAIN_DISPLAY || keep.has(agentId);
    let busyReason: DesktopBusyReason | null = null;
    if (isProtected) busyReason = "protected";
    else if (!lit) busyReason = "dark";
    else if (world.startWindowDisplays.has(display)) busyReason = "start-window";
    else if (world.busyMarkers.has(display)) busyReason = "busy-marker";
    else if (world.grokDisplays.has(display)) busyReason = "grok";
    else if (world.taskDisplays.has(display)) busyReason = "task";
    else if (world.nowMs - (world.displayStartedAtMs[display] ?? world.nowMs) < policy.minDisplayAgeMs) {
      busyReason = "fresh-display";
    } else if (world.nowMs - (world.transcriptWrittenAtMs[agentId] ?? 0) < policy.minIdleMs) {
      busyReason = "recent-transcript";
    }
    const idle = lit && !isProtected && busyReason === null;
    rows.push({
      display,
      agentId,
      lit,
      idle,
      protected: isProtected,
      busyReason: idle ? null : busyReason,
    });
  }
  return rows;
}

export function displayFromEnviron(environ: string): number | undefined {
  for (const part of environ.split("\0")) {
    const match = /^DISPLAY=:([0-9]+)$/.exec(part);
    if (!match) continue;
    const display = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(display) && display >= 1) return display;
  }
  return undefined;
}

export function inspectDesktopProc(cmdline: string): {
  grok: boolean;
  task: boolean;
  startWindow: number | undefined;
} {
  const args = cmdline.split("\0").filter((part) => part.length > 0);
  const text = args.join(" ");
  let startWindow = NaN;
  for (const [index, arg] of args.entries()) {
    if (arg === "start-window" || arg.endsWith("/start-window") || arg.endsWith("/start-window.sh")) {
      startWindow = Number.parseInt(args[index + 1] ?? "", 10);
      break;
    }
  }
  const argv0 = args[0] ?? "";
  const slash = Math.max(argv0.lastIndexOf("/"), argv0.lastIndexOf("\\"));
  const base = argv0.slice(slash + 1);
  const grok = base === "grok" || args.some((arg) => arg === "grok" || arg.endsWith("/grok"));
  const taskTool = /\bTask\(/.test(text);
  return {
    grok,
    task: taskTool,
    startWindow: Number.isInteger(startWindow) && startWindow >= 2 ? startWindow : undefined,
  };
}

export function resolveDesktopAgent(ref: string, world: DesktopWorld): string | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return undefined;
  if (world.assignments[trimmed] !== undefined) return trimmed;
  const lowered = trimmed.toLowerCase();
  const matches = Object.entries(world.names)
    .filter(([, name]) => name.toLowerCase() === lowered)
    .map(([id]) => id);
  if (matches.length === 1) return matches[0];
  return undefined;
}

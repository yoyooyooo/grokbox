import { BoxRuntimeError } from "./errors.ts";
import type { RuntimeStatus } from "./observe.ts";

export type RuntimeStartMode = "observe" | "identity" | "route";

export type RuntimeStartWatchdog = {
  watchdogState: string;
  reconcile: string;
  reason: string | null;
  circuit: string;
};

export type RuntimeStartResult = {
  process: "start";
  desired: RuntimeStartMode;
  inject: false;
  reAdopt: false;
  takesEffect: "next_user_turn";
  modeld: { ready: boolean; started: boolean; alreadyRunning: boolean };
  watchdog: { ran: boolean; state: string | null; reconcile: string | null; reason: string | null; circuit: string | null };
  status: RuntimeStatus;
};

export function parseRuntimeStartMode(mode: string | undefined): RuntimeStartMode {
  if (mode !== "observe" && mode !== "identity" && mode !== "route") {
    throw new BoxRuntimeError("invalid_usage", "runtime start --mode must be observe, identity, or route.");
  }
  return mode;
}

export function watchdogRequiredForStart(mode: RuntimeStartMode): boolean {
  return mode === "identity" || mode === "route";
}

/**
 * Probe+start modeld, write desired, optional one watchdog tick, then status.
 * Tick runs after activate so identity/route see the new desired. Never re-adopts.
 */
export async function prepareRuntimeStart(input: {
  mode: RuntimeStartMode;
  probeModeld: () => Promise<boolean>;
  startModeld: () => Promise<void>;
  activate: (mode: RuntimeStartMode) => Promise<void>;
  tickWatchdog?: () => Promise<RuntimeStartWatchdog>;
  status: () => Promise<RuntimeStatus>;
}): Promise<RuntimeStartResult> {
  let alreadyRunning = await input.probeModeld();
  let started = false;
  if (!alreadyRunning) {
    try {
      await input.startModeld();
      started = true;
    } catch (error) {
      if (await input.probeModeld()) alreadyRunning = true;
      else throw error;
    }
  }
  const ready = await input.probeModeld();
  if (!ready) throw new BoxRuntimeError("invalid_usage", "modeld did not become ready.");

  await input.activate(input.mode);

  let watchdog: RuntimeStartResult["watchdog"] = {
    ran: false, state: null, reconcile: null, reason: null, circuit: null,
  };
  if (watchdogRequiredForStart(input.mode)) {
    if (!input.tickWatchdog) throw new BoxRuntimeError("invalid_usage", "runtime start requires a watchdog tick for identity/route.");
    const tick = await input.tickWatchdog();
    watchdog = {
      ran: true,
      state: tick.watchdogState,
      reconcile: tick.reconcile,
      reason: tick.reason,
      circuit: tick.circuit,
    };
  }

  return {
    process: "start",
    desired: input.mode,
    inject: false,
    reAdopt: false,
    takesEffect: "next_user_turn",
    modeld: { ready, started, alreadyRunning },
    watchdog,
    status: await input.status(),
  };
}

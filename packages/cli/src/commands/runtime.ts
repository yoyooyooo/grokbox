import {
  applyReset,
  applyUse,
  assertBoxLocal,
  assertResetAllowed,
  assertRouteAssignment,
  BoxRuntimeError,
  disclosure,
  openRuntimeStore,
  parseModelId,
  projectLiveStatus,
  readContracts,
  readEvents,
  liveH3AdoptAdapter,
  runManualReadopt,
  runWatchdogTick,
  wireLiveManualReadopt,
  type DesiredMode,
} from "@grokbox/box-runtime";

export { liveH3AdoptAdapter };
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";

function rethrow(error: unknown): never {
  if (error instanceof BoxRuntimeError) {
    throw new CliError(error.code, error.message);
  }
  throw error;
}

function store(deps: CliDeps) {
  assertBoxLocal({
    sshHost: deps.sshHost,
    daemonServerUrl: deps.daemonServerUrl,
    transport: deps.transport,
    profileName: deps.profileName,
  });
  return openRuntimeStore(deps.boxRuntimeRoot, deps.env);
}

export async function runRuntimeStatus(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    writeSuccess(deps.stdout, await projectLiveStatus({
      root: runtime.root,
      desired: await runtime.loadDesired(),
      models: await runtime.loadModels(),
    }));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeActivate(deps: CliDeps, mode: string | undefined): Promise<void> {
  try {
    if (mode !== "observe" && mode !== "identity" && mode !== "route") {
      throw new CliError("invalid_usage", "activate --mode must be observe, identity, or route.");
    }
    const runtime = store(deps);
    const models = await runtime.loadModels();
    if (mode === "route") assertRouteAssignment(models);
    const desiredMode: DesiredMode = mode;
    await runtime.saveDesired({ version: 1, mode: desiredMode });
    writeSuccess(deps.stdout, {
      desired: desiredMode,
      inject: false,
      takesEffect: "next_user_turn",
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeDeactivate(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    await runtime.saveDesired({ version: 1, mode: "disabled" });
    writeSuccess(deps.stdout, {
      desired: "disabled",
      requested: true,
      chain: "desired-disabled",
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeLog(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    writeSuccess(deps.stdout, { events: await readEvents(runtime.root) });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeContracts(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    writeSuccess(deps.stdout, await readContracts(runtime.root));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModelsCheck(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    const models = await runtime.loadModels();
    writeSuccess(deps.stdout, { ok: true, models: Object.keys(models.models), assignments: models.assignments });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModelsList(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    const models = await runtime.loadModels();
    writeSuccess(deps.stdout, models);
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModelsUse(
  deps: CliDeps,
  modelId: string,
  forAgent: string | undefined,
): Promise<void> {
  try {
    parseModelId(modelId);
    const runtime = store(deps);
    const next = applyUse(await runtime.loadModels(), modelId, forAgent);
    await runtime.saveModels(next);
    writeSuccess(deps.stdout, disclosure(next, modelId, forAgent));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModelsReset(deps: CliDeps, forAgent: string | undefined): Promise<void> {
  try {
    const runtime = store(deps);
    assertResetAllowed(await runtime.loadDesired());
    const next = applyReset(await runtime.loadModels(), forAgent);
    await runtime.saveModels(next);
    writeSuccess(deps.stdout, { assignments: next.assignments });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeReAdopt(deps: CliDeps, confirmed: boolean | undefined): Promise<void> {
  try {
    if (confirmed !== true) {
      throw new CliError("invalid_usage", "runtime re-adopt requires --confirm.");
    }
    const runtime = store(deps);
    const wired = wireLiveManualReadopt({ root: runtime.root, now: deps.now });
    const result = await runManualReadopt({
      confirmed: true,
      root: runtime.root,
      desired: await runtime.loadDesired(),
      models: await runtime.loadModels(),
      now: deps.now,
      ...wired,
    });
    writeSuccess(deps.stdout, {
      process: "re-adopt",
      confirmed: true,
      attempts: 1,
      reconcile: result.reconcile,
      reason: result.reason,
      attemptKey: result.attemptKey,
      injected: result.injected,
      signaled: result.signaled,
      circuit: result.circuit,
      origin: result.origin,
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeWatchdog(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    const result = await runWatchdogTick({
      root: runtime.root,
      desired: await runtime.loadDesired(),
      models: await runtime.loadModels(),
      now: deps.now,
    });
    writeSuccess(deps.stdout, {
      process: "watchdog",
      state: result.watchdogState,
      reconcile: result.reconcile,
      reason: result.reason,
      attemptKey: result.attemptKey,
      inject: false,
      signaled: false,
      circuit: result.circuit,
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModeld(deps: CliDeps): Promise<void> {
  try {
    store(deps);
    writeSuccess(deps.stdout, { process: "modeld", state: "idle", provider: false });
  } catch (error) {
    rethrow(error);
  }
}

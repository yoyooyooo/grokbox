import { dirname, isAbsolute, resolve } from "node:path";
import {
  applyReset,
  applyUse,
  assertBoxLocal,
  assertResetAllowed,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  BoxRuntimeError,
  disclosure,
  ephemeralRuntimeRoot,
  openRuntimeStore,
  parseModelId,
  projectLiveStatus,
  readContracts,
  observeEvents,
  liveH3AdoptAdapter,
  reviewedProfilePath,
  runManualReadopt,
  parseRuntimeStartMode,
  prepareRuntimeStart,
  probeStubModeld,
  runWatchdogTick,
  startStubModeldServer,
  STUB_ECHO_MODEL_ID,
  watchdogRequiredForStart,
  wireLiveManualReadopt,
  writeReviewedProfileFromCopy,
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

export async function runRuntimeStart(deps: CliDeps, mode: string | undefined): Promise<void> {
  try {
    const parsed = parseRuntimeStartMode(mode);
    const runtime = store(deps);
    const models = await runtime.loadModels();
    if (parsed === "route") assertRouteAssignment(models);
    const runRoot = deps.env.GROKBOX_RUN_ROOT ?? ephemeralRuntimeRoot();
    const payload = await prepareRuntimeStart({
      mode: parsed,
      probeModeld: () => probeStubModeld(runRoot),
      startModeld: async () => {
        // Same listen path as `modeld run`; do not wait() — return readiness. Never re-adopt.
        await startStubModeldServer({ runRoot, durableRoot: runtime.root, signal: deps.signal });
      },
      activate: async (desired) => {
        await runtime.saveDesired({ version: 1, mode: desired });
      },
      ...(watchdogRequiredForStart(parsed) ? {
        tickWatchdog: async () => await runWatchdogTick({
          root: runtime.root,
          desired: await runtime.loadDesired(),
          models: await runtime.loadModels(),
          now: deps.now,
        }),
      } : {}),
      status: async () => await projectLiveStatus({ root: runtime.root, ephemeralRoot: runRoot }),
    });
    writeSuccess(deps.stdout, payload);
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

export async function runRuntimeLog(deps: CliDeps, follow = false): Promise<void> {
  try {
    const runtime = store(deps);
    if (follow) throw new CliError("invalid_usage", "runtime log --follow is not supported; omit --follow for a bounded snapshot.");
    writeSuccess(deps.stdout, await observeEvents(runtime.root));
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
    writeSuccess(deps.stdout, { ok: true, checked: ["schema"], serviceReadiness: "not_checked", models: Object.keys(models.models), assignments: models.assignments });
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
    const desired = await runtime.loadDesired();
    const next = applyUse(await runtime.loadModels(), modelId, forAgent);
    if (desired.mode === "route") assertStubOnlyRouteAssignments(next);
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
    const desired = await runtime.loadDesired();
    const wired = wireLiveManualReadopt({ root: runtime.root, now: deps.now, mode: desired.mode });
    const result = await runManualReadopt({
      confirmed: true,
      root: runtime.root,
      desired,
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
      ...(result.committedAttestation ? { committedAttestation: {
        mode: result.committedAttestation.mode,
        pid: result.committedAttestation.pid,
        start: result.committedAttestation.start,
        diskSha: result.committedAttestation.diskSha,
        operationId: result.committedAttestation.operationId,
        compile: result.committedAttestation.compile,
        at: result.committedAttestation.at,
      } } : {}),
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
    const runtime = store(deps);
    const runRoot = deps.env.GROKBOX_RUN_ROOT ?? ephemeralRuntimeRoot();
    const server = await startStubModeldServer({ runRoot, durableRoot: runtime.root, signal: deps.signal });
    writeSuccess(deps.stdout, {
      process: "modeld",
      state: "running",
      provider: false,
      model: STUB_ECHO_MODEL_ID,
    });
    const stop = () => { void server.stop(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try { await server.wait(); }
    finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfileWrite(deps: CliDeps, fromPath: string | undefined): Promise<void> {
  try {
    if (!fromPath || fromPath.trim().length === 0) {
      throw new CliError("invalid_usage", "runtime profile write requires --from <host-bundle>.");
    }
    if (!isAbsolute(fromPath)) {
      throw new CliError("invalid_usage", "--from must be an absolute Host bundle path.");
    }
    const hostBundle = resolve(fromPath);
    const runtime = store(deps);
    const destDir = dirname(reviewedProfilePath(runtime.root));
    let written;
    try {
      written = await writeReviewedProfileFromCopy({
        destDir,
        hostBundle,
        profileId: "reviewed-copy",
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "ENOENT") {
        throw new CliError("invalid_usage", "Profile authoring input or destination is unavailable.");
      }
      throw error;
    }
    writeSuccess(deps.stdout, {
      process: "profile-write",
      offline: true,
      signaled: false,
      inject: false,
      profilePath: written.profilePath,
      profileId: written.profile.profileId,
      sourceSha256: written.sourceSha256,
      transformedSourceSha256: written.transformedSourceSha256,
      diskSha: written.diskSha,
      hostBundle,
    });
  } catch (error) {
    rethrow(error);
  }
}

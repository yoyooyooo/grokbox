import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyReset,
  applyUse,
  assertBoxLocal,
  assertResetAllowed,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  BoxRuntimeError,
  disclosure,
  openRuntimeStore,
  parseModelId,
  projectLiveStatus,
  readContracts,
  observeEvents,
  reviewedProfilePath,
  controllerOperationId,
  diskPreloadSha256,
  reviewedProfileSha256,
  runtimeNotReady,
  startControlOperation,
  startModeldProcess,
  writeReviewedProfileFromCopy,
  observeHostProvenance,
  applyRetentionPlan,
  readRetentionPlanFile,
  watchHostSeamOnce,
  type DesiredMode,
} from "@grokbox/box-runtime/runtime";
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

export async function runRuntimeStart(deps: CliDeps, _mode: string | undefined): Promise<void> {
  try {
    store(deps);
    runtimeNotReady("runtime start / modeld", "T26");
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
    const preloadSha256 = diskPreloadSha256();
    const profileSha256 = reviewedProfileSha256(runtime.root);
    const receipt = await startControlOperation({
      intent: "apply",
      confirmed: true,
      operationId: controllerOperationId("apply", runtime.root, {
        ...(preloadSha256 ? { preloadSha256 } : {}),
        ...(profileSha256 ? { profileSha256 } : {}),
      }),
      boxRoot: runtime.root,
    });
    writeSuccess(deps.stdout, receipt);
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeWatchdog(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    const receipt = await startControlOperation({
      intent: "reconcile",
      confirmed: false,
      operationId: controllerOperationId("reconcile", runtime.root),
      boxRoot: runtime.root,
    });
    writeSuccess(deps.stdout, receipt);
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModeld(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    const runRoot = typeof deps.env.GROKBOX_RUN_ROOT === "string" && deps.env.GROKBOX_RUN_ROOT.length > 0
      ? deps.env.GROKBOX_RUN_ROOT
      : join(homedir(), ".grokbox", "run");
    const started = await startModeldProcess({ durableRoot: runtime.root, runRoot, env: deps.env });
    writeSuccess(deps.stdout, {
      process: "modeld",
      kind: started.ensure.kind,
      path: started.ensure.path,
      generation: started.ensure.kind === "owned" ? started.ensure.generation : undefined,
    });
    if (started.ensure.kind === "borrowed") return;
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void started.stop().finally(resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfileObserve(deps: CliDeps, fromPath: string | undefined): Promise<void> {
  try {
    if (!fromPath || fromPath.trim().length === 0) {
      throw new CliError("invalid_usage", "runtime profile observe requires --from <host-bundle>.");
    }
    if (!isAbsolute(fromPath)) {
      throw new CliError("invalid_usage", "--from must be an absolute Host bundle path.");
    }
    const runtime = store(deps);
    const receipt = await observeHostProvenance({ root: runtime.root, from: resolve(fromPath) });
    writeSuccess(deps.stdout, {
      process: "profile-observe",
      offline: true,
      ...receipt,
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfilePrune(
  deps: CliDeps,
  planPath: string | undefined,
  confirmed: boolean | undefined,
): Promise<void> {
  try {
    if (!planPath || planPath.trim().length === 0) {
      throw new CliError("invalid_usage", "runtime profile prune requires --plan <abs>.");
    }
    if (!isAbsolute(planPath)) {
      throw new CliError("invalid_usage", "--plan must be an absolute path.");
    }
    const runtime = store(deps);
    const plan = await readRetentionPlanFile(planPath);
    const liveSha = plan.head ?? plan.protectedShas[0];
    if (!liveSha) throw new CliError("invalid_usage", "retention plan has no live SHA.");
    const result = await applyRetentionPlan({
      root: runtime.root,
      plan,
      confirm: confirmed === true,
      liveSha,
    });
    writeSuccess(deps.stdout, {
      process: "profile-prune",
      signaled: false,
      adopted: false,
      ...result,
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfileWatch(
  deps: CliDeps,
  once: boolean | undefined,
  fromPath: string | undefined,
): Promise<void> {
  try {
    if (once !== true) {
      throw new CliError("invalid_usage", "runtime profile watch requires --once until the long-running watcher lands.");
    }
    if (fromPath && !isAbsolute(fromPath)) {
      throw new CliError("invalid_usage", "--from must be an absolute Host bundle path.");
    }
    const runtime = store(deps);
    const receipt = await watchHostSeamOnce({
      root: runtime.root,
      ...(fromPath ? { from: resolve(fromPath) } : {}),
    });
    writeSuccess(deps.stdout, receipt);
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
        profileId: "reviewed-copy-envelope",
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

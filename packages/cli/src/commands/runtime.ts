import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertBoxLocal,
  changeRuntimeModel,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  BoxRuntimeError,
  disclosure,
  openRuntimeStore,
  saveRuntimeModels,
  persistModelCredential,
  saveRuntimeDesired,
  parseModelId,
  projectLiveStatus,
  readContracts,
  observeRuntimeEvents,
  reviewedProfilePath,
  controllerOperationId,
  diskPreloadSha256,
  reviewedProfileSha256,
  startRuntimeCommand,
  startControlOperation,
  startModeldProcess,
  writeReviewedProfileFromCopy,
  observeHostProvenance,
  applyRetentionPlan,
  readRetentionPlanFile,
  watchHostSeamOnce,
  replayHostSeam,
  assertReplayCoverage,
  writeReplayReport,
  projectHostSeamStatus,
  proposeFromSource,
  readProposeSource,
  writeCandidateArtifact,
  proposeSummary,
  createAnalysisSession,
  writeAnalysisArtifact,
  readLastReplayReport,
  type DesiredMode,
} from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { runtimeOwnershipReader } from "../runtime-ownership.ts";

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

function runtimeRunRoot(deps: CliDeps): string {
  const configured = deps.env.GROKBOX_RUN_ROOT;
  return typeof configured === "string" && configured.length > 0 ? configured : join(homedir(), ".grokbox", "run");
}

export async function runRuntimeStatus(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    writeSuccess(deps.stdout, await projectLiveStatus({
      root: runtime.root,
      ...(deps.env.GROKBOX_RUN_ROOT ? { ephemeralRoot: deps.env.GROKBOX_RUN_ROOT } : {}),
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
    await saveRuntimeDesired(runtime, { version: 1, mode: desiredMode });
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
  const fallback = deps.signal ? undefined : new AbortController();
  const signal = deps.signal ?? fallback!.signal;
  const abort = () => fallback?.abort();
  if (fallback) { process.on("SIGINT", abort); process.on("SIGTERM", abort); }
  try {
    const runtime = store(deps);
    const runRoot = runtimeRunRoot(deps);
    await startRuntimeCommand({ store: runtime, runRoot, mode, signal, env: deps.env,
      ownershipRead: runtimeOwnershipReader(deps), publish: receipt => writeSuccess(deps.stdout, receipt) });
  } catch (error) {
    rethrow(error);
  } finally {
    if (fallback) { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
  }
}

export async function runRuntimeDeactivate(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    await saveRuntimeDesired(runtime, { version: 1, mode: "disabled" });
    writeSuccess(deps.stdout, {
      desired: "disabled",
      requested: true,
      chain: "desired-disabled",
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeLog(deps: CliDeps, follow = false, source = "control"): Promise<void> {
  try {
    const runtime = store(deps);
    if (follow) throw new CliError("invalid_usage", "runtime log --follow is not supported; omit --follow for a bounded snapshot.");
    if (source !== "control" && source !== "host") throw new CliError("invalid_usage", "runtime log --source must be control or host.");
    writeSuccess(deps.stdout, await observeRuntimeEvents({
      durableRoot: runtime.root,
      runRoot: deps.env.GROKBOX_RUN_ROOT,
      source,
    }));
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
    writeSuccess(deps.stdout, await changeRuntimeModel({ store: runtime, modelId, forAgent,
      ownershipRead: runtimeOwnershipReader(deps), signal: deps.signal }));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModelsPersistKey(deps: CliDeps, modelId: string, piProvider: string | undefined, confirmed: boolean | undefined): Promise<void> {
  try {
    const runtime = store(deps);
    if (!piProvider) throw new CliError("invalid_usage", "models persist-key requires --from-pi <provider>.");
    writeSuccess(deps.stdout, await persistModelCredential({
      store: runtime, modelId, piProvider, confirmed: confirmed === true, signal: deps.signal,
    }));
  } catch (error) { rethrow(error); }
}

export async function runRuntimeModelsReset(deps: CliDeps, forAgent: string | undefined): Promise<void> {
  try {
    const runtime = store(deps);
    writeSuccess(deps.stdout, await changeRuntimeModel({ store: runtime, forAgent,
      ownershipRead: runtimeOwnershipReader(deps), signal: deps.signal }));
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
  // The published entry already translates process signals into deps.signal.
  // Install a local owner only for embedders that did not supply one.
  const fallback = deps.signal ? undefined : new AbortController();
  const signal = deps.signal ?? fallback!.signal;
  const abort = () => fallback?.abort();
  if (fallback) { process.on("SIGINT", abort); process.on("SIGTERM", abort); }
  let started: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    const runtime = store(deps);
    const runRoot = runtimeRunRoot(deps);
    started = await startModeldProcess({ durableRoot: runtime.root, runRoot, env: deps.env,
      ownershipRead: runtimeOwnershipReader(deps), signal });
    writeSuccess(deps.stdout, {
      process: "modeld",
      kind: started.ensure.kind,
      path: started.ensure.path,
      generation: started.ensure.kind === "owned" ? started.ensure.generation : undefined,
    });
    if (started.ensure.kind === "borrowed") return;
    // The actual resource lifetime settles after cleanup. It can fail without
    // another user signal (listener loss), so do not wait only for SIGTERM.
    await started.finished;
    if (!signal.aborted) throw new BoxRuntimeError("invalid_usage", "modeld_stopped_unexpectedly");
  } catch (error) {
    rethrow(error);
  } finally {
    if (fallback) { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    // Output failure is also an exit path. Cleanup must be awaited and errors
    // reported, not discarded by stop().finally(resolve).
    if (started?.ensure.kind === "owned") {
      try { await started.stop(); } catch (error) { rethrow(error); }
    }
  }
}

export async function runRuntimeProfilePropose(
  deps: CliDeps,
  fromPath: string | undefined,
  outPath: string | undefined,
  against: string | undefined,
): Promise<void> {
  try {
    if (!fromPath || !isAbsolute(fromPath)) {
      throw new CliError("invalid_usage", "runtime profile propose requires --from <abs>.");
    }
    if (!outPath || !isAbsolute(outPath)) {
      throw new CliError("invalid_usage", "runtime profile propose requires --out <abs>.");
    }
    store(deps);
    const source = await readProposeSource(resolve(fromPath));
    const baseline = against && /^[a-f0-9]{64}$/.test(against)
      ? { sourceSha256: against, reviewedProfileSha256: "0".repeat(64) }
      : null;
    const artifact = proposeFromSource(source, baseline);
    const written = await writeCandidateArtifact(resolve(outPath), resolve(fromPath), artifact);
    writeSuccess(deps.stdout, proposeSummary(artifact, written));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfileAnalyze(
  deps: CliDeps,
  sha: string | undefined,
  outPath: string | undefined,
): Promise<void> {
  try {
    if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
      throw new CliError("invalid_usage", "runtime profile analyze requires --sha <sha>.");
    }
    if (!outPath || !isAbsolute(outPath)) {
      throw new CliError("invalid_usage", "runtime profile analyze requires --out <abs>.");
    }
    const runtime = store(deps);
    const last = await readLastReplayReport(runtime.root);
    const session = createAnalysisSession();
    const result = await session.run({
      analysis: {
        sourceSha: sha,
        evidenceDigest: last?.replayKey ?? sha,
        workKey: `analyze:${sha}`,
        episodeRevision: 1,
        mechanical: {
          supportGatePassed: last?.supportGatePassed ?? false,
          codes: last?.codes ?? [],
          candidateCount: 0,
        },
      },
      runner: false,
      port: null,
    });
    await writeAnalysisArtifact(resolve(outPath), result);
    writeSuccess(deps.stdout, result);
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

export async function runRuntimeProfileReplay(
  deps: CliDeps,
  sha: string | undefined,
  all: boolean | undefined,
): Promise<void> {
  try {
    if (Boolean(sha) === Boolean(all)) {
      throw new CliError("invalid_usage", "runtime profile replay requires exactly one of --sha <sha> or --all.");
    }
    const runtime = store(deps);
    const report = await replayHostSeam({
      root: runtime.root,
      ...(sha ? { sha } : { all: true }),
    });
    assertReplayCoverage(report);
    await writeReplayReport(runtime.root, report);
    writeSuccess(deps.stdout, {
      process: "profile-replay",
      signaled: false,
      adopted: false,
      ...report,
    });
    if (!report.supportGatePassed || report.codes.includes("corpus_corrupt") || report.codes.includes("missing_profile") || report.corpus === "missing") {
      throw new CliError("runtime_unsupported", "Host seam replay support gate failed.");
    }
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeProfileStatus(deps: CliDeps, sha: string | undefined): Promise<void> {
  try {
    const runtime = store(deps);
    const facets = await projectHostSeamStatus({ root: runtime.root, ...(sha ? { sha } : {}) });
    writeSuccess(deps.stdout, {
      process: "profile-status",
      signaled: false,
      adopted: false,
      ...facets,
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

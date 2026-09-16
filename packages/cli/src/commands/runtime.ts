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
  observeModeldService,
  replaceModeld,
  readContracts,
  observeRuntimeEvents,
  maintainObservationJournals,
  reviewedProfilePath,
  controllerOperationId,
  diskPreloadSha256,
  reviewedProfileSha256,
  startRuntimeCommand,
  startControlOperation,
  startModeldProcess,
  stopLivePatchedHost,
  writeReviewedProfileFromCopy,
  ProfileWriteRefused,
  retainedGenerationSourcePath,
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
  attachWriteEnvelopeInspect,
  inspectRetainedWriteEnvelope,
  readLastReplayReport,
  type DesiredMode,
  type IdentityOpResult,
} from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { LIVE_HOST_BUNDLE_PATH } from "../host-source.ts";
import { GatewayClient } from "../gateway.ts";
import { asString, isRecord } from "../util.ts";
import { findRosterRow } from "./roster.ts";
import { writeSuccess } from "../output.ts";
import { runtimeOwnershipReader } from "../runtime-ownership.ts";
import { paintTitleAfterModelAssignment } from "../title-sync.ts";

function rethrow(error: unknown): never {
  if (error instanceof ProfileWriteRefused) {
    throw new CliError(error.code, error.message, { next: error.next });
  }
  if (error instanceof BoxRuntimeError) {
    throw new CliError(error.code, error.message, { next: error.next, failureCode: error.failureCode });
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

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveBotId(deps: CliDeps, target: string): Promise<string> {
  const query = target.trim();
  if (AGENT_ID.test(query)) return query.toLowerCase();
  const { agents } = await new GatewayClient(deps).listAgents(10_000);
  return asString(findRosterRow(agents, query, ["agent"]).id);
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
    writeSuccess(deps.stdout, await writeDesiredDisabled(deps));
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
    const agentId = forAgent === undefined ? undefined : await resolveBotId(deps, forAgent);
    const selection = await changeRuntimeModel({ store: runtime, modelId, forAgent: agentId,
      ownershipRead: runtimeOwnershipReader(deps), signal: deps.signal, env: deps.env });
    writeSuccess(deps.stdout, {
      ...selection,
      ...(agentId ? { title: await paintTitleAfterModelAssignment(new GatewayClient(deps), {
        agentId, boxRuntimeRoot: deps.boxRuntimeRoot, env: deps.env, mode: "custom",
      }) } : {}),
    });
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
    const agentId = forAgent === undefined ? undefined : await resolveBotId(deps, forAgent);
    const selection = await changeRuntimeModel({ store: runtime, forAgent: agentId,
      ownershipRead: runtimeOwnershipReader(deps), signal: deps.signal });
    writeSuccess(deps.stdout, {
      ...selection,
      ...(agentId ? { title: await paintTitleAfterModelAssignment(new GatewayClient(deps), {
        agentId, boxRuntimeRoot: deps.boxRuntimeRoot, env: deps.env, mode: "official",
      }) } : {}),
    });
  } catch (error) {
    rethrow(error);
  }
}

export const hostControlPorts = {
  apply: startControlOperation,
  stopPatched: stopLivePatchedHost,
};

function runRootOf(deps: CliDeps): string | undefined {
  const configured = deps.env.GROKBOX_RUN_ROOT;
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

export async function ensureHostStartDesired(deps: CliDeps): Promise<DesiredMode> {
  const runtime = store(deps);
  const desired = await runtime.loadDesired();
  if (desired.mode !== "disabled") return desired.mode;
  await saveRuntimeDesired(runtime, { version: 1, mode: "route" });
  return "route";
}

async function writeDesiredDisabled(deps: CliDeps): Promise<unknown> {
  const runtime = store(deps);
  await saveRuntimeDesired(runtime, { version: 1, mode: "disabled" });
  return {
    desired: "disabled",
    requested: true,
    host: "desired-disabled",
  };
}

export async function applyHostEnable(deps: CliDeps): Promise<unknown> {
  const runtime = store(deps);
  await ensureHostStartDesired(deps);
  const preloadSha256 = diskPreloadSha256();
  const profileSha256 = reviewedProfileSha256(runtime.root);
  return await hostControlPorts.apply({
    intent: "apply",
    confirmed: true,
    operationId: controllerOperationId("apply", runtime.root, {
      ...(preloadSha256 ? { preloadSha256 } : {}),
      ...(profileSha256 ? { profileSha256 } : {}),
    }),
    boxRoot: runtime.root,
  });
}

function hostStopFailed(code: string): CliError {
  return new CliError(
    "host_mismatch",
    `Host stop did not reach official coverage (${code}). Next: grokbox doctor`,
    { next: "grokbox doctor", hostReason: code },
  );
}

export async function applyHostDisable(deps: CliDeps): Promise<unknown> {
  const runtime = store(deps);
  const previous = await runtime.loadDesired();
  await saveRuntimeDesired(runtime, { version: 1, mode: "disabled" });
  let stopped: IdentityOpResult;
  try {
    stopped = await hostControlPorts.stopPatched({
      ...(runRootOf(deps) ? { ephemeralRoot: runRootOf(deps) } : {}),
    });
  } catch (error) {
    if (previous.mode !== "disabled") {
      await saveRuntimeDesired(runtime, previous).catch(() => undefined);
    }
    throw error;
  }
  if (!stopped.ok) {
    if (previous.mode !== "disabled") {
      await saveRuntimeDesired(runtime, previous).catch(() => undefined);
    }
    throw hostStopFailed(stopped.code ?? "unproven");
  }
  return {
    desired: "disabled",
    requested: true,
    signaled: stopped.signaled,
    coverage: stopped.coverage,
    host: "official",
  };
}

export async function runRuntimeReAdopt(deps: CliDeps, confirmed: boolean | undefined): Promise<void> {
  try {
    if (confirmed !== true) {
      throw new CliError("invalid_usage", "runtime re-adopt requires --confirm.");
    }
    writeSuccess(deps.stdout, await applyHostEnable(deps));
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeWatchdog(deps: CliDeps): Promise<void> {
  try {
    const runtime = store(deps);
    // Log maintenance belongs to this explicit writer command, not status,
    // incident queries, Host inference or modeld. Include the actual run root.
    const observationMaintenance = await maintainObservationJournals({ durableRoot: runtime.root, runRoot: deps.env.GROKBOX_RUN_ROOT });
    const receipt = await startControlOperation({
      intent: "reconcile",
      confirmed: false,
      operationId: controllerOperationId("reconcile", runtime.root),
      boxRoot: runtime.root,
    });
    writeSuccess(deps.stdout, { ...receipt, observationMaintenance });
  } catch (error) {
    rethrow(error);
  }
}

export async function runRuntimeModeldReplace(deps: CliDeps, raw: { confirm?: boolean; expectEpoch?: string }): Promise<void> {
  const runtime = store(deps);
  if (!raw.confirm || !raw.expectEpoch || !/^[a-f0-9-]{36}$/i.test(raw.expectEpoch)) throw new CliError("invalid_usage", "replace requires --confirm and --expect-epoch from modeld status");
  const roster = await new GatewayClient(deps).listAgents(10_000);
  const busy = roster.agents.filter(isRecord).some(a => a.harness === "box" && (a.isRunning === true || a.isRunningTurn === true));
  if (busy) throw new CliError("invalid_usage", "Managed Bots are running. Wait for them to settle before replacing modeld.");
  const entry = resolve(process.argv[1] ?? "");
  writeSuccess(deps.stdout, await replaceModeld({ durableRoot: runtime.root, runRoot: runtimeRunRoot(deps), expectedEpoch: raw.expectEpoch,
    confirmed: true, noManagedBotsRunning: true, entry, env: { ...process.env, ...deps.env } }));
}

export async function runRuntimeModeldStatus(deps: CliDeps): Promise<void> {
  const runtime = store(deps);
  const observed = await observeModeldService(runtime.root, runtimeRunRoot(deps));
  writeSuccess(deps.stdout, { ...observed, liveness: observed.serviceEpoch !== null ? "reachable" : observed.ready === false ? "unavailable" : "unknown",
    admission: observed.protocolCompatible === false ? "protocol_mismatch" : observed.ready !== true ? "not_observed"
      : observed.execution ? observed.execution.accepting ? "ready" : "blocked" : "not_observed",
    limits: "Read-only snapshot. Readiness is not a promise about provider availability, physical storage, or future admission." });
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
    const inspect = await inspectRetainedWriteEnvelope(runtime.root, sha);
    const result = attachWriteEnvelopeInspect(
      await session.run({
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
      }),
      inspect,
    );
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

const SHA = /^[a-f0-9]{64}$/;

function parseSliceReview(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set(parts)];
}

export async function runRuntimeProfileWrite(
  deps: CliDeps,
  options: {
    from?: string;
    sha?: string;
    allowUnretained?: boolean;
    confirm?: boolean;
    sliceReview?: string | string[];
  },
): Promise<void> {
  try {
    const fromPath = options.from?.trim() || undefined;
    const sha = options.sha?.trim() || undefined;
    const allowUnretained = options.allowUnretained === true;
    const confirmed = options.confirm === true;
    if (Boolean(sha) === Boolean(fromPath)) {
      throw new CliError(
        "invalid_usage",
        "runtime profile write requires exactly one of --sha <retainedSourceSha> or --from <host-bundle> --allow-unretained --confirm.",
      );
    }
    if (sha && (allowUnretained || fromPath)) {
      throw new CliError("invalid_usage", "runtime profile write --sha cannot be combined with --from / --allow-unretained.");
    }
    if (fromPath && (!allowUnretained || !confirmed)) {
      throw new CliError(
        "invalid_usage",
        "--from requires --allow-unretained --confirm. Escape waives retain bind only, never envelope reject-on-drift.",
        { next: `grokbox runtime profile observe --from ${fromPath}` },
      );
    }
    if (fromPath && !isAbsolute(fromPath)) {
      throw new CliError("invalid_usage", "--from must be an absolute Host bundle path.");
    }
    if (sha && !SHA.test(sha)) {
      throw new CliError("invalid_usage", "--sha must be a 64-character lowercase hex source digest.");
    }
    const runtime = store(deps);
    const destDir = dirname(reviewedProfilePath(runtime.root));
    const hostBundle = sha ? retainedGenerationSourcePath(runtime.root, sha) : resolve(fromPath!);
    const sliceReview = parseSliceReview(options.sliceReview);
    let written;
    try {
      written = await writeReviewedProfileFromCopy({
        destDir,
        hostBundle,
        profileId: "reviewed-copy-envelope",
        lineage: {
          root: runtime.root,
          ...(sha ? { retainedSha: sha } : { allowUnretained: true }),
          ...(sliceReview.length > 0 ? { sliceReview } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProfileWriteRefused) throw error;
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "ENOENT") {
        throw new CliError("invalid_usage", "Profile authoring input or destination is unavailable.", {
          next: sha
            ? `grokbox runtime profile observe --from ${LIVE_HOST_BUNDLE_PATH}`
            : `grokbox runtime profile observe --from ${hostBundle}`,
        });
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
      ...(written.unretained_source ? { unretained_source: true } : {}),
      ...(written.envelope ? { envelope: written.envelope } : {}),
    });
  } catch (error) {
    rethrow(error);
  }
}

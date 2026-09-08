import { readFile } from "node:fs/promises";
import { observeAttestation, routeAttestationAgrees } from "./attestation.ts";
import { observeContracts } from "./contracts.ts";
import { observeHostBundles } from "./host-bundles.ts";
import { observeCoordinatorState } from "./coordinator-state.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { observeEvents } from "./events.ts";
import { sha256Bytes } from "./hash.ts";
import { canonicalOwnershipAgrees } from "./identity-op.ts";
import { probeStubModeld } from "./modeld-ipc.ts";
import { LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { linuxProcessPort, procEnvHas, roleOf } from "./live-proc.ts";
import { parseDesiredFile, parseModelsFile, routeHasNonStubAssignment, routeModelAdmitted, STUB_ECHO_MODEL, STUB_ECHO_MODEL_ID, type DesiredFile, type ModelsFile } from "./models.ts";
import { boundedText, count, isRecord, observeJson, type Observation, type ObservationState } from "./observation.ts";
import { parseReviewedProfile } from "./reviewed-profile.ts";
import type { PatchProfile } from "./transform.ts";
import { findAdoptedHostState, findUniqueOfficialChain, type RoleClassifier } from "./official-chain.ts";
import { desiredPath, modelsPath, reviewedProfilePath } from "./paths.ts";
import { countRoles, singleOfficialChain, type ProcessPort } from "./process.ts";
import { adoptJournalNeedsRecovery, adoptOpStatePath, parseAdoptOpState } from "./transient-adopt.ts";

export type HostOrigin = "official" | "grokbox-attested" | "grokbox-unattested" | "ambiguous";
export type HostReason = null | "unmanaged_preload" | "stale_attestation" | "duplicate_role" | "missing_role" |
  "bad_parentage" | "invalid_attestation" | "source_unavailable" | "observation_unavailable" | "gateway_mismatch" | "gateway_unknown";
type EvidenceState = ObservationState | "partial" | "not_observed" | "provided";

export type RuntimeStatus = {
  installation: { durableRoot: string; cliInstallRootUnused: true };
  activation: {
    desired: DesiredFile["mode"] | null;
    actual: "official" | "identity" | "route" | "patched-unknown" | "unknown";
    reconcile: "converged" | "pending" | "recovery-required" | "unknown";
    reason: string | null;
  };
  host: { diskSha: string | null; origin: HostOrigin; reason: HostReason; topology: "direct" | "adopted" | "invalid" | "unknown" };
  coverage: "none" | "window-open" | "attested";
  census: { wrapper: number | null; supervisor: number | null; host: number | null };
  circuit: "closed" | "open" | "unknown";
  coordinator: { state: EvidenceState; mutationCount: number | null; lastAttemptKey: string | null; circuitReason: string | null };
  operation: { state: EvidenceState; phase: string | null; pending: boolean | null };
  lastHeal: null | { at: string; outcome: string };
  driftedSlices: string[] | null;
  contracts: { state: EvidenceState; head: string | null; sourceSha: string | null; diskMatchesHead: boolean | null };
  bundles: { state: EvidenceState; head: string | null; retained: number | null; liveRetained: boolean | null; lastMatchedSha: string | null };
  watchdog: { required: boolean; state: "stopped" | "running" | "degraded" | "unknown" };
  modeld: { required: boolean; state: "stopped" | "running" | "unknown" };
  models: { main: string | null; agents: Record<string, string>; assignmentState: "valid" | "invalid" | "unknown" };
  window: { durationMs: number | null; affectedInvocations: "unknown" };
  evidence: Record<"desired" | "models" | "source" | "processes" | "gateway" | "attestation" | "profile" | "events", EvidenceState>;
};

export type LiveStatusPorts = {
  processes?: ProcessPort;
  ephemeralRoot?: string;
  diskSha?: string | null;
  gatewayPid?: number | null;
  modeldReady?: () => boolean | Promise<boolean>;
  envHas?: (pid: number, key: string) => boolean;
  classify?: RoleClassifier;
  reviewedProfile?: PatchProfile;
};

/** Read-only adapter seams. Tests replace these instead of discovering a live Host. */
export const liveStatusAdapter = {
  runRoot: ephemeralRuntimeRoot,
  processes: linuxProcessPort,
  envHas: procEnvHas,
  modeldReady: probeStubModeld,
  diskSha: async (): Promise<Observation<string>> => {
    try { return { state: "present", value: sha256Bytes(await readFile(LIVE_HOST_BUNDLE)) }; }
    catch (error) { return { state: isRecord(error) && error.code === "ENOENT" ? "missing" : "unavailable" }; }
  },
  gatewayPid: () => observeJson("/home/box/sand-data/gateway.json", (value) => {
    if (!isRecord(value) || !count(value.pid) || value.pid === 0) throw new Error("invalid gateway pid");
    return value.pid;
  }),
};

const GROKBOX_TOUCH_ENV = ["GROKBOX_PRELOAD_MODE", "GROKBOX_OPERATION_ID", "GROKBOX_PRELOAD_MARKER"] as const;
const bad = (state: EvidenceState) => state === "invalid" || state === "unavailable";
const safeToken = (value: unknown): string | null => boundedText(value) && /^[a-zA-Z0-9_:.-]+$/.test(value) ? value : null;

function assignmentState(models: ModelsFile | null): RuntimeStatus["models"]["assignmentState"] {
  if (!models) return "unknown";
  return [models.assignments.main, ...Object.values(models.assignments.agents)].filter((id) => id !== null)
    .every((id) => id === STUB_ECHO_MODEL_ID || Object.hasOwn(models.models, id)) ? "valid" : "invalid";
}

export function projectStatus(input: { root: string; desired: DesiredFile | null; models: ModelsFile | null }): RuntimeStatus {
  const mode = input.desired?.mode ?? null;
  return {
    installation: { durableRoot: input.root, cliInstallRootUnused: true },
    activation: { desired: mode, actual: "unknown", reconcile: "unknown", reason: "not_observed" },
    host: { diskSha: null, origin: "ambiguous", reason: "observation_unavailable", topology: "unknown" },
    coverage: "none", census: { wrapper: null, supervisor: null, host: null },
    circuit: "unknown", coordinator: { state: "not_observed", mutationCount: null, lastAttemptKey: null, circuitReason: null },
    operation: { state: "not_observed", phase: null, pending: null },
    lastHeal: null, driftedSlices: null, contracts: { state: "not_observed", head: null, sourceSha: null, diskMatchesHead: null },
    bundles: { state: "not_observed", head: null, retained: null, liveRetained: null, lastMatchedSha: null },
    watchdog: { required: mode === "identity" || mode === "route", state: "unknown" },
    modeld: { required: mode === "route", state: "unknown" },
    models: { main: input.models?.assignments.main ?? null, agents: { ...input.models?.assignments.agents }, assignmentState: assignmentState(input.models) },
    window: { durationMs: null, affectedInvocations: "unknown" },
    evidence: { desired: "not_observed", models: "not_observed", source: "not_observed", processes: "not_observed",
      gateway: "not_observed", attestation: "not_observed", profile: "not_observed", events: "not_observed" },
  };
}

export async function projectLiveStatus(input: { root: string; desired?: DesiredFile; models?: ModelsFile } & LiveStatusPorts): Promise<RuntimeStatus> {
  const desired = input.desired ? { state: "present" as const, value: input.desired } : await observeJson(desiredPath(input.root), parseDesiredFile);
  const models = input.models ? { state: "present" as const, value: input.models } : await observeJson(modelsPath(input.root), parseModelsFile);
  const effectiveDesired = desired.state === "present" ? desired.value : desired.state === "missing" ? parseDesiredFile(undefined) : null;
  const effectiveModels = models.state === "present" ? models.value : models.state === "missing" ? parseModelsFile(undefined) : null;
  const status = projectStatus({ root: input.root, desired: effectiveDesired, models: effectiveModels });
  status.evidence.desired = input.desired ? "provided" : desired.state;
  status.evidence.models = input.models ? "provided" : models.state;
  const mode = status.activation.desired;
  const runRoot = input.ephemeralRoot ?? liveStatusAdapter.runRoot();
  const [attRead, profile, coordinator, journal, contracts, bundles, events] = await Promise.all([
    observeAttestation(runRoot),
    input.reviewedProfile ? Promise.resolve({ state: "present" as const, value: input.reviewedProfile }) : observeJson(reviewedProfilePath(input.root), parseReviewedProfile),
    observeCoordinatorState(input.root), observeJson(adoptOpStatePath(runRoot), parseAdoptOpState),
    observeContracts(input.root), observeHostBundles(input.root), observeEvents(input.root),
  ]);
  const att = attRead.state === "present" ? attRead.value : null;
  status.evidence.attestation = attRead.state;
  status.evidence.profile = input.reviewedProfile ? "provided" : profile.state;
  status.evidence.events = events.state;
  status.coordinator.state = coordinator.state;
  if (coordinator.state === "present") {
    status.circuit = coordinator.value.circuit;
    status.coordinator.mutationCount = coordinator.value.mutationCount;
    status.coordinator.lastAttemptKey = safeToken(coordinator.value.lastAttemptKey);
    status.coordinator.circuitReason = safeToken(coordinator.value.circuitReason);
  }
  status.operation = { state: journal.state, phase: journal.state === "present" ? journal.value.phase ?? null : null,
    pending: journal.state === "present" ? adoptJournalNeedsRecovery(journal.value) : journal.state === "missing" ? false : null };
  if (status.operation.pending || bad(journal.state) || status.circuit === "open" || bad(coordinator.state)) status.watchdog.state = "degraded";
  // A stored circuit/attestation is not a heartbeat. Liveness otherwise remains unknown.
  const lastHeal = [...events.events].reverse().find((row) => "name" in row && row.name === "stale_patched_term" &&
    "outcome" in row && ["exited", "supervisor_relaunched", "failed", "skipped"].includes(String(row.outcome)));
  if (lastHeal && "at" in lastHeal && "outcome" in lastHeal) status.lastHeal = { at: lastHeal.at, outcome: String(lastHeal.outcome) };

  const source = input.diskSha !== undefined
    ? input.diskSha === null ? { state: "unavailable" as const } : { state: "present" as const, value: input.diskSha }
    : input.processes ? { state: "unavailable" as const } : await liveStatusAdapter.diskSha();
  const sha = source.state === "present" ? source.value : null;
  status.host.diskSha = sha;
  status.evidence.source = source.state;
  const generation = sha ? contracts.generations.find((row) => row.sourceSha === sha)?.metadata : null;
  status.contracts = { state: contracts.state, head: contracts.head, sourceSha: generation?.sourceSha ?? null,
    diskMatchesHead: sha && contracts.head ? sha === contracts.head : null };
  const matchedBundle = bundles.generations.find((row) => row.metadata?.matchedProfileId);
  status.bundles = {
    state: bundles.state,
    head: bundles.head,
    retained: bundles.generations.length,
    liveRetained: sha ? bundles.generations.some((row) => row.sourceSha === sha && row.state === "present") : null,
    lastMatchedSha: matchedBundle?.sourceSha ?? null,
  };
  status.driftedSlices = generation ? [...generation.driftedSlices] : null;
  const gateway = input.gatewayPid !== undefined
    ? input.gatewayPid === null ? { state: "unavailable" as const } : { state: "present" as const, value: input.gatewayPid }
    : input.processes ? { state: "unavailable" as const } : await liveStatusAdapter.gatewayPid();
  status.evidence.gateway = gateway.state;
  try {
    const ready = input.modeldReady ? await input.modeldReady() : input.processes ? null : await liveStatusAdapter.modeldReady(runRoot);
    status.modeld.state = ready === null ? "unknown" : ready ? "running" : "stopped";
  } catch { status.modeld.state = "unknown"; }

  try {
    const port = input.processes ?? liveStatusAdapter.processes();
    const classify = input.classify ?? roleOf;
    const envHas = input.envHas ?? (input.processes ? () => false : liveStatusAdapter.envHas);
    const identities = port.list();
    const snapshot: ProcessPort = { list: () => identities, inspect: (pid) => identities.find((row) => row.pid === pid) ?? null,
      signal: () => ({ ok: false, reason: "not-found" }) };
    const census = countRoles(identities.flatMap((ident) => { const role = classify(ident); return role ? [{ ...ident, role }] : []; }));
    status.census = { wrapper: census.wrapper, supervisor: census.supervisor, host: census.host };
    status.evidence.processes = "present";
    const hosts = identities.filter((ident) => classify(ident) === "host");
    const host = hosts.length === 1 ? hosts[0]! : null;
    const touched = hosts.some((host) => GROKBOX_TOUCH_ENV.some((key) => envHas(host.pid, key)));
    const ownership = touched && canonicalOwnershipAgrees({ attestation: att, liveHost: host, census });
    const fresh = ownership && sha !== null && att?.diskSha === sha;
    if (ownership && journal.state === "present" && status.operation.pending === false &&
      (journal.value.phase !== "attested" || journal.value.host?.pid !== host?.pid || journal.value.host?.start !== host?.start)) {
      status.operation = { ...status.operation, state: "invalid", pending: null };
      status.watchdog.state = "degraded";
    }
    const direct = findUniqueOfficialChain(snapshot, classify);
    const boundariesUntouched = identities.filter((ident) => ["wrapper", "supervisor"].includes(classify(ident) ?? ""))
      .every((ident) => !GROKBOX_TOUCH_ENV.some((key) => envHas(ident.pid, key)));
    let topology: RuntimeStatus["host"]["topology"] = "invalid";
    let topologyReason: HostReason = direct.ok ? "bad_parentage" : direct.code === "bad-parentage" ? "bad_parentage" : direct.code === "missing-role" ? "missing_role" : "duplicate_role";
    if (singleOfficialChain(census) && boundariesUntouched) {
      if (direct.ok && att?.launchMode !== "transient-adopt") topology = "direct";
      else if (ownership && att?.launchMode === "transient-adopt") {
        const wrapper = identities.find((ident) => classify(ident) === "wrapper")!;
        const supervisor = identities.find((ident) => classify(ident) === "supervisor")!;
        if (supervisor.ppid !== wrapper.pid || host!.ppid === supervisor.pid) topologyReason = "bad_parentage";
        else if (gateway.state !== "present") { topology = "unknown"; topologyReason = "gateway_unknown"; }
        else {
          const adopted = findAdoptedHostState(snapshot, classify, { gatewayPid: gateway.value, expectedHost: host! });
          if (adopted.ok) topology = "adopted";
          else topologyReason = adopted.code === "gateway-mismatch" ? "gateway_mismatch" : "bad_parentage";
        }
      }
    }
    const topologyValid = topology === "direct" || topology === "adopted";
    status.host.topology = topology;
    if (ownership) {
      status.host.origin = "grokbox-attested";
      status.host.reason = !topologyValid ? topologyReason : sha === null ? "source_unavailable" : fresh ? null : "stale_attestation";
      status.activation.actual = att!.mode;
    } else if (touched) {
      status.host.origin = "grokbox-unattested";
      status.host.reason = bad(attRead.state) ? "invalid_attestation" : att ? "stale_attestation" : "unmanaged_preload";
      status.activation.actual = "patched-unknown";
    } else if (direct.ok && singleOfficialChain(census) && boundariesUntouched) {
      status.host.origin = "official";
      status.host.reason = null;
      status.host.topology = "direct";
      status.activation.actual = "official";
    } else {
      status.host.origin = "ambiguous";
      status.host.reason = topologyReason;
    }
    const requestedPatch = mode === "identity" || mode === "route";
    if (requestedPatch && (ownership || status.host.origin === "official")) status.coverage = "window-open";
    const modeAgrees = mode !== "identity" && mode !== "route" || att?.mode === mode;
    const routeMainId = effectiveModels?.assignments.main ?? null;
    const routeMain = routeMainId === STUB_ECHO_MODEL_ID ? STUB_ECHO_MODEL
      : routeMainId && effectiveModels && Object.hasOwn(effectiveModels.models, routeMainId) ? effectiveModels.models[routeMainId]! : null;
    const routeReady = mode !== "route" || (effectiveModels && status.models.assignmentState === "valid" &&
      (routeMain == null || routeModelAdmitted(routeMain)) && !routeHasNonStubAssignment(effectiveModels) &&
      profile.state === "present" && routeAttestationAgrees(att, profile.value) && status.modeld.state === "running");
    if (fresh && topologyValid && modeAgrees && routeReady && status.operation.pending === false) status.coverage = "attested";
    if (fresh && topologyValid && status.operation.pending === false) status.window.durationMs = att?.windowMs ?? null;

    if (mode === null) status.activation = { ...status.activation, reconcile: "unknown", reason: "desired_unavailable" };
    else if (status.operation.pending !== false) status.activation = { ...status.activation, reconcile: "recovery-required", reason: "pending_or_unknown_operation" };
    else if (mode === "disabled") {
      status.activation.reconcile = status.activation.actual === "official" ? "converged" : touched ? "pending" : "unknown";
      status.activation.reason = status.activation.actual === "official" ? null : touched ? "rollback_pending" : "host_unproven";
    } else if (mode === "observe") {
      status.activation.reconcile = status.activation.actual === "unknown" ? "unknown" : "converged";
      status.activation.reason = status.activation.actual === "unknown" ? "host_unproven" : null;
    } else {
      status.activation.reconcile = status.coverage === "attested" ? "converged" : status.host.origin === "official" ? "pending" : "recovery-required";
      status.activation.reason = status.coverage === "attested" ? null : status.host.reason ?? (mode === "route" && status.modeld.state !== "running" ? "modeld_not_ready" : "target_unproven");
    }
  } catch {
    status.evidence.processes = "unavailable";
    status.host.origin = "ambiguous";
    status.host.reason = "observation_unavailable";
    status.host.topology = "unknown";
    status.activation.actual = "unknown";
    status.activation.reconcile = "unknown";
    status.activation.reason = "host_unproven";
    status.coverage = "none";
  }
  return status;
}

/** Compatibility snapshot list; the CLI uses observeEvents for missing/bad-file evidence too. */
export async function readEvents(root: string, limit?: number): Promise<unknown[]> {
  return (await observeEvents(root, limit)).events;
}

export const readContracts = observeContracts;
export const readHostBundles = observeHostBundles;

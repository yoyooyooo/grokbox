import { observationOwn as own } from "../contract/provider-observation.ts";

/** The evidence contract describes observed boundaries, never execution authority.
 * Missing instrumentation and an observed absence have deliberately different states. */
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_REQUIREMENTS = ["E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08"] as const;
export type EvidenceRequirement = typeof EVIDENCE_REQUIREMENTS[number];
export const EVIDENCE_GAPS = ["not_instrumented", "not_checked", "not_observed_in_window", "expired", "truncated", "redacted", "unavailable", "unsupported", "not_applicable", "conflicting"] as const;
export type EvidenceGap = typeof EVIDENCE_GAPS[number];
export type EvidenceStatus = "observed" | "partial" | EvidenceGap;
export type EvidenceFact = { ref: string; value: Record<string, unknown> };
export type EvidenceCoverage = {
  requirement: EvidenceRequirement;
  status: EvidenceStatus;
  basis: "observed";
  sourceRefs: string[];
  missing: string[];
};
export type EvidenceRelation = {
  from: string; to: string;
  kind: "same_execution" | "same_dispatch" | "native_failure" | "native_alert" | "native_parent";
  basis: "explicit_identity" | "direct_failure_link" | "native_field";
};
export type EvidenceSelector = {
  agentId?: string; stepId?: string; turnId?: string; clientNonce?: string;
  trayId?: string; dispatchId?: string; hostGenerationId?: string; sourceInstanceId?: string;
};
export type EvidenceSourceWindow = {
  source: "monitor" | "journal";
  state: EvidenceStatus;
  retainedFloor: number;
  selected: number;
  truncated: boolean;
  gapCodes: string[];
};
export type IncidentEvidenceManifest = {
  schemaVersion: 1;
  incidentId: string;
  occurrenceId: string;
  evidenceRevision: number;
  capturedAtMs: number;
  classifierVersion: string;
  incidentRule: string;
  sourceWindow: EvidenceSourceWindow;
  factRefs: Array<{ ref: string; digest: string }>;
  identityAliases: Record<string, string>;
  assessmentDigest: string;
  relationEdges: EvidenceRelation[];
  coverageByRequirement: EvidenceCoverage[];
  currentObservations: { status: "not_checked" };
  viewPolicyVersion: "evidence-views-v1";
  retention: { tier: "detail"; expiresAtMs: number; summaryExpiresAtMs: number };
  logicalBytes: number;
  digest: string;
};

export function evidenceIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
const text = (row: unknown, key: string): string | undefined => {
  const value = own(row, key); return evidenceIdentity(value) ? value : undefined;
};
const named = (fact: EvidenceFact, name: string) => own(fact.value, "name") === name;
const present = (value: unknown) => value !== undefined && value !== null;
const atPath = (row: unknown, path: string) => path.split(".").reduce<unknown>((value, key) => own(value, key), row);
const has = (row: unknown, path: string) => present(atPath(row, path));

/** A missing generation never grants a cross-generation join. Legacy seed rows
 * remain usable as themselves, but cannot lend their identity to new rows. */
function sameRuntime(a: unknown, b: unknown): boolean {
  const generation = text(a, "hostGenerationId");
  if (!generation || generation !== text(b, "hostGenerationId")) return false;
  const epochA = text(a, "serviceEpoch"), epochB = text(b, "serviceEpoch");
  return !(epochA && epochB && epochA !== epochB);
}
function directRelation(a: EvidenceFact, b: EvidenceFact): EvidenceRelation | undefined {
  if (!sameRuntime(a.value, b.value)) return;
  const agent = text(a.value, "agentId");
  if (!agent || agent !== text(b.value, "agentId")) return;
  const fieldMatch = (field: string) => !!text(a.value, field) && text(a.value, field) === text(b.value, field);
  if (fieldMatch("turnId")) return { from: a.ref, to: b.ref, kind: "same_execution", basis: "explicit_identity" };
  if (fieldMatch("dispatchId")) return { from: a.ref, to: b.ref, kind: "same_dispatch", basis: "native_field" };
  if (fieldMatch("failureId")) return { from: a.ref, to: b.ref, kind: "native_failure", basis: "direct_failure_link" };
  const source = text(a.value, "sourceInstanceId");
  if (source && source === text(b.value, "sourceInstanceId") && (fieldMatch("trayId") || fieldMatch("decisionId"))) {
    return { from: a.ref, to: b.ref, kind: "native_alert", basis: "native_field" };
  }
  const alert = named(a, "host_alert_observation") ? a : named(b, "host_alert_observation") ? b : undefined;
  if (fieldMatch("stepId") && (!alert || own(alert.value, "stepEvidence") === "direct")) {
    return { from: a.ref, to: b.ref, kind: "same_execution", basis: "explicit_identity" };
  }
  const parent = text(a.value, "parentStepId"), kind = own(a.value, "requestKind");
  if (parent && parent === text(b.value, "stepId") && ["memory-extraction", "episode"].includes(String(kind))) {
    return { from: a.ref, to: b.ref, kind: "native_parent", basis: "native_field" };
  }
}
export function selectEvidenceClosure(facts: readonly EvidenceFact[], selector: EvidenceSelector, maxFacts = 512) {
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > 4096) throw new Error("evidence_invalid_limit");
  const scope = facts.filter(f => (!selector.agentId || own(f.value, "agentId") === selector.agentId)
    && (!selector.hostGenerationId || own(f.value, "hostGenerationId") === selector.hostGenerationId)
    && (!selector.sourceInstanceId || own(f.value, "sourceInstanceId") === selector.sourceInstanceId));
  const fields = ["stepId", "turnId", "clientNonce", "trayId", "dispatchId"] as const;
  const seeds = scope.filter(f => fields.some(key => selector[key] !== undefined && own(f.value, key) === selector[key]));
  const selected = new Map(seeds.slice(0, maxFacts).map(f => [f.ref, f]));
  const edges: EvidenceRelation[] = [];
  let truncated = seeds.length > maxFacts;
  // Breadth-first closure is bounded in both result size and input size by callers.
  const queue = [...selected.values()];
  for (let i = 0; i < queue.length; i++) {
    for (const row of scope) {
      if (selected.has(row.ref)) continue;
      const relation = directRelation(queue[i]!, row) ?? directRelation(row, queue[i]!);
      if (!relation) continue;
      if (selected.size >= maxFacts) { truncated = true; continue; }
      selected.set(row.ref, row); queue.push(row); edges.push(relation);
    }
  }
  const generations = new Set([...selected.values()].map(f => text(f.value, "hostGenerationId")).filter(Boolean));
  for (const fact of facts) {
    if (!named(fact, "host_alert_observation") || !["observer_started", "manager_attached"].includes(String(own(fact.value, "kind")))
      || !generations.has(text(fact.value, "hostGenerationId")) || selected.has(fact.ref)) continue;
    if (selected.size >= maxFacts) { truncated = true; break; }
    selected.set(fact.ref, fact);
  }
  const epochs = new Map<string, Set<string>>();
  for (const f of selected.values()) {
    const turn = text(f.value, "turnId"), generation = text(f.value, "hostGenerationId"), epoch = text(f.value, "serviceEpoch");
    if (turn && epoch) { const key = `${generation ?? "missing"}:${turn}`; const set = epochs.get(key) ?? new Set(); set.add(epoch); epochs.set(key, set); }
  }
  const conflicting = generations.size > 1 || [...epochs.values()].some(set => set.size > 1);
  // Missing-epoch intermediaries can reveal conflicting claims, but may not
  // silently lend a causal chain to two different service incarnations.
  return { facts: facts.filter(f => selected.has(f.ref)), relationEdges: conflicting ? [] : edges, truncated,
    conflicting, matched: seeds.length > 0 };
}

/** Requirements are deliberately conservative. A source exposing one field is
 * not proof of the subsequent native side effect or the complete user journey. */
export function assessEvidenceCoverage(facts: readonly EvidenceFact[], input: { sourceState?: EvidenceStatus; truncated?: boolean; conflicting?: boolean } = {}): EvidenceCoverage[] {
  const select = (predicate: (value: Record<string, unknown>) => boolean) => facts.filter(f => predicate(f.value));
  const rows: EvidenceCoverage[] = [];
  const add = (requirement: EvidenceRequirement, evidence: EvidenceFact[], missing: string[], absent: EvidenceGap = "not_instrumented") => {
    const refs = evidence.map(f => f.ref).slice(0, 64);
    rows.push({ requirement, basis: "observed", sourceRefs: refs,
      status: input.conflicting ? "conflicting" : evidence.length ? (missing.length || input.truncated ? "partial" : "observed") : input.sourceState && input.sourceState !== "observed" ? input.sourceState : absent,
      missing: [...missing, ...(input.truncated ? ["bounded_window"] : [])] });
  };
  const identity = select(v => has(v, "agentId") && (has(v, "stepId") || has(v, "dispatchId")));
  add("E01", identity, identity.some(f => has(f.value, "turnId") && has(f.value, "stepId") && has(f.value, "hostGenerationId") && has(f.value, "serviceEpoch")) ? [] : ["complete_execution_identity"]);
  // Consume actual Host hook/modeld terminal producers, never an invented
  // after-the-fact artifact bundle. Their identities remain in this revision.
  const artifacts = select(v => has(v, "build") || has(v, "sourceIdentity") || has(v, "stream.engine") || has(v, "diagnostic.stream.engine"));
  const hostArtifacts = artifacts.filter(f => named(f, "host_seam_stage") && own(f.value, "stage") === "hook_enter"
    && atPath(f.value, "build.kind") === "bundled" && has(f.value, "build.sourceDigest")
    && ["sourceSha256", "profileSha256", "transformedSha256"].every(field => has(f.value, `sourceIdentity.${field}`)) && has(f.value, "wireVersion"));
  const modeldArtifacts = artifacts.filter(f => named(f, "model_step_terminal") && atPath(f.value, "build.kind") === "bundled"
    && has(f.value, "build.sourceDigest") && has(f.value, "wireVersion"));
  const sameExecution = (a: EvidenceFact, b: EvidenceFact) => ["agentId", "turnId", "hostGenerationId"].every(key =>
    evidenceIdentity(own(a.value, key)) && own(a.value, key) === own(b.value, key));
  const artifactGaps = [...(!hostArtifacts.length ? ["incident_time_host_loaded_tuple"] : []), ...(!modeldArtifacts.length ? ["incident_time_modeld_build"] : [])];
  if (hostArtifacts.length && modeldArtifacts.length && !hostArtifacts.some(h => modeldArtifacts.some(m => sameExecution(h, m)
    && atPath(h.value, "build.sourceDigest") === atPath(m.value, "build.sourceDigest") && own(h.value, "wireVersion") === own(m.value, "wireVersion")))) artifactGaps.push("host_modeld_identity_build_or_wire_mismatch");
  add("E02", artifacts, artifactGaps);
  const stream = select(v => ["diagnostic.normalizeCause", "diagnostic.rejectSite", "diagnostic.sdkValidation", "diagnostic.stream.http", "diagnostic.stream.engine", "stream.engine", "stream.http"].some(path => has(v, path))
    || (own(v, "name") === "provider_error_observed" && has(v, "status")));
  const requestWitness = (value: Record<string, unknown>) => ["stream", "diagnostic.stream"].some(prefix => {
    const calls = atPath(value, `${prefix}.counts.providerFetchCalls`), bytes = atPath(value, `${prefix}.counts.requestBytes`);
    const sdkParts = atPath(value, `${prefix}.counts.sdkParts`);
    return typeof calls === "number" && Number.isSafeInteger(calls) && calls > 0
      && typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0
      && typeof sdkParts === "number" && Number.isSafeInteger(sdkParts) && sdkParts >= 0
      && has(value, `${prefix}.engine.api`) && has(value, `${prefix}.http.status`);
  });
  add("E03", stream, stream.length && stream.every(f => requestWitness(f.value)) ? [] : ["complete_provider_sdk_request_witness"]);
  const tools = select(v => own(v, "name") === "host_tool_observation" || has(v, "toolCallCount") || has(v, "diagnostic.stream.toolBatchState"));
  const handled = tools.filter(f => named(f, "host_tool_observation") && own(f.value, "basis") === "native_tool_handler"
    && ["returned", "failed"].includes(own(f.value, "state") as string));
  const accepted = tools.filter(f => named(f, "host_tool_observation") && own(f.value, "state") === "result_accepted"
    && own(f.value, "basis") === "prompt_executor_append");
  const toolPair = handled.some(h => accepted.some(a => sameExecution(h, a) && ["stepId", "toolCallId"].every(key =>
    evidenceIdentity(own(h.value, key)) && own(h.value, key) === own(a.value, key))));
  add("E04", tools, ["external_business_commit", ...(!handled.length ? ["native_tool_execution"] : []),
    ...(!accepted.length ? ["tool_result_context_acceptance"] : []),
    ...(handled.length && accepted.length && !toolPair ? ["tool_identity_correlation"] : [])]);
  const context = select(v => own(v, "name") === "host_context_observation");
  add("E05", context, context.some(f => own(f.value, "state") === "checkpoint_observed" && own(f.value, "persisted") === true
    && own(f.value, "basis") === "native_context_owner") ? [] : ["context_checkpoint_readback"]);
  const runs = select(v => own(v, "name") === "host_run_observation" || own(v, "name") === "host_server_activity_observation");
  add("E06", runs, ["application_rendering", "complete_child_task_coverage"]);
  const alerts = select(v => own(v, "name") === "host_alert_observation");
  add("E07", alerts, ["application_received_or_read", ...(!alerts.some(f => own(f.value, "kind") === "manager_attached") ? ["native_manager_attachment"] : [])]);
  const health = select(v => ["observation_source_health", "host_run_health"].includes(own(v, "name") as string));
  add("E08", health, health.some(f => named(f, "host_run_health") && own(f.value, "coverage") === "observed_window"
    && own(f.value, "droppedTasks") === 0) ? [] : health.length ? ["producer_liveness_not_checked"] : ["source_health_snapshot"], "not_checked");
  return rows;
}

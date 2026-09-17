import { Clock, Effect, Exit, Fiber, Stream } from "effect";
import { BackendAuth, ContextCompactionAlgorithm, HostCompact, ModelBackend, type AuthLease } from "../../ports.ts";
import { canonicalJson, computeSnapshotDigest, sha256Text } from "../../hash.ts";
import type { ModelRecord } from "../../selection.ts";
import { contextBudget, summaryBudget, type CapturedContextPolicy } from "../config/context-policy.ts";
import { CONTEXT_MAX_OPERATIONS, ContextFailure, contextFailure, estimateContextText, measureContext, parseContextMaterial,
  contextMaintenanceKey, type ContextCandidate, type ContextMaterial, type ContextMaintenanceReceipt, type ContextMaintenanceRecord,
  type ContextMaintenanceRequest, type ContextSummaryInput, type ContextSummaryOutput } from "../contract/context-maintenance.ts";
import { parseContextSnapshot } from "../contract/snapshot.ts";
import { buildModelEnvelope } from "../contract/context.ts";
import { isConfirmedOverflow, isKnownZeroRelease, type OverflowEvidence } from "../contract/overflow.ts";
import type { ExecutionHistory } from "./execution-history.ts";

/** Resolved execution inputs from an admitted composition boundary, never wire
 * fields. Model/lease/policy cannot be supplied by a CLI request or prompt. */
export type ContextMaintenanceExecution = {
  request: ContextMaintenanceRequest;
  model: ModelRecord;
  policy: CapturedContextPolicy;
  lease: AuthLease;
  /** Only supplied by the current failed attempt's kernel owner. */
  overflow?: OverflowEvidence;
};

type ContextServices = HostCompact | ContextCompactionAlgorithm | BackendAuth | ModelBackend;
function storageError(): ContextFailure { return new ContextFailure("commit_unknown"); }

/** Candidate checking is independent from the external planning algorithm.
 * Native metadata is checked by the Host; canonical retained content is checked here. */
export function validateContextReplacement(before: ContextMaterial, candidate: ContextCandidate, raw: ContextMaterial): ContextMaterial {
  const next = parseContextMaterial(raw);
  if (next.rootId !== before.rootId || candidate.sourceRootRevision !== before.rootRevision
    || canonicalJson(next.tools) !== canonicalJson(before.tools) || canonicalJson(next.options) !== canonicalJson(before.options)) {
    throw new ContextFailure("stale_root");
  }
  const original = new Map(before.messages.map(row => [row.ref, row]));
  const expected = [...candidate.retainedRefs, ...candidate.summarizedRefs];
  if (expected.length !== original.size || new Set(expected).size !== expected.length || expected.some(ref => !original.has(ref))) {
    throw new ContextFailure("context_material_invalid");
  }
  const keep = new Set(candidate.retainedRefs);
  if (canonicalJson(before.messages.filter(row => keep.has(row.ref)).map(row => row.ref)) !== canonicalJson(candidate.retainedRefs)) throw new ContextFailure("context_material_invalid");
  const calls = new Map<string, { ref: string; returned: boolean }>();
  let lastUser: string | undefined;
  for (const row of before.messages) {
    const parts = typeof row.message.content === "string" ? [{ type: "text", text: row.message.content } as const] : row.message.content;
    if ((row.preserve || (!row.summary && row.message.role === "system") || parts.some(p => p.type === "image")) && !keep.has(row.ref)) throw new ContextFailure("context_material_invalid");
    if (!row.summary && row.message.role === "user" && parts.some(p => p.type !== "tool-result")) lastUser = row.ref;
    for (const part of parts) {
      if (part.type === "tool-call") {
        if (calls.has(part.toolCallId)) throw new ContextFailure("context_material_invalid");
        calls.set(part.toolCallId, { ref: row.ref, returned: false });
      } else if (part.type === "tool-result") {
        const call = calls.get(part.toolCallId);
        if (!call || call.returned || keep.has(call.ref) !== keep.has(row.ref)) throw new ContextFailure("context_material_invalid");
        call.returned = true;
      }
    }
  }
  if ((lastUser && !keep.has(lastUser)) || [...calls.values()].some(call => !call.returned && !keep.has(call.ref))) throw new ContextFailure("context_material_invalid");
  const retained = next.messages.filter(row => original.has(row.ref));
  const summaries = next.messages.filter(row => !original.has(row.ref));
  if (canonicalJson(retained.map(row => row.ref)) !== canonicalJson(candidate.retainedRefs)
    || retained.some(row => canonicalJson(row) !== canonicalJson(original.get(row.ref)))
    || summaries.length !== 1 || summaries[0]!.summary !== true) throw new ContextFailure("context_material_invalid");
  const summaryMessage = summaries[0]!.message;
  const summaryText = typeof summaryMessage.content === "string" ? summaryMessage.content
    : summaryMessage.content.every(p => p.type === "text") ? summaryMessage.content.map(p => p.type === "text" ? p.text : "").join("") : "";
  if (summaryMessage.role !== "user" || !summaryText.includes(candidate.summary)) throw new ContextFailure("summary_invalid");
  buildModelEnvelope(next.messages.map(row => row.message), next.tools, next.options);
  const after = measureContext(next), prior = measureContext(before);
  if (after.tokens > candidate.budget.resumeThresholdTokens) throw new ContextFailure("context_target_unreachable");
  if (after.tokens >= prior.tokens) throw new ContextFailure("no_improvement");
  return next;
}

function executeContextMaintenance(input: ContextMaintenanceExecution, history: ExecutionHistory): Effect.Effect<ContextMaintenanceReceipt, ContextFailure, ContextServices> {
  return Effect.gen(function* () {
    const { request, model, policy, lease } = input;
    if (!request.operationId || request.operationId.length > 128 || /[\x00-\x1f]/.test(request.operationId)
      || !request.rootId || !request.rootRevision || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= 0
      || request.deadlineMs > 180000 || request.selection.agentId !== request.agentId || request.selection.modelId !== model.id
      || !["manual", "preflight", "overflow"].includes(request.reason)
      || (request.reason === "manual" && request.confirmed !== true)) return yield* Effect.fail(new ContextFailure("not_admitted"));
    if (request.reason === "overflow" && (!input.overflow || !isConfirmedOverflow(input.overflow)
      || ![input.overflow.releasedText, input.overflow.releasedReasoning, input.overflow.releasedTools].every(isKnownZeroRelease))) {
      return yield* Effect.fail(new ContextFailure("not_admitted"));
    }
    const owner = (yield* HostCompact).maintenance;
    if (!owner || !history.getMaintenance || !history.putMaintenance) return yield* Effect.fail(new ContextFailure("capability_unqualified"));
    const algorithm = yield* ContextCompactionAlgorithm, backend = yield* ModelBackend, auth = yield* BackendAuth;
    const started = yield* Clock.monotonicTimeNanos;
    const continuationReserve = request.reason === "manual" ? 0 : 35000;
    const duration = Math.min(policy.compaction.limits.timeoutMs, request.deadlineMs - continuationReserve);
    if (duration <= 0) return yield* Effect.fail(new ContextFailure("deadline_exceeded"));
    const key = contextMaintenanceKey(request.agentId, request.sessionId, request.operationId);
    const { deadlineMs: _waitBudget, ...requestIdentity } = request;
    const fingerprint = sha256Text(canonicalJson([requestIdentity, model.id, policy.revision]));
    const put = (record: ContextMaintenanceRecord) => Clock.currentTimeMillis.pipe(Effect.flatMap(updatedAtMs =>
      history.putMaintenance!(key, { ...record, updatedAtMs })), Effect.mapError(storageError));
    const fence = Effect.gen(function* () {
      if (Number((yield* Clock.monotonicTimeNanos) - started) / 1000000 >= duration) return yield* Effect.fail(new ContextFailure("deadline_exceeded"));
      yield* owner.authorize(request);
      yield* auth.verify(lease).pipe(Effect.mapError(() => new ContextFailure("not_admitted")));
    });
    yield* fence;
    const prior = yield* history.getMaintenance(key).pipe(Effect.mapError(storageError));
    if (prior && prior.fingerprint !== fingerprint) return yield* Effect.fail(new ContextFailure("maintenance_conflict"));
    if (prior?.state === "committed" && prior.receipt) return prior.receipt;
    if (prior) {
      // A partially acknowledged operation is never automatically replayed.
      // Native readback can prove a commit, but does not grant a new model call.
      const committed = yield* owner.readCommit(request);
      if (committed?.outcome === "committed" && committed.persisted && prior.receipt && committed.material
        && committed.operationId === request.operationId && committed.sourceRootRevision === request.rootRevision
        && committed.rootRevision === prior.receipt.rootRevision) {
        const material = yield* Effect.try({ try: () => parseContextMaterial(committed.material), catch: storageError });
        const after = measureContext(material);
        if (after.tokens > prior.receipt.budget.resumeThresholdTokens) return yield* Effect.fail(storageError());
        const recovered = { ...prior.receipt, after, persisted: true };
        yield* put({ ...prior, state: "committed", receipt: recovered, failure: undefined });
        return recovered;
      }
      return yield* Effect.fail(new ContextFailure(prior.state === "committing" || prior.state === "commit_unknown" ? "commit_unknown" : prior.failure ?? "commit_unknown"));
    }
    const material = yield* owner.inspect(request).pipe(Effect.flatMap(raw => Effect.try({
      try: () => parseContextMaterial(raw), catch: error => contextFailure(error, "context_material_invalid"),
    })));
    if (material.rootId !== request.rootId || material.rootRevision !== request.rootRevision) return yield* Effect.fail(new ContextFailure("stale_root"));
    const budget = yield* Effect.try({ try: () => contextBudget(policy, model.contextWindowTokens, material.options.maxTokens), catch: () => new ContextFailure("context_policy_invalid") });
    const before = yield* algorithm.measure(material);
    const receipt = (after: typeof before, rootRevision: string, outcome: "unchanged" | "committed", requests = 0, tokens = 0): ContextMaintenanceReceipt => ({
      operationId: request.operationId, rootId: material.rootId, sourceRootRevision: material.rootRevision, rootRevision,
      outcome, policyRevision: policy.revision, budget, before, after, summaryRequests: requests, summaryInputTokens: tokens,
      targetMet: after.tokens <= budget.preferredTargetTokens, headroomMet: after.tokens <= budget.resumeThresholdTokens,
      persisted: outcome === "committed",
    });
    if (request.reason === "preflight" && before.tokens <= budget.inputTokens) return receipt(before, material.rootRevision, "unchanged");
    if (request.reason !== "manual" && policy.compaction.mode === "manual") return yield* Effect.fail(new ContextFailure("context_budget_exceeded"));
    const sb = yield* Effect.try({ try: () => summaryBudget(policy, model.contextWindowTokens), catch: () => new ContextFailure("context_policy_invalid") });
    const identity = { operationId: request.operationId, hostEpoch: request.hostEpoch, serviceEpoch: request.serviceEpoch,
      agentId: request.agentId, sessionId: request.sessionId, rootId: request.rootId, rootRevision: request.rootRevision,
      selection: request.selection, ...(request.parent ? { parent: request.parent } : {}) };
    const planned = yield* Effect.result(algorithm.plan(material, budget, sb));
    if (planned._tag === "Failure") {
      if (request.reason === "manual" && planned.failure.code === "no_improvement" && before.tokens <= budget.inputTokens) {
        const unchanged = receipt(before, material.rootRevision, "unchanged");
        // A logical no-op still consumes this explicit operation identity; a
        // retry must not turn into a new compaction after later user messages.
        yield* put({ fingerprint, identity, state: "committed", summaryRequests: 0, summaryInputTokens: 0, receipt: unchanged });
        return unchanged;
      }
      return yield* Effect.fail(planned.failure);
    }
    const plan = planned.success;
    let record: ContextMaintenanceRecord = { fingerprint, identity, state: "claimed", summaryRequests: 0, summaryInputTokens: 0 };
    yield* put(record);
    const singleRequest = (summary: ContextSummaryInput): Effect.Effect<ContextSummaryOutput, ContextFailure> => Effect.gen(function* () {
      yield* fence;
      const measured = measureContext({ messages: summary.messages.map((message, index) => ({ ref: `summary:${index}`, message })), tools: [] });
      if (summary.maxOutputTokens !== sb.outputTokens || measured.tokens > sb.inputTokens) return yield* Effect.fail(new ContextFailure("context_budget_exceeded"));
      if (record.summaryRequests >= policy.compaction.limits.maxSummaryRequests
        || record.summaryInputTokens + measured.tokens > policy.compaction.limits.maxSummaryInputTokens) return yield* Effect.fail(new ContextFailure("maintenance_budget_exhausted"));
      record = { ...record, state: "summarizing", summaryRequests: record.summaryRequests + 1, summaryInputTokens: record.summaryInputTokens + measured.tokens };
      // Durable request reservation precedes the actual backend effect.
      yield* put(record);
      const body = { version: 1 as const, profileId: "context-summary-v1", abiIdentity: "context-summary-v1",
        systemMessages: summary.messages.filter(message => message.role === "system"), messages: summary.messages.filter(message => message.role !== "system"),
        tools: [], options: { maxTokens: summary.maxOutputTokens },
        contextBudget: { inputTokens: sb.inputTokens, outputTokens: sb.outputTokens, policyRevision: policy.revision } };
      const snapshot = parseContextSnapshot({ ...body, snapshotDigest: computeSnapshotDigest(body) });
      const prepared = yield* backend.prepare(model, snapshot).pipe(Effect.mapError(error => contextFailure(error)));
      yield* fence;
      let text = "", finished = false, inputTokens: number | undefined, outputTokens: number | undefined;
      yield* Stream.runForEach(backend.infer({ purpose: "conversation-compaction", operationId: request.operationId,
        requestId: `${request.operationId}:${record.summaryRequests}` }, prepared, lease), event => Effect.gen(function* () {
        if (finished) return yield* Effect.fail(new ContextFailure("summary_invalid"));
        if (event.type === "text_delta") {
          if (typeof event.text !== "string" || text.length + event.text.length > sb.outputTokens * 8) return yield* Effect.fail(new ContextFailure("summary_invalid"));
          text += event.text;
        } else if (event.type === "reasoning_delta") {
          // Reasoning is not summary text. The backend owns its streaming budget.
        } else if (event.type === "backend_finish") {
          if (event.finishReason !== "stop") return yield* Effect.fail(new ContextFailure("summary_invalid"));
          finished = true; inputTokens = event.usage?.promptTokens; outputTokens = event.usage?.completionTokens;
        } else return yield* Effect.fail(new ContextFailure("summary_invalid"));
      })).pipe(Effect.mapError(error => contextFailure(error)));
      yield* fence;
      if (!finished || !text.trim() || estimateContextText(text).tokens > sb.outputTokens) return yield* Effect.fail(new ContextFailure("summary_invalid"));
      return { text, finishReason: "stop", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
    });
    const work = Effect.gen(function* () {
      if (owner.startActivity) yield* owner.startActivity(request);
      const summary = yield* algorithm.generate(plan, sb, singleRequest);
      yield* fence;
      const candidate: ContextCandidate = { operationId: request.operationId, sourceRootRevision: material.rootRevision,
        summary, summarizedRefs: plan.summarizedRefs, retainedRefs: plan.retainedRefs, budget };
      const preview = yield* owner.preview(request, candidate);
      const checked = yield* Effect.try({ try: () => validateContextReplacement(material, candidate, preview), catch: error => contextFailure(error, "context_material_invalid") });
      yield* fence;
      const expectedReceipt = receipt(measureContext(checked), checked.rootRevision, "committed", record.summaryRequests, record.summaryInputTokens);
      // Persist the expected receipt for a later readback after a lost commit ack.
      record = { ...record, state: "committing", receipt: expectedReceipt }; yield* put(record);
      const committed = yield* owner.commit(request, candidate);
      if (committed.outcome !== "committed" || !committed.persisted || committed.operationId !== request.operationId
        || committed.sourceRootRevision !== request.rootRevision || committed.rootRevision !== checked.rootRevision) return yield* Effect.fail(new ContextFailure("commit_unknown"));
      const readback = yield* owner.readCommit(request);
      if (!readback || readback.outcome !== "committed" || !readback.persisted || !readback.material
        || readback.rootRevision !== committed.rootRevision || readback.operationId !== request.operationId) return yield* Effect.fail(new ContextFailure("commit_unknown"));
      const restored = yield* Effect.try({ try: () => validateContextReplacement(material, candidate, readback.material!), catch: () => new ContextFailure("commit_unknown") });
      const result = receipt(measureContext(restored), readback.rootRevision, "committed", record.summaryRequests, record.summaryInputTokens);
      record = { ...record, state: "committed", receipt: result }; yield* put(record);
      return result;
    });
    return yield* work.pipe(Effect.onExit(exit => {
      if (Exit.isSuccess(exit) || record.state === "committed") return Effect.void;
      const failure = Exit.isFailure(exit) && exit.cause.reasons.some(reason => reason._tag === "Fail" && reason.error instanceof ContextFailure)
        ? exit.cause.reasons.find(reason => reason._tag === "Fail" && reason.error instanceof ContextFailure) : undefined;
      const code = failure?._tag === "Fail" ? (failure.error as ContextFailure).code : "cancelled";
      record = { ...record, state: record.state === "committing" ? "commit_unknown" : "failed", failure: code };
      return put(record).pipe(Effect.ignore);
    }));
  });
}

/** Scoped single-flight: each root has one source; waiter cancellation does not
 * cancel other waiters. No module-global registry and no per-callback Runtime. */
export function makeContextMaintenanceRunner(history: ExecutionHistory) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const active = new Map<string, { fingerprint: string; users: number; fiber: Fiber.Fiber<ContextMaintenanceReceipt, ContextFailure> }>();
    const run = (input: ContextMaintenanceExecution): Effect.Effect<ContextMaintenanceReceipt, ContextFailure, ContextServices> => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const root = canonicalJson([input.request.hostEpoch, input.request.agentId, input.request.sessionId, input.request.rootId]);
      const { deadlineMs: _waitBudget, ...requestIdentity } = input.request;
      const fingerprint = sha256Text(canonicalJson([requestIdentity, input.policy.revision]));
      let entry = active.get(root);
      if (entry && entry.fingerprint !== fingerprint) return yield* Effect.fail(new ContextFailure("maintenance_busy"));
      if (!entry) {
        if (active.size >= CONTEXT_MAX_OPERATIONS) return yield* Effect.fail(new ContextFailure("maintenance_busy"));
        const duration = Math.min(input.policy.compaction.limits.timeoutMs, input.request.deadlineMs - (input.request.reason === "manual" ? 0 : 35000));
        if (!Number.isFinite(duration) || duration <= 0) return yield* Effect.fail(new ContextFailure("deadline_exceeded"));
        const program = executeContextMaintenance(input, history).pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new ContextFailure("deadline_exceeded")) }));
        const fiber = yield* Effect.forkIn(restore(program), scope);
        entry = { fingerprint, users: 0, fiber }; active.set(root, entry);
      }
      const held = entry; held.users++;
      return yield* restore(Fiber.join(held.fiber)).pipe(Effect.ensuring(Effect.gen(function* () {
        held.users--;
        if (held.users === 0) {
          yield* Fiber.interrupt(held.fiber);
          if (active.get(root) === held) active.delete(root);
        }
      })));
    }));
    return { run, activeCount: () => active.size };
  });
}

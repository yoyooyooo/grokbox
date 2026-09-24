import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { BackendFailure, parseContextSnapshot, type ContextSnapshot } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, computeSnapshotDigest, sha256Text } from "@grokbox/runtime-kernel/hash";
import { backendKindForModel, requireModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import {
  MODEL_PROBE_LIMITS, ModelManagementError, modelConfigurationRevision, modelProbeRequestId,
  normalizeModelProbe, parseModelProbeReceipt, type ModelProbeReceipt, type ModelProbeRequest,
} from "@grokbox/runtime-kernel/model-management";
import type { RuntimeStore } from "../io/configuration.node.ts";
import { assertSafeDirectory, publishConfigFile, readConfigFile } from "../io/config-layout.node.ts";
import { withJournalLock } from "../host/journal-lock.node.ts";
import { createLiveBackendAuth } from "../io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../backends/dispatch.ts";
import { ownProbeResponseBody, ProbeBodyCleanupGap } from "../io/model-probe-body.node.ts";

type RecordFile = { version: 1; fingerprint: string; receipt: ModelProbeReceipt };
type ProbeOptions = {
  store: RuntimeStore; installationId: string; principalId: string;
  env?: NodeJS.Dict<string>; fetch?: typeof fetch;
};
const unavailable = () => new ModelManagementError("unavailable", "The private model probe history is unavailable; no replacement request was sent.");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown) => object(error) && error.code === "ENOENT";

function fixedSnapshot(): ContextSnapshot {
  const body: Omit<ContextSnapshot, "snapshotDigest"> = {
    version: 1, profileId: "model-maintenance-probe-v1", abiIdentity: "provider-only-no-host",
    systemMessages: [{ role: "system", content: "This is a connectivity probe." }], messages: [{ role: "user", content: "Reply with OK." }], tools: [],
    options: { maxTokens: MODEL_PROBE_LIMITS.maxOutputTokens },
  };
  return parseContextSnapshot({ ...body, snapshotDigest: computeSnapshotDigest(body) });
}

/** A single provider request through the existing SDK, credential and stream
 * owners. No Bot, Host authority, Agent loop, fallback or automatic retry.
 * The durable declaration precedes dispatch. Process loss preserves unknown. */
export function openModelProbe(options: ProbeOptions) {
  const installationId = modelProbeRequestId(options.installationId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(options.principalId)) throw new ModelManagementError("invalid_input", "Invalid model probe principal.");
  const directory = join(options.store.root, "state", "model-probe-operations");
  const keyFor = (requestId: string) => sha256Text(canonicalJson([installationId, options.principalId, modelProbeRequestId(requestId)]));
  const refFor = (requestId: string) => `model-probe:${installationId}:${keyFor(requestId)}`;
  const pathFor = (requestId: string) => join(directory, `${keyFor(requestId)}.json`);
  async function recordAt(path: string): Promise<RecordFile | undefined> {
    const raw = await readConfigFile(path, true);
    if (raw === undefined) return undefined;
    if (!object(raw) || Object.keys(raw).some(key => !["version", "fingerprint", "receipt"].includes(key))
      || raw.version !== 1 || !hash(raw.fingerprint)) throw unavailable();
    try { return { version: 1, fingerprint: raw.fingerprint, receipt: parseModelProbeReceipt(raw.receipt) }; }
    catch { throw unavailable(); }
  }
  async function read(requestId: string, fingerprint?: string): Promise<RecordFile | undefined> {
    const path = pathFor(requestId);
    try { await lstat(directory); } catch (error) { if (missing(error)) return undefined; throw unavailable(); }
    await assertSafeDirectory(directory);
    const record = await recordAt(path);
    if (record && (record.receipt.operationRef !== refFor(requestId) || record.receipt.requestId !== modelProbeRequestId(requestId))) throw unavailable();
    if (record && fingerprint !== undefined && record.fingerprint !== fingerprint) throw new ModelManagementError("idempotency_conflict", "This probe request UUID belongs to different input.");
    return record;
  }
  async function assertModel(request: ModelProbeRequest): Promise<ModelRecord> {
    const models = await options.store.loadModels();
    if (modelConfigurationRevision(models) !== request.expectedRevision) throw new ModelManagementError("revision_conflict", "Model configuration changed before probe dispatch.");
    if (!Object.hasOwn(models.models, request.modelId) && request.modelId !== "stub/echo") throw new ModelManagementError("not_found", "The probe model does not exist.");
    return requireModel(models, request.modelId);
  }
  async function reserve(request: ModelProbeRequest, fingerprint: string, model: ModelRecord, authorize: () => Promise<void>, signal: AbortSignal) {
    await assertSafeDirectory(directory, true);
    return withJournalLock(join(directory, "probe.lock"), async () => {
      const previous = await read(request.requestId, fingerprint);
      if (previous) return { original: true, record: previous };
      let count = 0;
      const listing = await opendir(directory);
      for await (const entry of listing) {
        if (entry.name === "probe.lock" || /^events.prepare-[0-9]+$/.test(entry.name)) continue;
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw unavailable();
        if (++count >= 1024) throw new ModelManagementError("store_full", "Probe history is full; original receipts remain readable.");
        const prior = await recordAt(join(directory, entry.name));
        if (!prior) throw unavailable();
        // A different UUID must not bypass an unresolved paid effect.
        if (prior.receipt.modelId === request.modelId && prior.receipt.state === "unknown") {
          throw new ModelManagementError("operation_unknown", "An earlier probe for this model remains uncertain; inspect its original receipt.");
        }
      }
      await authorize();
      await assertModel(request);
      signal.throwIfAborted();
      const mayIncur = backendKindForModel(model) !== "echo";
      const record: RecordFile = { version: 1, fingerprint, receipt: {
        version: 1, operationRef: refFor(request.requestId), requestId: request.requestId, modelId: request.modelId, modelRevision: request.expectedRevision,
        state: "unknown", reason: "outcome-unknown", acceptedAt: new Date().toISOString(), finishedAt: null,
        providerRequestSent: null, outputBytes: 0, usage: null,
        cost: { mayIncur, amount: mayIncur ? "unknown" : "none", maxRequests: 1, requestedMaxOutputTokens: 32 },
        toolsExecuted: false, responseStored: false, retryAllowed: false,
      } };
      await publishConfigFile(pathFor(request.requestId), record, undefined, true);
      return { original: false, record };
    }, 50);
  }
  async function probe(input: unknown, authorize: (signal: AbortSignal) => Promise<void>, callerSignal?: AbortSignal): Promise<ModelProbeReceipt> {
    const request = normalizeModelProbe(input);
    const fingerprint = sha256Text(canonicalJson(request));
    const deadline = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), request.timeoutMs);
    let retained: RecordFile | undefined;
    let original: ModelProbeReceipt | undefined;
    let sent = false, outputBytes = 0;
    let usage: ModelProbeReceipt["usage"] = null;
    let finished = false;
    const sourceCalls = new Set<Promise<Response>>();
    const bodies = new Set<ReturnType<typeof ownProbeResponseBody>>();
    let closingSources: Promise<void> | undefined;
    const closeSources = (): Promise<void> => closingSources ??= (async () => {
      deadline.abort();
      await Promise.allSettled([...sourceCalls]);
      // A returned fetch no longer appears in sourceCalls. Close and join its
      // reader explicitly, including asynchronous source cancellation.
      await Promise.allSettled([...bodies].map(body => body.close()));
      const closed = await Promise.allSettled([...bodies].map(body => body.done));
      if (closed.some(result => result.status === "rejected")) throw new ProbeBodyCleanupGap();
    })();
    try {
      signal.throwIfAborted();
      await authorize(signal);
      const previous = await read(request.requestId, fingerprint);
      if (previous) return previous.receipt;
      const model = await assertModel(request);
      const auth = createLiveBackendAuth(options.env ?? process.env, { durableRoot: options.store.root });
      const sourceFetch = options.fetch ?? fetch;
      let verifyCredential: () => Promise<void> = async () => { throw new BackendFailure("auth_mismatch"); };
      const fetchOnce: typeof fetch = Object.assign((url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const work = (async () => {
          signal.throwIfAborted();
          if (sent) throw new BackendFailure("provider_error");
          await authorize(signal);
          await assertModel(request);
          await verifyCredential();
          signal.throwIfAborted();
          if (sent) throw new BackendFailure("provider_error");
          sent = true;
          const response = await sourceFetch(url, { ...init, redirect: "error",
            signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
          const body = response.body ? ownProbeResponseBody(response.body, MODEL_PROBE_LIMITS.maxResponseBytes) : undefined;
          if (body) bodies.add(body);
          // Header and body lifetimes remain owned after the SDK has cancelled.
          if (signal.aborted) { await body?.close(); signal.throwIfAborted(); }
          if (!body) return response;
          return new Response(body.stream, { status: response.status, statusText: response.statusText, headers: response.headers });
        })();
        sourceCalls.add(work);
        void work.finally(() => sourceCalls.delete(work)).catch(() => undefined);
        return work;
      }, { preconnect: sourceFetch.preconnect });
      const layer = Layer.merge(auth.layer, dispatchingModelBackendLayer(fetchOnce, auth.unseal));
      const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
        const backend = yield* ModelBackend, credentials = yield* BackendAuth;
        const prepared = yield* backend.prepare(model, fixedSnapshot());
        const pinned = yield* credentials.pin({ apiKeyRef: model.apiKeyRef });
        verifyCredential = () => Effect.runPromise(credentials.verify(pinned.lease), { signal });
        yield* credentials.verify(pinned.lease);
        // Await declaration even when cancellation arrives during its fsync.
        const admitted = yield* Effect.uninterruptible(Effect.tryPromise({ try: async () => {
          const reserved = await reserve(request, fingerprint, model, () => authorize(signal), signal);
          if (reserved.original) original = reserved.record.receipt;
          else retained = reserved.record;
          return reserved;
        }, catch: error => error }));
        if (admitted.original) return;
        yield* credentials.verify(pinned.lease);
        yield* Stream.runForEach(backend.infer({ purpose: "explicit-model-probe" }, prepared, pinned.lease), event => Effect.sync(() => {
          if (event.type === "text_delta" || event.type === "reasoning_delta") {
            outputBytes += Buffer.byteLength(event.text, "utf8");
            if (outputBytes > MODEL_PROBE_LIMITS.maxResponseBytes) throw new BackendFailure("stream_limit");
          } else if (event.type === "backend_finish") {
            if (event.finishReason !== "stop") throw new BackendFailure("provider_error");
            finished = true;
            if (event.usage) usage = { promptTokens: event.usage.promptTokens, completionTokens: event.usage.completionTokens };
          } else throw new BackendFailure("stream_invalid");
        }));
        if (!finished) return yield* Effect.fail(new BackendFailure("stream_invalid"));
      }).pipe(Effect.provide(layer))), { signal });
      if (original) return original;
      // A cleanup gap leaves the original uncertain guard intact; no terminal
      // success receipt is published while a provider body remains unclosed.
      await closeSources();
      if (!retained) {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        throw unavailable();
      }
      const succeeded = Exit.isSuccess(exit) && finished;
      const receipt: ModelProbeReceipt = { ...retained.receipt, state: succeeded ? "succeeded" : sent ? "unknown" : "failed",
        reason: succeeded ? "completed" : sent ? "outcome-unknown" : "not-dispatched", finishedAt: new Date().toISOString(),
        providerRequestSent: sent, outputBytes: Math.min(outputBytes, MODEL_PROBE_LIMITS.maxResponseBytes), usage,
        cost: { ...retained.receipt.cost, mayIncur: sent, amount: sent ? "unknown" : "none" },
      };
      // An uncertain publication never overwrites the guard with a fabricated
      // completion, nor releases it for a replacement paid request.
      try {
        const completed = { ...retained, receipt: parseModelProbeReceipt(receipt) };
        await withJournalLock(join(directory, "probe.lock"), () => publishConfigFile(pathFor(request.requestId), completed), 50);
        return completed.receipt;
      } catch { return retained.receipt; }
    } finally {
      try { await closeSources(); }
      finally { clearTimeout(timer); }
    }
  }
  const effect = (input: unknown, authorize: (signal: AbortSignal) => Promise<void>) => {
    let pending: Promise<ModelProbeReceipt> | undefined;
    return Effect.acquireUseRelease(Effect.sync(() => new AbortController()), controller => Effect.tryPromise({
      try: () => { pending = probe(input, authorize, controller.signal); return pending; }, catch: error => error,
    }), controller => Effect.promise(async () => {
      // Interrupt inference/source waits, then join the original reservation,
      // provider Scope, receipt publisher and deadline cleanup before Server.close.
      controller.abort();
      await pending?.catch(error => { if (error instanceof ProbeBodyCleanupGap) throw error; });
    }));
  };
  return {
    effect,
    probe,
    receipt: async (requestId: string): Promise<ModelProbeReceipt | undefined> => (await read(modelProbeRequestId(requestId)))?.receipt,
  };
}

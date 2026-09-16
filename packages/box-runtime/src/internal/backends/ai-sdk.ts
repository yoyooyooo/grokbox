import { createOpenAI } from "@ai-sdk/openai";
import aiPackage from "ai/package.json";
import providerPackage from "@ai-sdk/openai/package.json";
import { Cause, Effect, Layer, Queue, Stream } from "effect";
import {
  BackendFailure,
  EnvelopeError,
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  StreamEvidence,
  annotateStreamFailure, annotateFailureSummary, failureSummaryFromObservation,
  type ContextSnapshot,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { ModelBackend, type AuthLease, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { backendKindForModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { encodeOpenaiPrompt, toProviderPrompt, type OpenaiPromptApi } from "./openai-prompt-adapter.ts";
import { createSdkStreamNormalizer } from "./openai-events.ts";
import { ProviderStreamAudit, auditedProviderResponse } from "./provider-stream-audit.ts";
import { backendFailureFromUnknown } from "./provider-error.ts";
import { observeBackendFailure, backendFailureObservation } from "./failure-observation.ts";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { freezePreparedSnapshot, makePreparedCall, readPreparedCall } from "./prepared.ts";

export type UnsealAuth = (lease: AuthLease) => string;

function mapPrepareError(error: unknown): BackendFailure {
  if (error instanceof BackendFailure) return error;
  if (error instanceof EnvelopeError && error.code === "envelope_too_large") return new BackendFailure("envelope_too_large");
  if (error instanceof EnvelopeError && error.code === "unsupported_options") return new BackendFailure("unsupported_options");
  if (error instanceof EnvelopeError) return new BackendFailure("unsupported_content");
  return new BackendFailure("invalid_prepared_call");
}

function bodyBytes(init?: RequestInit): number {
  const raw = init?.body;
  if (typeof raw === "string") return new TextEncoder().encode(raw).length;
  if (raw instanceof Uint8Array) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return 0;
}

function guardEgress(fetchImpl: typeof fetch, audit: ProviderStreamAudit): typeof fetch {
  const run = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    audit.evidence.setCount("requestBytes", bodyBytes(init));
    if (bodyBytes(init) > ENCODED_PROVIDER_REQUEST_MAX_BYTES) {
      throw new BackendFailure("envelope_too_large");
    }
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      audit.evidence.increment("httpCalls");
      // Retain the staged observation name with the same actual-call boundary.
      audit.evidence.increment("providerFetchCalls");
      return auditedProviderResponse(await fetchImpl(input, init), audit);
    }
    catch (error) { throw backendFailureFromUnknown(error, "provider"); }
  };
  return Object.assign(run, { preconnect: fetchImpl.preconnect ?? run }) as typeof fetch;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** One SDK pull owns one abort listener; release it on every settlement path.
 * A shared pending abort Promise would retain one reaction per successful pull. */
export function nextSdkStreamPart<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Attach both handlers even when next() synchronously triggers cancellation.
      // A later rejection from the losing pull must not become unhandled.
      Promise.resolve(iterator.next()).then(
        (part) => { cleanup(); resolve(part); },
        (error) => { cleanup(); reject(error); },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function aiSdkModelBackendLayer(fetchImpl: typeof fetch, unseal: UnsealAuth): Layer.Layer<ModelBackend> {
  return Layer.succeed(ModelBackend, {
    prepare: (selection: unknown, snapshot: unknown) => Effect.try({
      try: () => {
        const record = selection as ModelRecord;
        const kind = backendKindForModel(record);
        if (kind === "echo") throw new BackendFailure("unknown_backend_kind");
        const api: OpenaiPromptApi = kind === "openai-responses" ? "responses" : "chat";
        const snap = snapshot as ContextSnapshot;
        const prompt = encodeOpenaiPrompt(snap);
        const frozen = freezePreparedSnapshot(snap, api);
        return makePreparedCall({
          kind,
          prompt,
          model: record.model,
          endpoint: record.endpoint,
          api,
          routeId: sha256Text(canonicalJson(["provider-route-v1", record.endpoint, api, record.model, record.apiKeyRef])),
          ...frozen,
        });
      },
      catch: (error) => observeBackendFailure(mapPrepareError(error), "prepare", error),
    }),
    infer: (_admitted: unknown, prepared: PreparedCall, lease: AuthLease) => {
      const payload = readPreparedCall(prepared);
      if (!payload || (payload.kind !== "openai-chat" && payload.kind !== "openai-responses")) {
        return Stream.fail(new BackendFailure("invalid_prepared_call"));
      }
      let started = false;
      return Stream.callback<InferenceEvent, BackendFailure>((queue) => Effect.suspend(() => {
        if (started) return Queue.end(queue);
        started = true;
        const ac = new AbortController(), evidence = new StreamEvidence();
        evidence.engine({ api: payload.api, aiVersion: aiPackage.version, providerVersion: providerPackage.version, adapterRevision: 1, pipeline: "provider_v2_single_call" });
        evidence.setCount("declaredTools", payload.tools.length);
        if (payload.routeId) evidence.providerRoute({ id: payload.routeId, api: payload.api });
        const audit = new ProviderStreamAudit(payload.api, evidence);
        const normalizer = createSdkStreamNormalizer({ declaredTools: new Set(payload.tools.map(t => t.name)), evidence });
        let iterator: AsyncIterator<unknown> | undefined;
        let queuePeak = 0;
        const safeFailure = (error: unknown) => {
          // provider-utils wraps body failures in APICallError. Keep the local
          // wire validator's exact first failure, not its lossy SDK wrapper.
          audit.settleFailure();
          const detected = audit.failure() ?? error;
          if (detected && typeof detected === "object") annotateStreamFailure(detected, { stream: evidence.snapshot() });
          const failure = backendFailureFromUnknown(detected, evidence.snapshot().providerObservation === "body_error" ? "provider" : "sdk");
          const diagnostic = backendFailureObservation(failure);
          return annotateFailureSummary(failure, failureSummaryFromObservation({ failureCode: failure.code,
            phase: diagnostic?.phase ?? "provider", diagnostic }));
        };
        const producer = Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => {
            ac.abort(); audit.cancelled(); audit.dispose();
            // Abort first. A non-cooperative iterator.return must not hold Scope
            // shutdown hostage; late rejection is consumed, never retried.
            try { void Promise.resolve(iterator?.return?.()).catch(() => undefined); } catch { /* cleanup only */ }
          }));
          iterator = yield* Effect.tryPromise({
            try: async () => {
              let secret: string;
              try { secret = unseal(lease); }
              catch (error) { throw observeBackendFailure(new BackendFailure("auth_mismatch"), "auth", error); }
              const openai = createOpenAI({ apiKey: secret, baseURL: payload.endpoint, fetch: guardEgress(fetchImpl, audit) });
              const model = payload.api === "responses" ? openai.responses(payload.model) : openai.chat(payload.model);
              const { toolChoice, ...settings } = payload.settings;
              const tools = payload.tools.map(tool => ({ type: "function" as const, name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
              const result = await model.doStream({
                prompt: toProviderPrompt(payload.prompt), ...(tools.length ? { tools: tools as never } : {}),
                ...settings, abortSignal: ac.signal,
                ...(toolChoice ? { toolChoice: typeof toolChoice === "string" ? { type: toolChoice } : toolChoice } : {}),
              });
              return result.stream[Symbol.asyncIterator]();
            }, catch: safeFailure,
          });
          for (;;) {
            const part = yield* Effect.tryPromise({
              try: signal => nextSdkStreamPart(iterator!, signal), catch: safeFailure,
            });
            if (part.done) break;
            const event = yield* Effect.try({ try: () => normalizer.next(part.value), catch: safeFailure });
            if (event) {
              // Await the bounded offer. Merely adding bufferSize to offerUnsafe
              // would silently drop parts when full.
              if (!(yield* Queue.offer(queue, event))) return;
              queuePeak = Math.max(queuePeak, yield* Queue.size(queue));
              evidence.setCount("queuePeak", queuePeak);
            }
          }
          const terminal = yield* Effect.try({ try: () => normalizer.finish(), catch: safeFailure });
          yield* Queue.offer(queue, terminal);
          yield* Queue.end(queue);
        });
        return producer.pipe(Effect.catchCause(cause => Cause.hasInterruptsOnly(cause)
          ? Queue.end(queue)
          : Queue.fail(queue, safeFailure(Cause.squash(cause)))));
      }), { bufferSize: 16, strategy: "suspend" });
    },
  });
}

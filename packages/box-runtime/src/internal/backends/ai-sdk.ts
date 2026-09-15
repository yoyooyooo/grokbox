import { jsonSchema, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Cause, Effect, Layer, Queue, Stream } from "effect";
import {
  BackendFailure,
  EnvelopeError,
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  applyInferenceEvent,
  emptyStreamValidation,
  finishInferenceStream,
  type ContextSnapshot,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { ModelBackend, type AuthLease, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { backendKindForModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { encodeOpenaiPrompt, toSdkMessages, type OpenaiPromptApi } from "./openai-prompt-adapter.ts";
import { mapSdkStreamForHost } from "./openai-events.ts";
import { createNonstandardOpenaiStreamState } from "./nonstandard-endpoint.ts";
import { backendFailureFromUnknown } from "./provider-error.ts";
import { observeBackendFailure } from "./failure-observation.ts";
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

function guardEgress(fetchImpl: typeof fetch): typeof fetch {
  const run = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (bodyBytes(init) > ENCODED_PROVIDER_REQUEST_MAX_BYTES) {
      throw new BackendFailure("envelope_too_large");
    }
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try { return await fetchImpl(input, init); }
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

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError");
}

function failQueue(queue: Queue.Enqueue<InferenceEvent, BackendFailure>, error: unknown): void {
  Queue.failCauseUnsafe(queue, Cause.fail(backendFailureFromUnknown(error)));
}

export function aiSdkModelBackendLayer(fetchImpl: typeof fetch, unseal: UnsealAuth): Layer.Layer<ModelBackend> {
  const guarded = guardEgress(fetchImpl);
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
      return Stream.callback<InferenceEvent, BackendFailure>((queue) =>
        Effect.callback<void, BackendFailure>((resume, signal) => {
          const settle = (effect: Effect.Effect<void, BackendFailure>) => resume(effect);
          if (started) {
            Queue.endUnsafe(queue);
            settle(Effect.void);
            return;
          }
          started = true;
          const ac = new AbortController();
          const stop = () => {
            signal.removeEventListener("abort", stop);
            if (!ac.signal.aborted) ac.abort();
          };
          signal.addEventListener("abort", stop, { once: true });
          void (async () => {
            let sdkError: unknown;
            const iterator = (() => {
              try {
                let secret: string;
                try { secret = unseal(lease); }
                catch (error) { throw observeBackendFailure(new BackendFailure("auth_mismatch"), "auth", error); }
                const openai = createOpenAI({ apiKey: secret, baseURL: payload.endpoint, fetch: guarded });
                const model = payload.api === "responses" ? openai.responses(payload.model) : openai.chat(payload.model);
                const tools = Object.fromEntries(payload.tools.map((tool) => [
                  tool.name,
                  { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) },
                ]));
                const result = streamText({
                  model,
                  system: payload.prompt.system,
                  messages: toSdkMessages(payload.prompt.messages) as never,
                  ...(payload.tools.length > 0 ? { tools } : {}),
                  maxRetries: 0,
                  // Default SDK logger includes bodies. Capture onError so an unfinished
                  // fullStream cannot hide the provider failure as stream_invalid.
                  onError: ({ error }) => { sdkError = error; },
                  abortSignal: ac.signal,
                  ...payload.settings,
                });
                return result.fullStream[Symbol.asyncIterator]();
              } catch (error) {
                failQueue(queue, error);
                settle(Effect.void);
                return null;
              }
            })();
            if (!iterator) { stop(); return; }
            const names = new Map<string, string>();
            const state = emptyStreamValidation();
            const nonstandard = createNonstandardOpenaiStreamState();
            try {
              while (!ac.signal.aborted) {
                const step = await nextSdkStreamPart(iterator, ac.signal);
                if (step.done) break;
                const mapped = mapSdkStreamForHost(step.value, names, nonstandard);
                if (mapped === "skip" || mapped === "drop") continue;
                applyInferenceEvent(state, mapped);
                if (mapped.type === "backend_finish" && state.open.size > 0) throw new BackendFailure("stream_invalid");
                Queue.offerUnsafe(queue, mapped);
              }
              if (ac.signal.aborted) Queue.endUnsafe(queue);
              else if (!state.finished && sdkError) throw sdkError;
              else {
                finishInferenceStream(state);
                Queue.endUnsafe(queue);
              }
              settle(Effect.void);
            } catch (error) {
              if (ac.signal.aborted || isAbortError(error)) Queue.endUnsafe(queue);
              else failQueue(queue, error);
              settle(Effect.void);
            } finally {
              stop();
              try { await iterator.return?.(); } catch { /* ignore */ }
            }
          })();
          return Effect.sync(stop);
        }),
      );
    },
  });
}

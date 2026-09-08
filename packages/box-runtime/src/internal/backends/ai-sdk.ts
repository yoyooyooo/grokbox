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
import { encodeCcsMessages, type CcsApi } from "./ccs-codec.ts";
import { mapSdkStreamPart } from "./openai-events.ts";
import { backendFailureFromUnknown } from "./provider-error.ts";
import { freezePreparedSnapshot, makePreparedCall, readPreparedCall } from "./prepared.ts";

export type UnsealAuth = (lease: AuthLease) => string;

function mapPrepareError(error: unknown): BackendFailure {
  if (error instanceof BackendFailure) return error;
  if (error instanceof EnvelopeError && error.code === "envelope_too_large") return new BackendFailure("envelope_too_large");
  if (error instanceof EnvelopeError && error.code === "unsupported_options") return new BackendFailure("unsupported_options");
  if (error instanceof EnvelopeError) return new BackendFailure("unsupported_content");
  return new BackendFailure("invalid_prepared_call");
}

function toSdkMessages(prompt: ReturnType<typeof encodeCcsMessages>) {
  return prompt.messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        if (part.type === "image") {
          return { type: "image" as const, image: part.image, ...(part.mediaType ? { mediaType: part.mediaType } : {}) };
        }
        return { type: "text" as const, text: "" };
      }),
    };
  });
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
    return fetchImpl(input, init);
  };
  return Object.assign(run, { preconnect: fetchImpl.preconnect ?? run }) as typeof fetch;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function waitAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(abortError());
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
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
        const api: CcsApi = kind === "openai-responses" ? "responses" : "chat";
        const snap = snapshot as ContextSnapshot;
        const prompt = encodeCcsMessages(snap);
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
      catch: mapPrepareError,
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
            if (!ac.signal.aborted) ac.abort();
          };
          signal.addEventListener("abort", stop, { once: true });
          void (async () => {
            const iterator = (() => {
              try {
                const secret = unseal(lease);
                const openai = createOpenAI({ apiKey: secret, baseURL: payload.endpoint, fetch: guarded });
                const model = payload.api === "responses" ? openai.responses(payload.model) : openai.chat(payload.model);
                const tools = Object.fromEntries(payload.tools.map((tool) => [
                  tool.name,
                  { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) },
                ]));
                const result = streamText({
                  model,
                  system: payload.prompt.system,
                  messages: toSdkMessages(payload.prompt) as never,
                  ...(payload.tools.length > 0 ? { tools } : {}),
                  maxRetries: 0,
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
            if (!iterator) return;
            const names = new Map<string, string>();
            const state = emptyStreamValidation();
            try {
              while (!ac.signal.aborted) {
                const step = await Promise.race([iterator.next(), waitAbort(ac.signal)]);
                if (step.done) break;
                const mapped = mapSdkStreamPart(step.value, names);
                if (mapped === "skip") continue;
                applyInferenceEvent(state, mapped);
                if (mapped.type === "backend_finish" && state.open.size > 0) throw new BackendFailure("stream_invalid");
                Queue.offerUnsafe(queue, mapped);
              }
              if (ac.signal.aborted) Queue.endUnsafe(queue);
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
              try { await iterator.return?.(); } catch { /* ignore */ }
            }
          })();
          return Effect.sync(stop);
        }),
      );
    },
  });
}

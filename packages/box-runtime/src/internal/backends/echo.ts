import { Effect, Layer, Stream } from "effect";
import {
  BackendFailure,
  EnvelopeError,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { ModelBackend, type AuthLease, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { encodeOpenaiPrompt, type OpenaiPrompt } from "./openai-prompt-adapter.ts";
import { freezePreparedSnapshot, makePreparedCall, readPreparedCall } from "./prepared.ts";

function lastUserFromPrompt(prompt: OpenaiPrompt): string {
  for (let index = prompt.messages.length - 1; index >= 0; index -= 1) {
    const message = prompt.messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  return "";
}

function mapPrepareError(error: unknown): BackendFailure {
  if (error instanceof BackendFailure) return error;
  if (error instanceof EnvelopeError && error.code === "envelope_too_large") return new BackendFailure("envelope_too_large");
  if (error instanceof EnvelopeError && error.code === "unsupported_options") return new BackendFailure("unsupported_options");
  if (error instanceof EnvelopeError) return new BackendFailure("unsupported_content");
  return new BackendFailure("invalid_prepared_call");
}

export const echoModelBackendLayer: Layer.Layer<ModelBackend> = Layer.succeed(ModelBackend, {
  prepare: (_selection: unknown, snapshot: unknown) => Effect.try({
    try: () => {
      if (_selection && typeof _selection === "object" && "reasoning" in _selection && _selection.reasoning !== undefined) throw new BackendFailure("unsupported_options");
      const snap = snapshot as Parameters<typeof encodeOpenaiPrompt>[0];
      const encoded = encodeOpenaiPrompt(snap);
      const frozen = freezePreparedSnapshot(snap, "chat");
      return makePreparedCall({
        kind: "echo",
        prompt: encoded,
        model: "echo",
        endpoint: "stub:echo",
        api: "chat",
        ...frozen,
      });
    },
    catch: mapPrepareError,
  }),
  infer: (_admitted: unknown, prepared: PreparedCall, _lease: AuthLease) => {
    const payload = readPreparedCall(prepared);
    if (!payload || payload.kind !== "echo") return Stream.fail(new BackendFailure("invalid_prepared_call"));
    const text = lastUserFromPrompt(payload.prompt);
    const events: InferenceEvent[] = [
      ...(text ? [{ type: "text_delta" as const, text }] : []),
      { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
    ];
    return Stream.fromIterable(events);
  },
});

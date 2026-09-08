import { jsonSchema, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Effect, Layer, Stream } from "effect";
import {
  BackendFailure,
  EnvelopeError,
  type ContextSnapshot,
} from "@grokbox/runtime-kernel/contract";
import { ModelBackend, type AuthLease, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { backendKindForModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { encodeCcsMessages, generationSettings, type CcsApi } from "./ccs-codec.ts";
import { mapSdkStreamPart } from "./openai-events.ts";
import { backendFailureFromUnknown } from "./provider-error.ts";
import { makePreparedCall, readPreparedCall } from "./prepared.ts";
import { unsealAuthLease } from "../io/credentials.node.ts";

function mapPrepareError(error: unknown): BackendFailure {
  if (error instanceof BackendFailure) return error;
  if (error instanceof EnvelopeError && error.code === "envelope_too_large") return new BackendFailure("envelope_too_large");
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

export function aiSdkModelBackendLayer(fetchImpl: typeof fetch): Layer.Layer<ModelBackend> {
  return Layer.succeed(ModelBackend, {
    prepare: (selection: unknown, snapshot: unknown) => Effect.try({
      try: () => {
        const record = selection as ModelRecord;
        const kind = backendKindForModel(record);
        if (kind === "echo") throw new BackendFailure("unknown_backend_kind");
        const api: CcsApi = kind === "openai-responses" ? "responses" : "chat";
        const snap = snapshot as ContextSnapshot;
        const prompt = encodeCcsMessages(snap);
        return makePreparedCall({
          kind,
          prompt,
          model: record.model,
          endpoint: record.endpoint,
          api,
          tools: snap.tools,
          options: snap.options,
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
      return Stream.fromAsyncIterable((async function* () {
        if (started) return;
        started = true;
        const secret = unsealAuthLease(lease);
        const openai = createOpenAI({ apiKey: secret, baseURL: payload.endpoint, fetch: fetchImpl });
        const model = payload.api === "responses" ? openai.responses(payload.model) : openai.chat(payload.model);
        const tools = Object.fromEntries(payload.tools.map((tool) => [
          tool.name,
          { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) },
        ]));
        const names = new Map<string, string>();
        const result = streamText({
          model,
          system: payload.prompt.system,
          messages: toSdkMessages(payload.prompt) as never,
          ...(payload.tools.length > 0 ? { tools } : {}),
          maxRetries: 0,
          ...generationSettings(payload.options, payload.api),
        });
        for await (const part of result.fullStream) {
          const mapped = mapSdkStreamPart(part, names);
          if (mapped === "skip") continue;
          yield mapped;
        }
      })(), (error) => backendFailureFromUnknown(error));
    },
  });
}

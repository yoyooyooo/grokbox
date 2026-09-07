import { jsonSchema, streamText, type ModelMessage, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONSchema7 } from "ai";
import type { ModelEnvelope, ToolDefinition } from "./envelope.ts";
import { createAs1ModeldDriver, type As1GenerateChunk, type As1GenerateRequest } from "./modeld-as1.ts";
import type { ModeldDriver } from "./modeld.ts";
import type { ModelRecord } from "./models.ts";
import {
  envelopeToOpenAiMessages,
  envelopeToOpenAiToolChoice,
  mapOpenAiStreamEvent,
  openAiAccepts,
  openAiApiMode,
  sanitizeOpenAiError,
  type OpenAiApiMode,
} from "./modeld-openai-map.ts";

export { openAiAccepts, openAiApiMode, envelopeToOpenAiMessages, mapOpenAiStreamEvent, sanitizeOpenAiError };
export type { OpenAiApiMode };

export type OpenAiStreamEvent = { type: string } & Record<string, unknown>;

export type OpenAiGenerateCall = As1GenerateRequest & {
  api: OpenAiApiMode;
  baseURL: string;
};

/**
 * OpenAI Chat Completions or Responses behind existing A+S1.
 * Client-side Host tools only: no execute(), no provider agentic tools, default stopWhen is one step.
 */
export function createOpenAiModeldDriver(input: {
  resolveApiKey: (model: Readonly<ModelRecord>, signal: AbortSignal) => string | Promise<string>;
  fetch?: typeof fetch;
  /** Tests set true. Production callers omit it so admitted+credential models may network. */
  hardOff?: boolean;
  /** Tests replace streamText. Must not be used to hide a second admission kernel. */
  streamEvents?: (call: OpenAiGenerateCall) => AsyncIterable<OpenAiStreamEvent> | Promise<AsyncIterable<OpenAiStreamEvent>>;
}): ModeldDriver {
  return createAs1ModeldDriver({
    accepts: openAiAccepts,
    generate: async function* (request) {
      if (input.hardOff === true) throw new Error("openai-hard-off");
      const api = openAiApiMode(request.pin.model);
      if (!api) throw new Error("wrong-model");
      const call: OpenAiGenerateCall = { ...request, api, baseURL: request.pin.model.endpoint };
      const events = input.streamEvents
        ? await input.streamEvents(call)
        : await liveOpenAiEvents(call, input);
      for await (const event of events) {
        if (request.signal.aborted) throw new Error("cancelled");
        const chunk = mapOpenAiStreamEvent(event);
        if (chunk) yield chunk;
      }
    },
  });
}

async function liveOpenAiEvents(
  call: OpenAiGenerateCall,
  input: {
    resolveApiKey: (model: Readonly<ModelRecord>, signal: AbortSignal) => string | Promise<string>;
    fetch?: typeof fetch;
  },
): Promise<AsyncIterable<OpenAiStreamEvent>> {
  const apiKey = await input.resolveApiKey(call.pin.model, call.signal);
  if (!apiKey) throw new Error("credential-unavailable");
  const openai = createOpenAI({
    apiKey,
    baseURL: call.baseURL,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const model = call.api === "responses" ? openai.responses(call.pin.model.model) : openai.chat(call.pin.model.model);
  const tools = toSdkTools(call.envelope.tools);
  const toolChoice = envelopeToOpenAiToolChoice(call.envelope);
  const result = streamText({
    model,
    messages: envelopeToOpenAiMessages(call.envelope) as ModelMessage[],
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    temperature: call.envelope.options.temperature,
    topP: call.envelope.options.topP,
    seed: call.envelope.options.seed,
    stopSequences: call.envelope.options.stopSequences,
    maxOutputTokens: call.envelope.options.maxTokens,
    abortSignal: call.signal,
    maxRetries: 0,
    onError: () => undefined,
  });
  return mapLiveStream(result.fullStream);
}

async function* mapLiveStream(stream: AsyncIterable<{ type: string } & Record<string, unknown>>): AsyncIterable<OpenAiStreamEvent> {
  try {
    for await (const part of stream) yield part;
  } catch (error) {
    yield { type: "error", error: sanitizeOpenAiError(error) };
  }
}

function toSdkTools(definitions: ToolDefinition[]): ToolSet | undefined {
  if (definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = {
      ...(definition.description ? { description: definition.description } : {}),
      inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
    };
  }
  return tools;
}

export function as1ChunksFromOpenAiEvents(events: Iterable<OpenAiStreamEvent>): As1GenerateChunk[] {
  const chunks: As1GenerateChunk[] = [];
  for (const event of events) {
    const chunk = mapOpenAiStreamEvent(event);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

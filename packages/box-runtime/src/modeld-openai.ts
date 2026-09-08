import { timingSafeEqual } from "node:crypto";
import { jsonSchema, streamText, type ModelMessage, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONSchema7 } from "ai";
import type { ToolDefinition } from "./envelope.ts";
import { sha256Text } from "./hash.ts";
import { createAs1ModeldDriver, type As1GenerateChunk } from "./modeld-as1.ts";
import type { ModeldDriver } from "./modeld.ts";
import type { ModelRecord } from "./models.ts";
import {
  envelopeToOpenAiLivePrompt,
  envelopeToOpenAiMessages,
  envelopeToOpenAiToolChoice,
  mapOpenAiStreamEvent,
  OPENAI_LOCAL_ERROR_MESSAGES,
  openAiAccepts,
  openAiApiMode,
  sanitizeOpenAiError,
  type OpenAiGenerateCall,
  type OpenAiToolNameState,
  type OpenAiStreamEvent,
} from "./modeld-openai-map.ts";

export {
  openAiAccepts, openAiApiMode, envelopeToOpenAiLivePrompt, envelopeToOpenAiMessages,
  mapOpenAiStreamEvent, sanitizeOpenAiError, OPENAI_LOCAL_ERROR_MESSAGES,
};

function credentialMatchesPin(secret: string, fingerprint: string | null): boolean {
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  const actual = sha256Text(secret);
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(fingerprint, "utf8"));
}
export type { OpenAiApiMode, OpenAiGenerateCall, OpenAiStreamEvent } from "./modeld-openai-map.ts";

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
      const toolNames: OpenAiToolNameState = new Map();
      for await (const event of events) {
        if (request.signal.aborted) throw new Error("cancelled");
        const chunk = mapOpenAiStreamEvent(event, toolNames);
        if (chunk) yield chunk;
        if (chunk?.type === "error") return;
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
  if (!apiKey || !credentialMatchesPin(apiKey, call.pin.credentialFingerprint)) {
    throw new Error("credential-unavailable");
  }
  const openai = createOpenAI({
    apiKey,
    baseURL: call.baseURL,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const model = call.api === "responses" ? openai.responses(call.pin.model.model) : openai.chat(call.pin.model.model);
  const prompt = envelopeToOpenAiLivePrompt(call.envelope);
  const tools = toSdkTools(call.envelope.tools);
  const toolChoice = envelopeToOpenAiToolChoice(call.envelope);
  const result = streamText({
    model,
    ...(prompt.system ? { system: prompt.system } : {}),
    messages: prompt.messages as ModelMessage[],
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
  } catch {
    yield { type: "error" };
  }
}


function toSdkTools(definitions: ToolDefinition[]): ToolSet | undefined {
  if (definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    try {
      tools[definition.name] = {
        ...(definition.description ? { description: definition.description } : {}),
        inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
      };
    } catch {
      continue;
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

export function as1ChunksFromOpenAiEvents(events: Iterable<OpenAiStreamEvent>): As1GenerateChunk[] {
  const chunks: As1GenerateChunk[] = [];
  const toolNames: OpenAiToolNameState = new Map();
  for (const event of events) {
    const chunk = mapOpenAiStreamEvent(event, toolNames);
    if (chunk) chunks.push(chunk);
    if (chunk?.type === "error") break;
  }
  return chunks;
}

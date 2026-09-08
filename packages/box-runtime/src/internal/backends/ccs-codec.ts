import { generateText, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  EnvelopeError,
  type ContextSnapshot,
  type GenerationOptions,
  type PromptContentPart,
  type PromptMessage,
} from "@grokbox/runtime-kernel/contract";

export type CcsApi = "chat" | "responses";

export type CcsTextPart = { type: "text"; text: string };
export type CcsImagePart = { type: "image"; image: string; mediaType?: string };
export type CcsReasoningPart = { type: "reasoning"; text: string };
export type CcsPart = CcsTextPart | CcsImagePart | CcsReasoningPart;
export type CcsMessage = {
  role: "user" | "assistant";
  content: string | CcsPart[];
};
export type CcsPrompt = {
  system?: string;
  messages: CcsMessage[];
};

function systemText(content: PromptMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) throw new EnvelopeError("unsupported_content");
  let text = "";
  for (const part of content) {
    if (part.type !== "text") throw new EnvelopeError("unsupported_content");
    text += part.text;
  }
  return text;
}

function toolResultPayload(part: { toolCallId: string; toolName?: string; result: unknown; isError?: boolean }): CcsTextPart {
  return {
    type: "text",
    text: JSON.stringify({
      type: "tool-result",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      result: part.result,
      isError: part.isError === true,
    }),
  };
}

function mapPart(part: PromptContentPart, role: PromptMessage["role"]): CcsPart {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool-result") return toolResultPayload(part);
  if (part.type === "tool-call") {
    if (role !== "assistant") throw new EnvelopeError("unsupported_content");
    return {
      type: "text",
      text: JSON.stringify({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
      }),
    };
  }
  if (part.type === "image") {
    if (role !== "user") throw new EnvelopeError("unsupported_content");
    const image = part.url ?? part.data;
    if (!image) throw new EnvelopeError("unsupported_content");
    return { type: "image", image, ...(part.mimeType ? { mediaType: part.mimeType } : {}) };
  }
  if (part.type === "reasoning") {
    throw new EnvelopeError("unsupported_content");
  }
  throw new EnvelopeError("unsupported_content");
}

function userParts(message: PromptMessage): CcsPart[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.map((part) => mapPart(part, message.role === "tool" ? "user" : message.role));
}

function assistantContent(message: PromptMessage): string | CcsPart[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => mapPart(part, "assistant"));
}

function pushUser(out: CcsMessage[], parts: CcsPart[]): void {
  if (parts.length === 1 && parts[0]!.type === "text") out.push({ role: "user", content: parts[0]!.text });
  else out.push({ role: "user", content: parts });
}

function toSdkMessages(messages: CcsMessage[]) {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        if (part.type === "image") return { type: "image" as const, image: part.image, ...(part.mediaType ? { mediaType: part.mediaType } : {}) };
        return { type: "reasoning" as const, text: part.text };
      }),
    };
  });
}

function generationSettings(options: GenerationOptions, api: CcsApi): {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  seed?: number;
  stopSequences?: string[];
  toolChoice?: GenerationOptions["toolChoice"];
  providerOptions?: { openai: { parallelToolCalls: boolean } };
} {
  if (api === "responses" && (options.seed !== undefined || options.stopSequences !== undefined)) {
    throw new EnvelopeError("unsupported_options");
  }
  return {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    ...(options.parallelToolCalls !== undefined ? { providerOptions: { openai: { parallelToolCalls: options.parallelToolCalls } } } : {}),
  };
}

/** Canonical snapshot → CCS-safe Chat/Responses prompt. Unsupported parts fail closed. */
export function encodeCcsMessages(snapshot: ContextSnapshot): CcsPrompt {
  const systems: string[] = [];
  for (const message of snapshot.systemMessages) {
    const text = systemText(message.content);
    if (text.length === 0) throw new EnvelopeError("invalid_envelope");
    systems.push(text);
  }
  if (systems.length !== 1) throw new EnvelopeError("invalid_envelope");
  const messages: CcsMessage[] = [];
  for (const message of snapshot.messages) {
    if (message.role === "system") throw new EnvelopeError("invalid_envelope");
    if (message.role === "user") {
      pushUser(messages, userParts(message));
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: assistantContent(message) });
      continue;
    }
    if (message.role === "tool") {
      pushUser(messages, userParts({ role: "user", content: message.content }));
    }
  }
  const prompt: CcsPrompt = { system: systems[0], messages };
  const encoded = new TextEncoder().encode(JSON.stringify(prompt)).length;
  if (encoded > ENCODED_PROVIDER_REQUEST_MAX_BYTES) throw new EnvelopeError("envelope_too_large");
  return prompt;
}

export async function sendCcsRequest(input: {
  snapshot: ContextSnapshot;
  api: CcsApi;
  model: string;
  apiKey: string;
  baseURL: string;
  fetch: typeof fetch;
}): Promise<void> {
  const prompt = encodeCcsMessages(input.snapshot);
  const openai = createOpenAI({ apiKey: input.apiKey, baseURL: input.baseURL, fetch: input.fetch });
  const model = input.api === "responses" ? openai.responses(input.model) : openai.chat(input.model);
  const tools = Object.fromEntries(input.snapshot.tools.map((tool) => [
    tool.name,
    { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) },
  ]));
  const settings = generationSettings(input.snapshot.options, input.api);
  await generateText({
    model,
    system: prompt.system,
    messages: toSdkMessages(prompt.messages) as never,
    ...(input.snapshot.tools.length > 0 ? { tools } : {}),
    ...settings,
  });
}

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

export type OpenaiPromptApi = "chat" | "responses";

export type OpenaiPromptTextPart = { type: "text"; text: string };
export type OpenaiPromptImagePart = { type: "image"; image: string; mediaType?: string };
export type OpenaiPromptReasoningPart = { type: "reasoning"; text: string };
export type OpenaiPromptToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };
export type OpenaiPromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName?: string;
  result: unknown;
  isError?: boolean;
};
export type OpenaiPromptPart = OpenaiPromptTextPart | OpenaiPromptImagePart | OpenaiPromptReasoningPart | OpenaiPromptToolCallPart | OpenaiPromptToolResultPart;
export type OpenaiPromptMessage = {
  role: "user" | "assistant" | "tool";
  content: string | OpenaiPromptPart[];
};
export type OpenaiPrompt = {
  system?: string;
  messages: OpenaiPromptMessage[];
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

function asToolResult(part: PromptContentPart): OpenaiPromptToolResultPart {
  if (part.type !== "tool-result") throw new EnvelopeError("unsupported_content");
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: part.result,
    isError: part.isError === true,
  };
}

function assistantParts(message: PromptMessage): OpenaiPromptPart[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "tool-call") {
      return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args };
    }
    if (part.type === "reasoning") return { type: "reasoning", text: part.text };
    throw new EnvelopeError("unsupported_content");
  });
}

function splitUser(message: PromptMessage): { user: OpenaiPromptPart[]; results: OpenaiPromptToolResultPart[] } {
  if (typeof message.content === "string") {
    return { user: [{ type: "text", text: message.content }], results: [] };
  }
  const user: OpenaiPromptPart[] = [];
  const results: OpenaiPromptToolResultPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      user.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      const image = part.url ?? part.data;
      if (!image) throw new EnvelopeError("unsupported_content");
      user.push({ type: "image", image, ...(part.mimeType ? { mediaType: part.mimeType } : {}) });
      continue;
    }
    if (part.type === "tool-result") {
      results.push(asToolResult(part));
      continue;
    }
    throw new EnvelopeError("unsupported_content");
  }
  return { user, results };
}

function pushUser(out: OpenaiPromptMessage[], parts: OpenaiPromptPart[]): void {
  if (parts.length === 0) return;
  if (parts.length === 1 && parts[0]!.type === "text") out.push({ role: "user", content: parts[0]!.text });
  else out.push({ role: "user", content: parts });
}

function pushToolResults(out: OpenaiPromptMessage[], results: OpenaiPromptToolResultPart[]): void {
  if (results.length === 0) return;
  out.push({ role: "tool", content: results });
}

export function toSdkMessages(messages: OpenaiPromptMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content : [];
      return {
        role: "tool" as const,
        content: parts.filter((part): part is OpenaiPromptToolResultPart => part.type === "tool-result").map((part) => ({
          type: "tool-result" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? "",
          output: part.isError === true
            ? { type: "error-json" as const, value: part.result as never }
            : { type: "json" as const, value: part.result as never },
        })),
      };
    }
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        if (part.type === "image") {
          return { type: "image" as const, image: part.image, ...(part.mediaType ? { mediaType: part.mediaType } : {}) };
        }
        // Host plain reasoning is not an OpenAI reasoning item (no itemId/signature).
        if (part.type === "reasoning") return { type: "text" as const, text: part.text };
        if (part.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.args,
          };
        }
        throw new EnvelopeError("unsupported_content");
      }),
    };
  });
}

export function generationSettings(options: GenerationOptions, api: OpenaiPromptApi): {
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

/** Host snapshot → Chat/Responses prompt via AI SDK tool/reasoning parts. Not JSON-in-text history. */
export function encodeOpenaiPrompt(snapshot: ContextSnapshot): OpenaiPrompt {
  const systems: string[] = [];
  for (const message of snapshot.systemMessages) {
    const text = systemText(message.content);
    if (text.length === 0) throw new EnvelopeError("invalid_envelope");
    systems.push(text);
  }
  if (systems.length !== 1) throw new EnvelopeError("invalid_envelope");
  const messages: OpenaiPromptMessage[] = [];
  for (const message of snapshot.messages) {
    if (message.role === "system") throw new EnvelopeError("invalid_envelope");
    if (message.role === "user") {
      const split = splitUser(message);
      if (split.user.length === 0 && split.results.length === 0) {
        messages.push({ role: "user", content: "" });
        continue;
      }
      pushUser(messages, split.user);
      pushToolResults(messages, split.results);
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: assistantParts(message) });
      continue;
    }
    if (message.role === "tool") {
      if (typeof message.content === "string") throw new EnvelopeError("unsupported_content");
      pushToolResults(messages, message.content.map(asToolResult));
    }
  }
  const prompt: OpenaiPrompt = { system: systems[0], messages };
  const encoded = new TextEncoder().encode(JSON.stringify(prompt)).length;
  if (encoded > ENCODED_PROVIDER_REQUEST_MAX_BYTES) throw new EnvelopeError("envelope_too_large");
  return prompt;
}

export async function sendOpenaiPrompt(input: {
  snapshot: ContextSnapshot;
  api: OpenaiPromptApi;
  model: string;
  apiKey: string;
  baseURL: string;
  fetch: typeof fetch;
}): Promise<void> {
  const prompt = encodeOpenaiPrompt(input.snapshot);
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

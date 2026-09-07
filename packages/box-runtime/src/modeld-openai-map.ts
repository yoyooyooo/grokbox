import type { ModelEnvelope, PromptContentPart, PromptMessage } from "./envelope.ts";
import type { As1GenerateChunk, As1GenerateRequest } from "./modeld-as1.ts";
import { STUB_ECHO_MODEL_ID } from "./models.ts";
import type { ModelRecord } from "./models.ts";

export type OpenAiApiMode = "chat" | "responses";
export type OpenAiStreamEvent = { type: string } & Record<string, unknown>;
export type OpenAiGenerateCall = As1GenerateRequest & {
  api: OpenAiApiMode;
  baseURL: string;
};

/** Structural AI SDK prompt messages. Mapping stays SDK-package-free. */
export type OpenAiPromptMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
};

export function openAiApiMode(model: Readonly<ModelRecord>): OpenAiApiMode | null {
  if (model.id === STUB_ECHO_MODEL_ID || model.provider === "stub") return null;
  if (model.provider === "openai-responses") return "responses";
  if (model.provider === "openai" || model.provider === "openai-chat") return "chat";
  return null;
}

export function openAiAccepts(model: Readonly<ModelRecord>): boolean {
  return openAiApiMode(model) !== null && /^https?:\/\//i.test(model.endpoint);
}

export function envelopeToOpenAiMessages(envelope: ModelEnvelope): OpenAiPromptMessage[] {
  return envelope.messages.map(messageToOpenAi);
}

function messageToOpenAi(message: PromptMessage): OpenAiPromptMessage {
  if (message.role === "system") {
    return { role: "system", content: contentText(message.content) };
  }
  if (message.role === "tool") {
    const parts = Array.isArray(message.content) ? message.content : [];
    const results = parts.filter((part): part is Extract<PromptContentPart, { type: "tool-result" }> => part.type === "tool-result");
    if (results.length === 0) throw new Error("openai-tool-message-missing-result");
    return {
      role: "tool",
      content: results.map((part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName ?? "tool",
        output: part.isError === true
          ? { type: "error-json", value: part.result }
          : { type: "json", value: part.result },
      })),
    };
  }
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  const mapped = message.content.flatMap((part) => mapContentPart(part, message.role)).filter((part) => part !== null);
  if (mapped.length === 0) return { role: message.role, content: "" };
  if (mapped.length === 1 && mapped[0]!.type === "text" && message.role !== "assistant") {
    return { role: message.role, content: String(mapped[0]!.text) };
  }
  return { role: message.role, content: mapped as Array<Record<string, unknown>> };
}

function mapContentPart(part: PromptContentPart, role: PromptMessage["role"]): Array<Record<string, unknown>> {
  if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
  if (part.type === "reasoning") return part.text ? [{ type: "reasoning", text: part.text }] : [];
  if (part.type === "image") {
    if (role !== "user") throw new Error("openai-image-not-user");
    const image = part.url ?? part.data;
    if (!image) return [];
    return [{ type: "image", image, ...(part.mimeType ? { mediaType: part.mimeType } : {}) }];
  }
  if (part.type === "tool-call") {
    if (role !== "assistant") throw new Error("openai-tool-call-not-assistant");
    return [{ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.args }];
  }
  if (part.type === "tool-result") {
    return [{
      type: "tool-result",
      toolCallId: part.toolCallId,
      toolName: part.toolName ?? "tool",
      output: part.isError === true
        ? { type: "error-json", value: part.result }
        : { type: "json", value: part.result },
    }];
  }
  return [];
}

function contentText(content: PromptMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text" || part.type === "reasoning").map((part) => part.text).join("");
}

export function envelopeToOpenAiToolChoice(envelope: ModelEnvelope): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  return envelope.options.toolChoice;
}

/** Map AI SDK v5 fullStream parts (and v4 aliases) onto As1 chunks. Unknown types are skipped. */
export function mapOpenAiStreamEvent(part: { type: string } & Record<string, unknown>): As1GenerateChunk | null {
  if (part.type === "text-delta") {
    const text = stringField(part, "text") ?? stringField(part, "textDelta") ?? "";
    return text ? { type: "text", text } : null;
  }
  if (part.type === "reasoning-delta" || part.type === "reasoning") {
    const text = stringField(part, "text") ?? stringField(part, "textDelta") ?? "";
    return text ? { type: "reasoning", text } : null;
  }
  if (part.type === "tool-input-start" || part.type === "tool-call-streaming-start") {
    const toolCallId = stringField(part, "id") ?? stringField(part, "toolCallId");
    const toolName = stringField(part, "toolName");
    if (!toolCallId || !toolName) return null;
    return { type: "tool-call-start", toolCallId, toolName };
  }
  if (part.type === "tool-input-delta" || part.type === "tool-call-delta") {
    const toolCallId = stringField(part, "id") ?? stringField(part, "toolCallId");
    const toolName = stringField(part, "toolName") ?? "tool";
    const argsTextDelta = stringField(part, "delta") ?? stringField(part, "argsTextDelta") ?? "";
    if (!toolCallId) return null;
    return { type: "tool-call-delta", toolCallId, toolName, argsTextDelta };
  }
  if (part.type === "tool-call") {
    const toolCallId = stringField(part, "toolCallId");
    const toolName = stringField(part, "toolName");
    if (!toolCallId || !toolName) return null;
    const args = "input" in part ? part.input : part.args;
    return { type: "tool-call", toolCallId, toolName, args };
  }
  if (part.type === "error") {
    return { type: "error", code: "driver-failed", message: sanitizeOpenAiError(part.error) };
  }
  if (part.type === "abort") return { type: "finish", reason: "abort" };
  if (part.type === "finish") {
    const reason = part.finishReason === "error" ? "error" : part.finishReason === "abort" ? "abort" : "stop";
    return { type: "finish", reason };
  }
  return null;
}

export function sanitizeOpenAiError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "openai-driver-failed";
  return text
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 240);
}

function stringField(part: Record<string, unknown>, key: string): string | undefined {
  const value = part[key];
  return typeof value === "string" ? value : undefined;
}

import type { ModelEnvelope, PromptContentPart, PromptMessage } from "./envelope.ts";
import type { As1GenerateChunk, As1GenerateRequest } from "./modeld-as1.ts";
import type { ModelRecord } from "./models.ts";

export type OpenAiApiMode = "chat" | "responses";
export type OpenAiStreamEvent = { type: string } & Record<string, unknown>;
export type OpenAiGenerateCall = As1GenerateRequest & {
  api: OpenAiApiMode;
  baseURL: string;
};

export const OPENAI_LOCAL_ERROR_MESSAGES = {
  invalid_stream: "The model returned an invalid stream. The request was stopped without retry.",
  model_error: "The configured model request failed. No fallback model was used.",
} as const;

export type OpenAiToolNameState = Map<string, string>;

/** Structural AI SDK prompt messages. Mapping stays SDK-package-free. */
export type OpenAiPromptMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
};

export function openAiApiMode(model: Readonly<ModelRecord>): OpenAiApiMode | null {
  if (model.id === "stub/echo" || model.provider === "stub") return null;
  if (model.provider === "openai-responses") return "responses";
  if (model.provider === "openai" || model.provider === "openai-chat") return "chat";
  return null;
}

export function openAiAccepts(model: Readonly<ModelRecord>): boolean {
  return openAiApiMode(model) !== null
    && /^https?:\/\//i.test(model.endpoint)
    && typeof model.apiKeyRef === "string"
    && model.apiKeyRef.length > 0;
}

export function envelopeToOpenAiMessages(envelope: ModelEnvelope): OpenAiPromptMessage[] {
  return envelope.messages.map(messageToOpenAi);
}

const LIVE_TEXT_MESSAGE_CAP = 400;
const LIVE_TEXT_CHAR_CAP = 160_000;
const LIVE_NOISE_USER = /SAND_HIDDEN|ack-redrive/i;
const LIVE_NOISE_ASSISTANT = /The configured model request failed|No fallback model was used|No model request was sent/;

function sendToUserBubble(content: PromptMessage["content"]): string {
  if (typeof content === "string") return "";
  for (const part of content) {
    if (part.type !== "tool-call") continue;
    if (!/send[_-]?to[_-]?user|send[_-]?message/i.test(part.toolName)) continue;
    const args = part.args;
    if (typeof args === "string" && args.trim()) return args.trim();
    if (args === null || typeof args !== "object" || Array.isArray(args)) continue;
    const record = args as Record<string, unknown>;
    const text = record.text;
    if (text !== null && typeof text === "object" && !Array.isArray(text) && typeof (text as { content?: unknown }).content === "string") {
      const bubble = (text as { content: string }).content.trim();
      if (bubble) return bubble;
    }
    if (typeof text === "string" && text.trim()) return text.trim();
    if (typeof record.content === "string" && record.content.trim()) return record.content.trim();
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  }
  return "";
}

function liveTurnText(message: PromptMessage): string {
  const text = contentText(message.content).trim();
  if (message.role === "assistant") return text || sendToUserBubble(message.content);
  return text;
}

/**
 * Live managed prompt: Host conversation as CCS-safe user/assistant **text**.
 * Reconstructs SendToUser bubbles as assistant text. Drops tool roles, tool-call
 * parts, SAND_HIDDEN / ack-redrive, and synthetic failure rows. Responses rejected
 * raw tool history (`model_error` / normalize); Host still executes SendToUser.
 * Oldest-first drop under count/char caps; always ends on the latest user turn.
 */
export function envelopeToOpenAiLivePrompt(envelope: ModelEnvelope): {
  system?: string;
  messages: OpenAiPromptMessage[];
} {
  const systems: string[] = [];
  const texts: OpenAiPromptMessage[] = [];
  for (const message of envelope.messages) {
    if (message.role === "system") {
      const text = contentText(message.content).trim();
      if (text) systems.push(text);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = liveTurnText(message);
    if (!text) continue;
    if (message.role === "user" && LIVE_NOISE_USER.test(text)) continue;
    if (message.role === "assistant" && LIVE_NOISE_ASSISTANT.test(text)) continue;
    texts.push({ role: message.role, content: text });
  }
  let kept = texts.slice(-LIVE_TEXT_MESSAGE_CAP);
  while (kept.length > 0 && kept[kept.length - 1]!.role !== "user") kept.pop();
  let chars = kept.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
  while (kept.length > 1 && chars > LIVE_TEXT_CHAR_CAP) {
    const removed = kept.shift()!;
    chars -= typeof removed.content === "string" ? removed.content.length : 0;
    if (kept[0]?.role === "assistant") {
      const extra = kept.shift()!;
      chars -= typeof extra.content === "string" ? extra.content.length : 0;
    }
  }
  if (kept.length === 0 || kept[kept.length - 1]!.role !== "user") {
    throw new Error("openai-live-prompt-missing-user");
  }
  return {
    ...(systems.length > 0 ? { system: systems.join("\n\n") } : {}),
    messages: kept,
  };
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

function invalidToolStream(): As1GenerateChunk {
  return { type: "error", code: "invalid_stream", message: OPENAI_LOCAL_ERROR_MESSAGES.invalid_stream };
}

/** Map AI SDK v5 fullStream parts (and v4 aliases) onto As1 chunks. Unknown types are skipped. */
export function mapOpenAiStreamEvent(
  part: { type: string } & Record<string, unknown>,
  toolNames: OpenAiToolNameState = new Map(),
): As1GenerateChunk | null {
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
    if (!toolCallId || !toolName || toolNames.has(toolCallId)) return invalidToolStream();
    toolNames.set(toolCallId, toolName);
    return { type: "tool-call-start", toolCallId, toolName };
  }
  if (part.type === "tool-input-delta" || part.type === "tool-call-delta") {
    const toolCallId = stringField(part, "id") ?? stringField(part, "toolCallId");
    if (!toolCallId) return invalidToolStream();
    const correlatedName = toolNames.get(toolCallId);
    const explicitName = stringField(part, "toolName");
    if (correlatedName && explicitName && correlatedName !== explicitName) return invalidToolStream();
    const toolName = correlatedName ?? explicitName;
    if (!toolName) return invalidToolStream();
    if (!correlatedName) toolNames.set(toolCallId, toolName);
    const argsTextDelta = stringField(part, "delta") ?? stringField(part, "argsTextDelta") ?? "";
    return { type: "tool-call-delta", toolCallId, toolName, argsTextDelta };
  }
  if (part.type === "tool-call") {
    const toolCallId = stringField(part, "toolCallId") ?? stringField(part, "id");
    if (!toolCallId) return invalidToolStream();
    const correlatedName = toolNames.get(toolCallId);
    const explicitName = stringField(part, "toolName");
    if (correlatedName && explicitName && correlatedName !== explicitName) return invalidToolStream();
    const toolName = correlatedName ?? explicitName;
    if (!toolName) return invalidToolStream();
    toolNames.delete(toolCallId);
    const args = "input" in part ? part.input : part.args;
    return { type: "tool-call", toolCallId, toolName, args };
  }
  if (part.type === "error") {
    return { type: "error", code: "model_error", message: OPENAI_LOCAL_ERROR_MESSAGES.model_error };
  }
  if (part.type === "abort") return { type: "finish", reason: "abort" };
  if (part.type === "finish") {
    const reason = part.finishReason === "error" ? "error" : part.finishReason === "abort" ? "abort" : "stop";
    return { type: "finish", reason };
  }
  return null;
}

/** Compatibility export: provider text never crosses the modeld boundary; all failures use one local message. */
export function sanitizeOpenAiError(_error: unknown): string {
  return OPENAI_LOCAL_ERROR_MESSAGES.model_error;
}

function stringField(part: Record<string, unknown>, key: string): string | undefined {
  const value = part[key];
  return typeof value === "string" ? value : undefined;
}

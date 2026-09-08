import { generateText, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  ENCODED_PROVIDER_REQUEST_MAX_BYTES,
  EnvelopeError,
  type ContextSnapshot,
  type PromptMessage,
} from "@grokbox/runtime-kernel/contract";

export type CcsApi = "chat" | "responses";

export type CcsTextPart = { type: "text"; text: string };
export type CcsMessage = {
  role: "system" | "user" | "assistant";
  content: string | CcsTextPart[];
};

function textOf(content: PromptMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text" || part.type === "reasoning").map((part) => part.text).join("");
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

function userParts(message: PromptMessage): CcsTextPart[] {
  if (typeof message.content === "string") return message.content ? [{ type: "text", text: message.content }] : [];
  const parts: CcsTextPart[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) parts.push({ type: "text", text: part.text });
    if (part.type === "tool-result") parts.push(toolResultPayload(part));
  }
  return parts;
}

function assistantContent(message: PromptMessage): string | CcsTextPart[] {
  if (typeof message.content === "string") return message.content;
  const parts: CcsTextPart[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) parts.push({ type: "text", text: part.text });
    if (part.type === "tool-call") {
      parts.push({
        type: "text",
        text: JSON.stringify({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
        }),
      });
    }
  }
  return parts;
}

/** Canonical snapshot → CCS-safe Chat/Responses messages. No role=tool, no extra Human turn, no 1500/8000 truncation. */
export function encodeCcsMessages(snapshot: ContextSnapshot): CcsMessage[] {
  const out: CcsMessage[] = [];
  for (const message of snapshot.systemMessages) {
    const text = textOf(message.content);
    if (text) out.push({ role: "system", content: text });
  }
  for (const message of snapshot.messages) {
    if (message.role === "system") throw new EnvelopeError("invalid_envelope");
    if (message.role === "user") {
      const parts = userParts(message);
      if (parts.length === 1) out.push({ role: "user", content: parts[0]!.text });
      else if (parts.length > 1) out.push({ role: "user", content: parts });
      continue;
    }
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: assistantContent(message) });
      continue;
    }
    if (message.role === "tool") {
      const parts = userParts({ role: "user", content: message.content });
      if (parts.length === 1) out.push({ role: "user", content: parts[0]!.text });
      else if (parts.length > 0) out.push({ role: "user", content: parts });
    }
  }
  const encoded = new TextEncoder().encode(JSON.stringify(out)).length;
  if (encoded > ENCODED_PROVIDER_REQUEST_MAX_BYTES) throw new EnvelopeError("envelope_too_large");
  return out;
}

export async function sendCcsRequest(input: {
  snapshot: ContextSnapshot;
  api: CcsApi;
  model: string;
  apiKey: string;
  baseURL: string;
  fetch: typeof fetch;
}): Promise<void> {
  const messages = encodeCcsMessages(input.snapshot);
  const openai = createOpenAI({ apiKey: input.apiKey, baseURL: input.baseURL, fetch: input.fetch });
  const model = input.api === "responses" ? openai.responses(input.model) : openai.chat(input.model);
  const tools = Object.fromEntries(input.snapshot.tools.map((tool) => [
    tool.name,
    { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) },
  ]));
  await generateText({
    model,
    messages: messages as never,
    ...(input.snapshot.tools.length > 0 ? { tools } : {}),
  });
}

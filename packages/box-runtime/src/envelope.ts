/** Provider-neutral, in-memory model boundary. No transport, tool execution, logging or secret unwrapping. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ToolCall = { type: "tool-call"; toolCallId: string; toolName: string; args: JsonValue };
export type ToolResult = { type: "tool-result"; toolCallId: string; toolName?: string; result: JsonValue; isError?: boolean };
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string }
  | ToolCall | ToolResult;
export type PromptMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | PromptContentPart[] };
export type ToolDefinition = { name: string; description?: string; inputSchema: { [key: string]: JsonValue } };
export type GenerationOptions = {
  temperature?: number; topP?: number; maxTokens?: number; seed?: number;
  stopSequences?: string[]; parallelToolCalls?: boolean;
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; toolName: string };
};
export type ModelEnvelope = { version: 1; messages: PromptMessage[]; tools: ToolDefinition[]; options: GenerationOptions };
export type EnvelopeErrorCode = "invalid_envelope" | "unsupported_content" | "invalid_tools" | "unsupported_options" | "envelope_too_large";
export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode) { super(code); }
}
export const ENVELOPE_MAX_BYTES = 64 * 1024;
const fail = (code: EnvelopeErrorCode = "invalid_envelope"): never => { throw new EnvelopeError(code); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : fail();

/** Plain JSON snapshots only. Accessors, opaque/redacted wrappers, cycles and executable values are not unwrapped. */
export function cloneJson(value: unknown, depth = 0, budget = { nodes: 0 }): JsonValue {
  if (++budget.nodes > 16384 || depth > 32) return fail("envelope_too_large");
  if (typeof value === "string" && value.length > ENVELOPE_MAX_BYTES) return fail("envelope_too_large");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 16384 || Object.keys(value).length !== value.length) return fail("invalid_envelope");
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail("unsupported_content");
      return cloneJson(descriptor.value, depth + 1, budget);
    });
  }
  if (!object(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && (Object.getPrototypeOf(proto) !== null || Object.getOwnPropertyDescriptor(proto, "constructor")?.value?.name !== "Object")) return fail("unsupported_content");
  const result: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) return fail("unsupported_content");
    Object.defineProperty(result, key, { value: cloneJson(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function contentPart(value: unknown, role: PromptMessage["role"]): PromptContentPart {
  if (!object(value)) return fail("unsupported_content");
  const fields: Record<string, string[]> = {
    text: ["type", "text"], reasoning: ["type", "text"], image: ["type", "url", "image", "data", "mimeType"],
    "tool-call": ["type", "toolCallId", "toolName", "args"], "tool-result": ["type", "toolCallId", "toolName", "result", "isError"],
  };
  if (typeof value.type !== "string" || !Object.hasOwn(fields, value.type) || Object.keys(value).some((key) => !fields[value.type as string]!.includes(key))) return fail("unsupported_content");
  if (value.type === "text" || value.type === "reasoning") {
    if (typeof value.text !== "string") return fail("unsupported_content");
    return { type: value.type, text: value.text };
  }
  if (value.type === "image") {
    const url = value.url ?? value.image;
    if ((typeof url !== "string" || !url) && (typeof value.data !== "string" || !value.data)) return fail("unsupported_content");
    if ((url !== undefined && value.data !== undefined) || (value.url !== undefined && value.image !== undefined)) return fail("unsupported_content");
    if (value.mimeType !== undefined && typeof value.mimeType !== "string") return fail("unsupported_content");
    return { type: "image", ...(url !== undefined ? { url: url as string } : { data: value.data as string }),
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType as string } : {}) };
  }
  if (value.type === "tool-call" && role === "assistant") {
    return { type: "tool-call", toolCallId: id(value.toolCallId), toolName: id(value.toolName), args: cloneJson(value.args) };
  }
  if (value.type === "tool-result" && (role === "tool" || role === "user")) {
    if (value.isError !== undefined && typeof value.isError !== "boolean") return fail();
    return { type: "tool-result", toolCallId: id(value.toolCallId), result: cloneJson(value.result),
      ...(value.toolName !== undefined ? { toolName: id(value.toolName) } : {}),
      ...(value.isError !== undefined ? { isError: value.isError as boolean } : {}) };
  }
  return fail("unsupported_content");
}

function messagesFrom(value: unknown): PromptMessage[] {
  if (!Array.isArray(value) || value.length > 1024) return fail();
  return value.map((raw) => {
    if (!object(raw) || !["system", "user", "assistant", "tool"].includes(String(raw.role))) return fail();
    if (Object.keys(raw).some((key) => !["role", "content", "toolCalls"].includes(key))) return fail("unsupported_content");
    const role = raw.role as PromptMessage["role"];
    let content: PromptMessage["content"];
    if (typeof raw.content === "string") content = raw.content;
    else if (Array.isArray(raw.content)) content = raw.content.map((part) => contentPart(part, role));
    else return fail("unsupported_content");
    // Compatibility with grokbox's old internal response, never a second executable call list.
    if (raw.toolCalls !== undefined) {
      if (role !== "assistant" || !Array.isArray(raw.toolCalls)) return fail();
      const blocks: PromptContentPart[] = typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content;
      for (const call of raw.toolCalls) {
        if (!object(call)) return fail();
        const next: ToolCall = { type: "tool-call", toolCallId: id(call.id), toolName: id(call.name), args: cloneJson(call.args) };
        const existing = blocks.find((part) => part.type === "tool-call" && part.toolCallId === next.toolCallId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(next)) return fail();
        if (!existing) blocks.push(next);
      }
      content = blocks;
    }
    return { role, content };
  });
}

function toolField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, "value")) return fail("invalid_tools");
  return descriptor?.value;
}

function toolsFrom(value: unknown): ToolDefinition[] {
  if (value == null) return [];
  let entries: Array<readonly [string | undefined, unknown]>;
  if (Array.isArray(value)) {
    if (value.length > 128 || Object.keys(value).length !== value.length) return fail("invalid_tools");
    entries = Array.from({ length: value.length }, (_, index) => [undefined, toolField(value, String(index))] as const);
  } else {
    if (!object(value)) return fail("invalid_tools");
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && (Object.getPrototypeOf(proto) !== null || Object.getOwnPropertyDescriptor(proto, "constructor")?.value?.name !== "Object")) return fail("invalid_tools");
    entries = Object.keys(value).map((key) => [key, toolField(value, key)] as const);
  }
  if (entries.length > 128) return fail("invalid_tools");
  const names = new Set<string>();
  return entries.map(([key, tool]) => {
    if (!object(tool)) return fail("invalid_tools");
    const declaredName = toolField(tool, "name");
    const name = id(declaredName ?? key);
    if (names.has(name) || (key !== undefined && declaredName !== undefined && key !== declaredName)) return fail("invalid_tools");
    names.add(name);
    let schema = toolField(tool, "inputSchema") ?? toolField(tool, "parameters") ?? toolField(tool, "schema");
    if (object(schema) && toolField(schema, "jsonSchema") !== undefined) schema = toolField(schema, "jsonSchema");
    const cloned = cloneJson(schema);
    if (!object(cloned) || cloned.type !== "object") return fail("invalid_tools");
    const description = toolField(tool, "description");
    if (description !== undefined && (typeof description !== "string" || description.length > ENVELOPE_MAX_BYTES)) return fail("invalid_tools");
    return { name, inputSchema: cloned as ToolDefinition["inputSchema"], ...(description !== undefined ? { description: description as string } : {}) };
  });
}

function optionsFrom(value: unknown): GenerationOptions {
  if (value == null) return {};
  if (!object(value)) return fail("unsupported_options");
  const allowed = ["abortSignal", "signal", "temperature", "topP", "maxTokens", "seed", "stopSequences", "parallelToolCalls", "toolChoice"];
  if (Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => descriptor.enumerable && (!allowed.includes(key) || !Object.hasOwn(descriptor, "value")))) return fail("unsupported_options");
  const out: GenerationOptions = {};
  for (const key of ["abortSignal", "signal"]) if (value[key] !== undefined && !(value[key] instanceof AbortSignal)) return fail("unsupported_options");
  for (const key of ["temperature", "topP", "maxTokens", "seed"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || (key === "maxTokens" && (!Number.isSafeInteger(n) || n <= 0)) ||
      (key === "seed" && !Number.isSafeInteger(n)) || (key === "temperature" && n < 0) || (key === "topP" && (n < 0 || n > 1))) return fail("unsupported_options");
    out[key] = n;
  }
  if (value.stopSequences !== undefined) {
    if (!Array.isArray(value.stopSequences) || value.stopSequences.length > 32 || !value.stopSequences.every((s) => typeof s === "string")) return fail("unsupported_options");
    out.stopSequences = [...value.stopSequences];
  }
  if (value.parallelToolCalls !== undefined) {
    if (typeof value.parallelToolCalls !== "boolean") return fail("unsupported_options");
    out.parallelToolCalls = value.parallelToolCalls;
  }
  if (value.toolChoice !== undefined) {
    if (typeof value.toolChoice === "string" && ["auto", "none", "required"].includes(value.toolChoice)) out.toolChoice = value.toolChoice as "auto" | "none" | "required";
    else {
      const choice = cloneJson(value.toolChoice);
      if (!object(choice) || choice.type !== "tool" || Object.keys(choice).some((key) => !["type", "toolName"].includes(key))) return fail("unsupported_options");
      out.toolChoice = { type: "tool", toolName: id(choice.toolName) };
    }
  }
  return out;
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function buildModelEnvelope(messages: unknown, tools?: unknown, options?: unknown): ModelEnvelope {
  const envelope: ModelEnvelope = { version: 1, messages: messagesFrom(cloneJson(messages)), tools: toolsFrom(tools), options: optionsFrom(options) };
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const message of envelope.messages) {
    if (message.role === "tool" && (typeof message.content === "string" || message.content.some((part) => part.type !== "tool-result"))) return fail();
    for (const part of typeof message.content === "string" ? [] : message.content) {
      if (part.type === "tool-call") {
        if (calls.has(part.toolCallId)) return fail();
        calls.set(part.toolCallId, part.toolName);
      }
      if (part.type === "tool-result") {
        if (!calls.has(part.toolCallId) || results.has(part.toolCallId) || (part.toolName !== undefined && calls.get(part.toolCallId) !== part.toolName)) return fail();
        results.add(part.toolCallId);
      }
    }
  }
  if (typeof envelope.options.toolChoice === "object" && !envelope.tools.some((tool) => tool.name === (envelope.options.toolChoice as { toolName: string }).toolName)) return fail("invalid_tools");
  if (Buffer.byteLength(JSON.stringify(envelope)) > ENVELOPE_MAX_BYTES) return fail("envelope_too_large");
  freezeJson(envelope);
  return envelope;
}

export function parseModelEnvelope(value: unknown): ModelEnvelope {
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "messages", "tools", "options"].includes(key))) return fail();
  return buildModelEnvelope(value.messages, value.tools, value.options);
}

export function envelopeHasImage(envelope: ModelEnvelope): boolean {
  return envelope.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
}

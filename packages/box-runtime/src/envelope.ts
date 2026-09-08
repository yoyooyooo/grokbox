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
  constructor(readonly code: EnvelopeErrorCode, readonly stepReason?: "missing-step-id" | "invalid-step-id") {
    super(code);
  }
}
export const ENVELOPE_MAX_BYTES = 256 * 1024;
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
  if (typeof value.type !== "string" || !Object.hasOwn(fields, value.type)) return fail("unsupported_content");
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

function ownData(value: object, key: string): { kind: "absent" } | { kind: "accessor" } | { kind: "value"; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { kind: "absent" };
  if (!Object.hasOwn(descriptor, "value")) return { kind: "accessor" };
  return { kind: "value", value: descriptor.value };
}

function hostMessageFields(raw: unknown): { role: string; content: unknown; toolCalls?: unknown } {
  if (!object(raw)) return fail();
  const role = ownData(raw, "role");
  const content = ownData(raw, "content");
  if (role.kind === "absent" || content.kind === "absent") return fail();
  if (role.kind === "accessor" || content.kind === "accessor") return fail("unsupported_content");
  if (typeof role.value !== "string") return fail();
  const tool = ownData(raw, "toolCalls");
  if (tool.kind === "accessor") return fail("unsupported_content");
  return {
    role: role.value,
    content: content.value,
    ...(tool.kind === "value" ? { toolCalls: tool.value } : {}),
  };
}

function messagesFrom(value: unknown): PromptMessage[] {
  if (!Array.isArray(value) || value.length > 1024) return fail();
  if (Object.keys(value).length !== value.length) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail("unsupported_content");
    const raw = hostMessageFields(descriptor.value);
    if (!["system", "user", "assistant", "tool"].includes(raw.role)) return fail();
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
  const read = (key: string): unknown => {
    const field = ownData(value, key);
    if (field.kind === "accessor") return fail("unsupported_options");
    return field.kind === "value" ? field.value : undefined;
  };
  const out: GenerationOptions = {};
  for (const key of ["abortSignal", "signal"]) {
    const signal = read(key);
    if (signal !== undefined && !(signal instanceof AbortSignal)) return fail("unsupported_options");
  }
  for (const key of ["temperature", "topP", "maxTokens", "seed"] as const) {
    const n = read(key);
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || (key === "maxTokens" && (!Number.isSafeInteger(n) || n <= 0)) ||
      (key === "seed" && !Number.isSafeInteger(n)) || (key === "temperature" && n < 0) || (key === "topP" && (n < 0 || n > 1))) return fail("unsupported_options");
    out[key] = n;
  }
  const stopSequences = read("stopSequences");
  if (stopSequences !== undefined) {
    if (!Array.isArray(stopSequences) || stopSequences.length > 32 || !stopSequences.every((s) => typeof s === "string")) return fail("unsupported_options");
    out.stopSequences = [...stopSequences];
  }
  const parallelToolCalls = read("parallelToolCalls");
  if (parallelToolCalls !== undefined) {
    if (typeof parallelToolCalls !== "boolean") return fail("unsupported_options");
    out.parallelToolCalls = parallelToolCalls;
  }
  const toolChoice = read("toolChoice");
  if (toolChoice !== undefined) {
    if (typeof toolChoice === "string" && ["auto", "none", "required"].includes(toolChoice)) out.toolChoice = toolChoice as "auto" | "none" | "required";
    else {
      const choice = cloneJson(toolChoice);
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

function envelopeBytes(messages: PromptMessage[], tools: ToolDefinition[], options: GenerationOptions): number {
  return Buffer.byteLength(JSON.stringify({ version: 1, messages, tools, options }));
}

function toolPairingHolds(messages: PromptMessage[]): boolean {
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && (typeof message.content === "string" || message.content.some((part) => part.type !== "tool-result"))) return false;
    for (const part of typeof message.content === "string" ? [] : message.content) {
      if (part.type === "tool-call") {
        if (calls.has(part.toolCallId)) return false;
        calls.set(part.toolCallId, part.toolName);
      }
      if (part.type === "tool-result") {
        if (!calls.has(part.toolCallId) || results.has(part.toolCallId) || (part.toolName !== undefined && calls.get(part.toolCallId) !== part.toolName)) return false;
        results.add(part.toolCallId);
      }
    }
  }
  return true;
}

function fitMessages(messages: PromptMessage[], tools: ToolDefinition[], options: GenerationOptions): PromptMessage[] {
  let kept = messages;
  while (kept.length > 1 && envelopeBytes(kept, tools, options) > ENVELOPE_MAX_BYTES) kept = kept.slice(1);
  while (kept.length > 1 && !toolPairingHolds(kept)) kept = kept.slice(1);
  return kept;
}

export function buildModelEnvelope(messages: unknown, tools?: unknown, options?: unknown): ModelEnvelope {
  const parsedTools = toolsFrom(tools);
  const parsedOptions = optionsFrom(options);
  const envelope: ModelEnvelope = {
    version: 1,
    messages: fitMessages(messagesFrom(messages), parsedTools, parsedOptions),
    tools: parsedTools,
    options: parsedOptions,
  };
  if (!toolPairingHolds(envelope.messages)) return fail();
  if (typeof envelope.options.toolChoice === "object" && !envelope.tools.some((tool) => tool.name === (envelope.options.toolChoice as { toolName: string }).toolName)) return fail("invalid_tools");
  if (envelopeBytes(envelope.messages, envelope.tools, envelope.options) > ENVELOPE_MAX_BYTES) return fail("envelope_too_large");
  freezeJson(envelope);
  return envelope;
}

/** Host `getExecutor(state)` snapshot: array, `{ messages }`, empty, or a single message. Does not deep-clone the whole state tree. */
export function hostStateToMessages(state: unknown): PromptMessage[] {
  if (state === undefined || state === null) return [];
  if (Array.isArray(state)) return messagesFrom(state);
  if (object(state)) {
    const field = ownData(state, "messages");
    if (field.kind === "accessor") return fail("unsupported_content");
    if (field.kind === "value" && Array.isArray(field.value)) return messagesFrom(field.value);
    if (Object.keys(state).length === 0) return [];
  }
  return messagesFrom([state]);
}

export function parseModelEnvelope(value: unknown): ModelEnvelope {
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "messages", "tools", "options"].includes(key))) return fail();
  return buildModelEnvelope(value.messages, value.tools, value.options);
}

export function envelopeHasImage(envelope: ModelEnvelope): boolean {
  return envelope.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
}

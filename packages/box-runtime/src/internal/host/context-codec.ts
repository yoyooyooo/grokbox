import {
  EnvelopeError,
  SNAPSHOT_JSON_MAX_BYTES,
  buildModelEnvelope,
  cloneJson,
  contextSnapshotBody,
  parseModelEnvelope,
  parsePromptMessages,
  type ContextSnapshot,
  type JsonValue,
  type ModelEnvelope,
  type PromptMessage,
  type ToolDefinition,
} from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { qualifyHostRootContract } from "./root-contract.ts";

const ENVELOPE_MAX_BYTES = 7 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: ConstructorParameters<typeof EnvelopeError>[0] = "invalid_tools"): never {
  throw new EnvelopeError(code);
}

function ownData(value: object, key: string): { kind: "absent" } | { kind: "accessor" } | { kind: "value"; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { kind: "absent" };
  if (!Object.hasOwn(descriptor, "value")) return { kind: "accessor" };
  return { kind: "value", value: descriptor.value };
}

function toolField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, "value")) return fail("invalid_tools");
  return descriptor?.value;
}

function id(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : fail("invalid_tools");
}

/** Host `getExecutor(state)` snapshot: array, `{ messages }`, empty, or a single message. */
export function hostStateToMessages(state: unknown): PromptMessage[] {
  if (state === undefined || state === null) return [];
  if (Array.isArray(state)) return parsePromptMessages(state);
  if (object(state)) {
    const field = ownData(state, "messages");
    if (field.kind === "accessor") throw new EnvelopeError("unsupported_content");
    if (field.kind === "value" && Array.isArray(field.value)) return parsePromptMessages(field.value);
    if (Object.keys(state).length === 0) return [];
  }
  return parsePromptMessages([state]);
}

const HOST_MESSAGE_KEYS = new Set(["role", "content", "id", "providerOptions", "isSummary", "toolCalls"]);
const HOST_PART_KEYS: Record<string, Set<string>> = {
  text: new Set(["type", "text", "providerOptions"]),
  reasoning: new Set(["type", "text", "providerOptions"]),
  image: new Set(["type", "url", "image", "data", "mimeType", "providerOptions"]),
  "tool-call": new Set(["type", "toolCallId", "toolName", "args"]),
  "tool-result": new Set(["type", "toolCallId", "toolName", "result", "isError"]),
};

export type HostExecutorMessage = {
  role: PromptMessage["role"];
  content: PromptMessage["content"] | Array<Record<string, JsonValue>>;
  id?: string;
  providerOptions?: { [key: string]: JsonValue };
  isSummary?: boolean;
  toolCalls?: Array<{ id: string; name: string; args: JsonValue }>;
};

function rejectUnknownKeys(value: object, allowed: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unsupported_content");
  }
}

function boundedMessageId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value)
    ? value : fail("unsupported_content");
}

function cloneProviderOptions(value: unknown): { [key: string]: JsonValue } {
  if (!object(value)) fail("unsupported_content");
  const cloned = cloneJson(value);
  if (!object(cloned)) fail("unsupported_content");
  return cloned;
}

function cloneHostPart(value: unknown, role: PromptMessage["role"]): Record<string, JsonValue> {
  if (!object(value)) fail("unsupported_content");
  const typeField = ownData(value, "type");
  if (typeField.kind !== "value" || typeof typeField.value !== "string" || !Object.hasOwn(HOST_PART_KEYS, typeField.value)) {
    fail("unsupported_content");
  }
  const type = typeField.value;
  rejectUnknownKeys(value, HOST_PART_KEYS[type]!);
  if (type === "text" || type === "reasoning") {
    const text = ownData(value, "text");
    if (text.kind !== "value" || typeof text.value !== "string") fail("unsupported_content");
    const options = ownData(value, "providerOptions");
    if (options.kind === "accessor") fail("unsupported_content");
    return {
      type,
      text: text.value,
      ...(options.kind === "value" ? { providerOptions: cloneProviderOptions(options.value) } : {}),
    };
  }
  if (type === "image") {
    if (role !== "user") fail("unsupported_content");
    const url = ownData(value, "url");
    const image = ownData(value, "image");
    const data = ownData(value, "data");
    const mime = ownData(value, "mimeType");
    if (url.kind === "accessor" || image.kind === "accessor" || data.kind === "accessor" || mime.kind === "accessor") fail("unsupported_content");
    const href = url.kind === "value" ? url.value : image.kind === "value" ? image.value : undefined;
    const binary = data.kind === "value" ? data.value : undefined;
    if ((typeof href !== "string" || !href) && (typeof binary !== "string" || !binary)) fail("unsupported_content");
    if (href !== undefined && binary !== undefined) fail("unsupported_content");
    if (url.kind === "value" && image.kind === "value") fail("unsupported_content");
    const options = ownData(value, "providerOptions");
    if (options.kind === "accessor") fail("unsupported_content");
    return {
      type,
      ...(typeof href === "string" ? (url.kind === "value" ? { url: href } : { image: href }) : { data: binary as string }),
      ...(mime.kind === "value" ? (typeof mime.value === "string" ? { mimeType: mime.value } : fail("unsupported_content")) : {}),
      ...(options.kind === "value" ? { providerOptions: cloneProviderOptions(options.value) } : {}),
    };
  }
  if (type === "tool-call") {
    if (role !== "assistant") fail("unsupported_content");
    const toolCallId = ownData(value, "toolCallId");
    const toolName = ownData(value, "toolName");
    const args = ownData(value, "args");
    if (toolCallId.kind !== "value" || toolName.kind !== "value" || args.kind !== "value") fail("unsupported_content");
    return { type, toolCallId: boundedMessageId(toolCallId.value), toolName: boundedMessageId(toolName.value), args: cloneJson(args.value) };
  }
  const toolCallId = ownData(value, "toolCallId");
  const toolName = ownData(value, "toolName");
  const result = ownData(value, "result");
  const isError = ownData(value, "isError");
  if (toolCallId.kind !== "value" || result.kind !== "value") fail("unsupported_content");
  if (role !== "tool" && role !== "user") fail("unsupported_content");
  if (toolName.kind === "accessor" || isError.kind === "accessor") fail("unsupported_content");
  if (isError.kind === "value" && typeof isError.value !== "boolean") fail("unsupported_content");
  return {
    type: "tool-result",
    toolCallId: boundedMessageId(toolCallId.value),
    result: cloneJson(result.value),
    ...(toolName.kind === "value" ? { toolName: boundedMessageId(toolName.value) } : {}),
    ...(isError.kind === "value" ? { isError: isError.value as boolean } : {}),
  };
}

function cloneHostToolCalls(value: unknown): HostExecutorMessage["toolCalls"] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) fail("unsupported_content");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !object(descriptor.value)) fail("unsupported_content");
    const call = descriptor.value;
    rejectUnknownKeys(call, new Set(["id", "name", "args"]));
    const idField = ownData(call, "id");
    const name = ownData(call, "name");
    const args = ownData(call, "args");
    if (idField.kind !== "value" || name.kind !== "value" || args.kind !== "value") fail("unsupported_content");
    return { id: boundedMessageId(idField.value), name: boundedMessageId(name.value), args: cloneJson(args.value) };
  });
}

function cloneHostMessages(value: unknown): HostExecutorMessage[] {
  if (!Array.isArray(value) || value.length > 16384 || Object.keys(value).length !== value.length) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !object(descriptor.value)) fail("unsupported_content");
    const raw = descriptor.value;
    rejectUnknownKeys(raw, HOST_MESSAGE_KEYS);
    const roleField = ownData(raw, "role");
    const contentField = ownData(raw, "content");
    if (roleField.kind !== "value" || contentField.kind !== "value") fail(roleField.kind === "accessor" || contentField.kind === "accessor" ? "unsupported_content" : "invalid_envelope");
    if (typeof roleField.value !== "string" || !["system", "user", "assistant", "tool"].includes(roleField.value)) fail();
    const role = roleField.value as PromptMessage["role"];
    let content: HostExecutorMessage["content"];
    if (typeof contentField.value === "string") content = contentField.value;
    else if (Array.isArray(contentField.value)) {
      if (Object.keys(contentField.value).length !== contentField.value.length) fail("unsupported_content");
      content = contentField.value.map((part) => cloneHostPart(part, role));
    } else fail("unsupported_content");
    const idField = ownData(raw, "id");
    const options = ownData(raw, "providerOptions");
    const summary = ownData(raw, "isSummary");
    const toolCalls = ownData(raw, "toolCalls");
    if (idField.kind === "accessor" || options.kind === "accessor" || summary.kind === "accessor" || toolCalls.kind === "accessor") fail("unsupported_content");
    if (summary.kind === "value" && typeof summary.value !== "boolean") fail("unsupported_content");
    return {
      role,
      content,
      ...(idField.kind === "value" ? { id: boundedMessageId(idField.value) } : {}),
      ...(options.kind === "value" ? { providerOptions: cloneProviderOptions(options.value) } : {}),
      ...(summary.kind === "value" ? { isSummary: summary.value as boolean } : {}),
      ...(toolCalls.kind === "value" ? { toolCalls: cloneHostToolCalls(toolCalls.value) } : {}),
    };
  });
}

/** Host-boundary window for executor state. Provider envelope is still built at stream time. */
export function cloneHostExecutorWindow(state: unknown): HostExecutorMessage[] {
  if (state === undefined || state === null) return [];
  if (Array.isArray(state)) return cloneHostMessages(state);
  if (object(state)) {
    const field = ownData(state, "messages");
    if (field.kind === "accessor") fail("unsupported_content");
    if (field.kind === "value" && Array.isArray(field.value)) return cloneHostMessages(field.value);
    if (Object.keys(state).length === 0) return [];
  }
  return cloneHostMessages([state]);
}

/** Host tool registry / parameters|schema|jsonSchema wrappers → canonical tool DTOs. Never execute. */
export function hostToolsToCanonical(value: unknown): ToolDefinition[] {
  if (value == null) return [];
  let entries: Array<readonly [string | undefined, unknown]>;
  if (Array.isArray(value)) {
    if (value.length > 128 || Object.keys(value).length !== value.length) return fail("invalid_tools");
    entries = Array.from({ length: value.length }, (_, index) => [undefined, toolField(value, String(index))] as const);
  } else {
    if (!object(value)) return fail("invalid_tools");
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && (Object.getPrototypeOf(proto) !== null || Object.getOwnPropertyDescriptor(proto, "constructor")?.value?.name !== "Object")) {
      return fail("invalid_tools");
    }
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

export function buildHostEnvelope(messages: unknown, tools?: unknown, options?: unknown): ModelEnvelope {
  return buildModelEnvelope(messages, hostToolsToCanonical(tools), options);
}

export function hostToContextSnapshot(input: {
  profileId: string;
  abiIdentity: string;
  state: unknown;
  tools?: unknown;
  options?: unknown;
  independentRoot?: string;
}): ContextSnapshot {
  const contract = qualifyHostRootContract(input.profileId, input.abiIdentity);
  const selected = hostStateToMessages(input.state);
  const fromState = selected.filter((message) => message.role === "system");
  const rest = selected.filter((message) => message.role !== "system");
  const independent = input.independentRoot;
  let systemMessages: PromptMessage[];
  if (contract.rootSource === "independent") {
    if (typeof independent !== "string" || independent.length === 0) throw new EnvelopeError("invalid_envelope");
    if (fromState.length > 0) throw new EnvelopeError("invalid_envelope");
    systemMessages = [{ role: "system", content: independent }];
  } else {
    if (independent !== undefined) throw new EnvelopeError("invalid_envelope");
    if (fromState.length !== 1) throw new EnvelopeError("invalid_envelope");
    systemMessages = fromState;
  }
  const envelope = buildHostEnvelope(rest, input.tools, input.options);
  const body = contextSnapshotBody({
    version: 1,
    profileId: input.profileId,
    abiIdentity: input.abiIdentity,
    systemMessages,
    messages: envelope.messages,
    tools: envelope.tools,
    options: envelope.options,
  });
  const snapshot: ContextSnapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  if (bytes > SNAPSHOT_JSON_MAX_BYTES) throw new EnvelopeError("envelope_too_large");
  return snapshot;
}

export { parseModelEnvelope, type ModelEnvelope, type PromptMessage };

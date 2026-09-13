import {
  EnvelopeError,
  SNAPSHOT_JSON_MAX_BYTES,
  buildModelEnvelope,
  cloneJson,
  contextSnapshotBody,
  parseContextSnapshot,
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

const TOOL_REFERENCE_KINDS = ["call-id", "call-name", "result-id", "result-name", "legacy-id", "legacy-name"] as const;
const TOOL_REFERENCE_ERRORS = ["non-string", "empty", "oversized", "control"] as const;
export const HOST_STATE_SHAPES = ["unknown-field", "part-field", "tool-call-field", "part-kind", "text-type", "content-type", "metadata-shape", "message-id", "tool-id", "state-shape",
  ...TOOL_REFERENCE_KINDS.flatMap((field) => TOOL_REFERENCE_ERRORS.map((error) => `${field}-${error}` as const)),
] as const;
export type HostStateShape = (typeof HOST_STATE_SHAPES)[number];
export class HostStateCodecError extends EnvelopeError {
  constructor(readonly stateShape: HostStateShape) { super("unsupported_content"); }
}
function stateFail(shape: HostStateShape): never { throw new HostStateCodecError(shape); }

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

function isSafePlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, "constructor");
  return !!ctor && Object.hasOwn(ctor, "value") && ctor.value === Object;
}

function optionalDefined(field: ReturnType<typeof ownData>): unknown {
  if (field.kind === "accessor") fail("unsupported_content");
  if (field.kind === "absent" || field.value === undefined) return undefined;
  return field.value;
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
  "tool-call": new Set(["type", "toolCallId", "toolName", "args", "providerOptions"]),
  "tool-result": new Set(["type", "toolCallId", "toolName", "result", "isError", "providerOptions", "experimental_content"]),
};

export type HostExecutorMessage = {
  role: PromptMessage["role"];
  content: PromptMessage["content"] | Array<Record<string, JsonValue | undefined>>;
  id?: JsonValue;
  providerOptions?: { [key: string]: JsonValue };
  isSummary?: boolean;
  toolCalls?: Array<{ id: string; name: string; args: JsonValue }>;
};

function rejectUnknownKeys(value: object, allowed: Set<string>, shape: HostStateShape = "unknown-field"): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) stateFail(shape);
  }
}

/** Provider tool references have a different contract from Host message metadata IDs. */
function boundedToolId(value: unknown, field: (typeof TOOL_REFERENCE_KINDS)[number]): string {
  if (typeof value !== "string") stateFail(`${field}-non-string`);
  if (value.length === 0) stateFail(`${field}-empty`);
  if (value.length > 128) stateFail(`${field}-oversized`);
  if (/[\x00-\x1f]/.test(value)) stateFail(`${field}-control`);
  return value;
}

function cloneProviderOptions(value: unknown): { [key: string]: JsonValue } {
  if (!object(value) || !isSafePlainRecord(value)) stateFail("metadata-shape");
  const cloned = cloneJson(value);
  if (!object(cloned)) fail("unsupported_content");
  return cloned;
}

function cloneHostPart(value: unknown, role: PromptMessage["role"]): Record<string, JsonValue | undefined> {
  if (!object(value)) fail("unsupported_content");
  const typeField = ownData(value, "type");
  if (typeField.kind !== "value" || typeof typeField.value !== "string" || !Object.hasOwn(HOST_PART_KEYS, typeField.value)) {
    stateFail("part-kind");
  }
  const type = typeField.value;
  const metadata = cloneHostMetadata(value, HOST_PART_KEYS[type]!);
  if (type === "text" || type === "reasoning") {
    const text = ownData(value, "text");
    if (text.kind !== "value" || typeof text.value !== "string") stateFail("text-type");
    const options = optionalDefined(ownData(value, "providerOptions"));
    return {
      ...metadata,
      type,
      text: text.value,
      ...(options !== undefined ? { providerOptions: cloneProviderOptions(options) } : {}),
    };
  }
  if (type === "image") {
    if (role !== "user") fail("unsupported_content");
    const url = optionalDefined(ownData(value, "url"));
    const image = optionalDefined(ownData(value, "image"));
    const data = optionalDefined(ownData(value, "data"));
    const mime = optionalDefined(ownData(value, "mimeType"));
    const href = url !== undefined ? url : image;
    if ((typeof href !== "string" || !href) && (typeof data !== "string" || !data)) fail("unsupported_content");
    if (href !== undefined && data !== undefined) fail("unsupported_content");
    if (url !== undefined && image !== undefined) fail("unsupported_content");
    if (mime !== undefined && typeof mime !== "string") fail("unsupported_content");
    const options = optionalDefined(ownData(value, "providerOptions"));
    return {
      ...metadata,
      type,
      ...(typeof href === "string" ? (url !== undefined ? { url: href } : { image: href }) : { data: data as string }),
      ...(mime !== undefined ? { mimeType: mime } : {}),
      ...(options !== undefined ? { providerOptions: cloneProviderOptions(options) } : {}),
    };
  }
  if (type === "tool-call") {
    if (role !== "assistant") fail("unsupported_content");
    const toolCallId = ownData(value, "toolCallId");
    const toolName = ownData(value, "toolName");
    const args = ownData(value, "args");
    if (toolCallId.kind !== "value" || toolName.kind !== "value" || args.kind !== "value") fail("unsupported_content");
    const options = optionalDefined(ownData(value, "providerOptions"));
    return {
      ...metadata,
      type,
      toolCallId: boundedToolId(toolCallId.value, "call-id"),
      toolName: boundedToolId(toolName.value, "call-name"),
      args: cloneJson(args.value),
      ...(options !== undefined ? { providerOptions: cloneProviderOptions(options) } : {}),
    };
  }
  const toolCallId = ownData(value, "toolCallId");
  const toolName = optionalDefined(ownData(value, "toolName"));
  const result = ownData(value, "result");
  const isError = optionalDefined(ownData(value, "isError"));
  const options = optionalDefined(ownData(value, "providerOptions"));
  const experimental = optionalDefined(ownData(value, "experimental_content"));
  if (toolCallId.kind !== "value" || result.kind !== "value") fail("unsupported_content");
  if (role !== "tool" && role !== "user") fail("unsupported_content");
  if (isError !== undefined && typeof isError !== "boolean") fail("unsupported_content");
  return {
    ...metadata,
    type: "tool-result",
    toolCallId: boundedToolId(toolCallId.value, "result-id"),
    result: cloneJson(result.value),
    ...(toolName !== undefined ? { toolName: boundedToolId(toolName, "result-name") } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(options !== undefined ? { providerOptions: cloneProviderOptions(options) } : {}),
    ...(experimental !== undefined ? { experimental_content: cloneJson(experimental) } : {}),
  };
}

function cloneHostToolCalls(value: unknown): HostExecutorMessage["toolCalls"] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) fail("unsupported_content");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !object(descriptor.value)) fail("unsupported_content");
    const call = descriptor.value;
    rejectUnknownKeys(call, new Set(["id", "name", "args"]), "tool-call-field");
    const idField = ownData(call, "id");
    const name = ownData(call, "name");
    const args = ownData(call, "args");
    if (idField.kind !== "value" || name.kind !== "value" || args.kind !== "value") fail("unsupported_content");
    return { id: boundedToolId(idField.value, "legacy-id"), name: boundedToolId(name.value, "legacy-name"), args: cloneJson(args.value) };
  });
}

/** Own-data metadata belongs to the Host, not the provider envelope.
 * Preserve safe JSON extensions at message and known content-part boundaries.
 * The part type and its payload are still explicitly qualified; opaque wrappers/accessors
 * are never unwrapped. Provider projection consumes only the declared semantic fields.
 */
function cloneHostMetadata(value: object, knownKeys: Set<string>): Record<string, JsonValue | undefined> {
  // Only own descriptors are consumed. Message records can cross VM realms; their
  // prototype is neither invoked nor copied. Nested opaque values still fail cloneJson.
  const extra: Record<string, JsonValue | undefined> = {};
  const budget = { nodes: 0 };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 128) fail("envelope_too_large");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") stateFail("metadata-shape");
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || knownKeys.has(key)) continue;
    if (!Object.hasOwn(descriptor, "value")) stateFail("metadata-shape");
    Object.defineProperty(extra, key, {
      value: descriptor.value === undefined ? undefined : cloneJson(descriptor.value, 0, budget),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return extra;
}

function cloneHostMessages(value: unknown): HostExecutorMessage[] {
  if (!Array.isArray(value) || value.length > 16384 || Object.keys(value).length !== value.length) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !object(descriptor.value)) fail("unsupported_content");
    const raw = descriptor.value;
    const metadata = cloneHostMetadata(raw, HOST_MESSAGE_KEYS);
    const roleField = ownData(raw, "role");
    const contentField = ownData(raw, "content");
    if (roleField.kind !== "value" || contentField.kind !== "value") fail(roleField.kind === "accessor" || contentField.kind === "accessor" ? "unsupported_content" : "invalid_envelope");
    if (typeof roleField.value !== "string" || !["system", "user", "assistant", "tool"].includes(roleField.value)) fail();
    const role = roleField.value as PromptMessage["role"];
    let content: HostExecutorMessage["content"];
    if (typeof contentField.value === "string") content = contentField.value;
    else if (Array.isArray(contentField.value)) {
      const parts = contentField.value;
      if (parts.length > 16384 || Object.keys(parts).length !== parts.length) fail("unsupported_content");
      content = Array.from({ length: parts.length }, (_, partIndex) => {
        const part = Object.getOwnPropertyDescriptor(parts, partIndex);
        if (!part || !Object.hasOwn(part, "value")) fail("unsupported_content");
        return cloneHostPart(part.value, role);
      });
    } else stateFail("content-type");
    const id = optionalDefined(ownData(raw, "id"));
    const options = optionalDefined(ownData(raw, "providerOptions"));
    const summary = optionalDefined(ownData(raw, "isSummary"));
    const toolCallsRaw = optionalDefined(ownData(raw, "toolCalls"));
    if (summary !== undefined && typeof summary !== "boolean") fail("unsupported_content");
    const toolCalls = toolCallsRaw !== undefined ? cloneHostToolCalls(toolCallsRaw) : undefined;
    if (toolCalls !== undefined) {
      if (role !== "assistant") fail();
      const seen: Array<{ type: "tool-call"; toolCallId: string; toolName: string; args: JsonValue }> = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string" && part.args !== undefined) {
            seen.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args });
          }
        }
      }
      for (const call of toolCalls) {
        const next = { type: "tool-call" as const, toolCallId: call.id, toolName: call.name, args: call.args };
        const existing = seen.find((part) => part.toolCallId === next.toolCallId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(next)) fail();
        if (!existing) seen.push(next);
      }
    }
    return {
      ...metadata,
      role,
      content,
      ...(id !== undefined ? { id: cloneJson(id) } : {}),
      ...(options !== undefined ? { providerOptions: cloneProviderOptions(options) } : {}),
      ...(summary !== undefined ? { isSummary: summary as boolean } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    };
  });
}

/** Host-boundary window for executor state. Provider envelope is still built at stream time. */
export function cloneHostExecutorWindow(state: unknown): HostExecutorMessage[] {
  if (state === undefined || state === null) return [];
  if (Array.isArray(state)) return cloneHostMessages(state);
  if (!object(state) || !isSafePlainRecord(state)) stateFail("state-shape");
  const field = ownData(state, "messages");
  if (field.kind === "accessor") fail("unsupported_content");
  if (field.kind === "value") {
    if (!Array.isArray(field.value)) fail("unsupported_content");
    return cloneHostMessages(field.value);
  }
  if ("messages" in state) fail("unsupported_content");
  for (const key of HOST_MESSAGE_KEYS) {
    if (ownData(state, key).kind !== "absent") return cloneHostMessages([state]);
  }
  if (Object.keys(state).length === 0) return [];
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
  return parseContextSnapshot(snapshot);
}

export { parseModelEnvelope, type ModelEnvelope, type PromptMessage };

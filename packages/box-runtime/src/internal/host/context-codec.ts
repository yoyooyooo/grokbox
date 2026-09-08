import {
  EnvelopeError,
  buildModelEnvelope,
  cloneJson,
  parseModelEnvelope,
  parsePromptMessages,
  type ModelEnvelope,
  type PromptMessage,
  type ToolDefinition,
} from "@grokbox/runtime-kernel/contract";

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

export { parseModelEnvelope, type ModelEnvelope, type PromptMessage };

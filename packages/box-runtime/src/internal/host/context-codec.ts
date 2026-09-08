import {
  EnvelopeError,
  parsePromptMessages,
  type PromptMessage,
} from "@grokbox/runtime-kernel/contract";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownData(value: object, key: string): { kind: "absent" } | { kind: "accessor" } | { kind: "value"; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { kind: "absent" };
  if (!Object.hasOwn(descriptor, "value")) return { kind: "accessor" };
  return { kind: "value", value: descriptor.value };
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

export {
  buildModelEnvelope,
  parseModelEnvelope,
  type ModelEnvelope,
  type PromptMessage,
} from "@grokbox/runtime-kernel/contract";

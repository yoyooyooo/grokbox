import type { GenerationOptions, PromptMessage, ToolDefinition } from "./context.ts";
import { EnvelopeError, buildModelEnvelope, parsePromptMessages } from "./context.ts";
import { computeSnapshotDigest } from "../../hash.ts";

export type ContextSnapshot = {
  version: 1;
  profileId: string;
  abiIdentity: string;
  systemMessages: PromptMessage[];
  messages: PromptMessage[];
  tools: ToolDefinition[];
  options: GenerationOptions;
  snapshotDigest: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function contextSnapshotBody(snapshot: Omit<ContextSnapshot, "snapshotDigest">): Omit<ContextSnapshot, "snapshotDigest"> {
  return {
    version: 1,
    profileId: snapshot.profileId,
    abiIdentity: snapshot.abiIdentity,
    systemMessages: snapshot.systemMessages,
    messages: snapshot.messages,
    tools: snapshot.tools,
    options: snapshot.options,
  };
}

export function parseContextSnapshot(value: unknown): ContextSnapshot {
  if (!object(value) || value.version !== 1) throw new EnvelopeError("invalid_envelope");
  if (typeof value.profileId !== "string" || value.profileId.length === 0) throw new EnvelopeError("invalid_envelope");
  if (typeof value.abiIdentity !== "string" || value.abiIdentity.length === 0) throw new EnvelopeError("invalid_envelope");
  if (!Array.isArray(value.systemMessages) || !Array.isArray(value.messages) || !Array.isArray(value.tools)) {
    throw new EnvelopeError("invalid_envelope");
  }
  if (typeof value.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)) {
    throw new EnvelopeError("invalid_envelope");
  }
  const systemMessages = parsePromptMessages(value.systemMessages);
  if (systemMessages.some((message) => message.role !== "system")) throw new EnvelopeError("invalid_envelope");
  const envelope = buildModelEnvelope(value.messages, value.tools, value.options);
  if (envelope.messages.some((message) => message.role === "system")) throw new EnvelopeError("invalid_envelope");
  const body = contextSnapshotBody({
    version: 1,
    profileId: value.profileId,
    abiIdentity: value.abiIdentity,
    systemMessages,
    messages: envelope.messages,
    tools: envelope.tools,
    options: envelope.options,
  });
  const snapshotDigest = computeSnapshotDigest(body);
  if (snapshotDigest !== value.snapshotDigest) throw new EnvelopeError("invalid_envelope");
  const snapshot: ContextSnapshot = { ...body, snapshotDigest };
  freezeJson(snapshot);
  return snapshot;
}

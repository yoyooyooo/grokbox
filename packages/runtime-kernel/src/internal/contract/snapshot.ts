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
  /** Kernel-owned preparation metadata. Host wire submissions cannot supply it. */
  contextBudget?: { inputTokens: number; outputTokens: number; policyRevision: string };
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
    ...(snapshot.contextBudget ? { contextBudget: snapshot.contextBudget } : {}),
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
  let contextBudget: ContextSnapshot["contextBudget"];
  if (value.contextBudget !== undefined) {
    const b = value.contextBudget;
    if (!object(b) || Object.keys(b).some(key => !["inputTokens", "outputTokens", "policyRevision"].includes(key))
      || !Number.isSafeInteger(b.inputTokens) || Number(b.inputTokens) <= 0 || !Number.isSafeInteger(b.outputTokens) || Number(b.outputTokens) <= 0
      || typeof b.policyRevision !== "string" || !/^[a-f0-9]{64}$/.test(b.policyRevision)) throw new EnvelopeError("invalid_envelope");
    contextBudget = { inputTokens: Number(b.inputTokens), outputTokens: Number(b.outputTokens), policyRevision: b.policyRevision };
  }
  const body = contextSnapshotBody({
    version: 1,
    profileId: value.profileId,
    abiIdentity: value.abiIdentity,
    systemMessages,
    messages: envelope.messages,
    tools: envelope.tools,
    options: envelope.options,
    ...(contextBudget ? { contextBudget } : {}),
  });
  const snapshotDigest = computeSnapshotDigest(body);
  if (snapshotDigest !== value.snapshotDigest) throw new EnvelopeError("invalid_envelope");
  const snapshot: ContextSnapshot = { ...body, snapshotDigest };
  freezeJson(snapshot);
  return snapshot;
}

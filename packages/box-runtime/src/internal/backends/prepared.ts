import type { ReasoningPolicy } from "@grokbox/runtime-kernel/selection";
import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import { cloneJson, type ContextSnapshot, type GenerationOptions, type ToolDefinition } from "@grokbox/runtime-kernel/contract";
import { generationSettings, type OpenaiPromptApi, type OpenaiPrompt } from "./openai-prompt-adapter.ts";

export type PreparedPayload = {
  kind: "echo" | "openai-chat" | "openai-responses";
  prompt: OpenaiPrompt;
  model: string;
  endpoint: string;
  api: OpenaiPromptApi;
  chatDialect?: "standard" | "minimax-inline-v1";
  /** Hash of the route namespace, never the credential value or raw endpoint. */
  routeId?: string;
  tools: ToolDefinition[];
  options: GenerationOptions;
  settings: ReturnType<typeof generationSettings>;
  reasoning?: ReasoningPolicy;
  contextBudget?: ContextSnapshot["contextBudget"];
};

const prepared = new WeakMap<PreparedCall, PreparedPayload>();

export function makePreparedCall(payload: PreparedPayload): PreparedCall {
  const call = Object.freeze(Object.create(null)) as PreparedCall;
  prepared.set(call, payload);
  return call;
}

export function readPreparedCall(call: PreparedCall): PreparedPayload | undefined {
  return prepared.get(call);
}

export function freezePreparedSnapshot(snapshot: ContextSnapshot, api: OpenaiPromptApi, reasoning?: ReasoningPolicy): {
  tools: ToolDefinition[];
  options: GenerationOptions;
  settings: ReturnType<typeof generationSettings>;
  reasoning?: ReasoningPolicy;
  contextBudget?: ContextSnapshot["contextBudget"];
} {
  const tools = cloneJson(snapshot.tools) as ToolDefinition[];
  const options = cloneJson(snapshot.options) as GenerationOptions;
  return { tools, options, settings: generationSettings(options, api, reasoning), ...(reasoning ? { reasoning: Object.freeze({ ...reasoning }) } : {}),
    ...(snapshot.contextBudget ? { contextBudget: Object.freeze({ ...snapshot.contextBudget }) } : {}) };
}

export function makeAuthLease(): AuthLease {
  return Object.freeze(Object.create(null)) as AuthLease;
}

import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import { cloneJson, type ContextSnapshot, type GenerationOptions, type ToolDefinition } from "@grokbox/runtime-kernel/contract";
import { generationSettings, type CcsApi, type CcsPrompt } from "./ccs-codec.ts";

export type PreparedPayload = {
  kind: "echo" | "openai-chat" | "openai-responses";
  prompt: CcsPrompt;
  model: string;
  endpoint: string;
  api: CcsApi;
  tools: ToolDefinition[];
  options: GenerationOptions;
  settings: ReturnType<typeof generationSettings>;
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

export function freezePreparedSnapshot(snapshot: ContextSnapshot, api: CcsApi): {
  tools: ToolDefinition[];
  options: GenerationOptions;
  settings: ReturnType<typeof generationSettings>;
} {
  const tools = cloneJson(snapshot.tools) as ToolDefinition[];
  const options = cloneJson(snapshot.options) as GenerationOptions;
  return { tools, options, settings: generationSettings(options, api) };
}

export function makeAuthLease(): AuthLease {
  return Object.freeze(Object.create(null)) as AuthLease;
}

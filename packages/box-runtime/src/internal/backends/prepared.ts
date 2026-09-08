import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import type { ContextSnapshot } from "@grokbox/runtime-kernel/contract";
import type { CcsApi, CcsPrompt } from "./ccs-codec.ts";

export type PreparedPayload = {
  kind: "echo" | "openai-chat" | "openai-responses";
  prompt: CcsPrompt;
  model: string;
  endpoint: string;
  api: CcsApi;
  tools: ContextSnapshot["tools"];
  options: ContextSnapshot["options"];
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

export function makeAuthLease(): AuthLease {
  return Object.freeze(Object.create(null)) as AuthLease;
}

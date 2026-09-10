import type { HostPromptSession, HostResponse } from "./session.ts";

export const AUX_PURPOSES = ["memory-extraction", "episode"] as const;
export type AuxPurpose = (typeof AUX_PURPOSES)[number];

export type AuxRefuseCode = "auxiliary_unqualified" | "auxiliary_duplicate" | "auxiliary_stale" | "auxiliary_tools";

export type AuxAdmit =
  | { ok: true; purpose: AuxPurpose; auxRequestId: string }
  | { ok: false; code: AuxRefuseCode };

export type AuxOutcome =
  | { kind: "ok"; purpose: AuxPurpose; auxRequestId: string; text: string }
  | { kind: "refused"; code: AuxRefuseCode }
  | { kind: "failed"; purpose: AuxPurpose; auxRequestId: string; code: "auxiliary_failed" | "auxiliary_empty" | "auxiliary_stale" };

function parentIsLive(parentLive: boolean | (() => boolean)): boolean {
  return typeof parentLive === "function" ? parentLive() : parentLive;
}

/** Only explicit absent or empty array is inference-only. Registry/non-empty/unsupported shapes refuse. */
export function toolsInputAllowed(tools: unknown): boolean {
  if (tools === undefined) return true;
  return Array.isArray(tools) && tools.length === 0;
}

/** Purpose is adapter-trusted. Message body is never a purpose source. */
export function admitAuxiliary(input: {
  purpose: unknown;
  auxRequestId: unknown;
  tools?: unknown;
  parentLive: boolean | (() => boolean);
  seen: ReadonlySet<string>;
}): AuxAdmit {
  if (input.purpose !== "memory-extraction" && input.purpose !== "episode") {
    return { ok: false, code: "auxiliary_unqualified" };
  }
  if (typeof input.auxRequestId !== "string" || input.auxRequestId.length === 0 || input.auxRequestId.length > 128 || /[\x00-\x1f]/.test(input.auxRequestId)) {
    return { ok: false, code: "auxiliary_unqualified" };
  }
  if (input.seen.has(input.auxRequestId)) return { ok: false, code: "auxiliary_duplicate" };
  if (!parentIsLive(input.parentLive)) return { ok: false, code: "auxiliary_stale" };
  if (!toolsInputAllowed(input.tools)) return { ok: false, code: "auxiliary_tools" };
  return { ok: true, purpose: input.purpose, auxRequestId: input.auxRequestId };
}

function assistantText(response: HostResponse): string {
  const chunks: string[] = [];
  for (const message of response.messages ?? []) {
    if (typeof message.content === "string") {
      if (message.content.length > 0) chunks.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && part.type === "text" && typeof part.text === "string" && part.text.length > 0) chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function successfulStop(response: HostResponse): boolean {
  return response.finishReason === "stop";
}

export async function runAuxiliary(input: {
  session: HostPromptSession;
  purpose: unknown;
  auxRequestId: unknown;
  tools?: unknown;
  messages?: unknown;
  parentLive: boolean | (() => boolean);
  seen: Set<string>;
  abortSignal?: AbortSignal;
}): Promise<AuxOutcome> {
  const admitted = admitAuxiliary(input);
  if (!admitted.ok) return { kind: "refused", code: admitted.code };
  input.seen.add(admitted.auxRequestId);
  const executor = input.session.getExecutor(input.messages);
  const handle = executor.stream(input.abortSignal ? { signal: input.abortSignal } : {}, undefined, undefined);
  try {
    const response = await handle.response;
    if (!parentIsLive(input.parentLive)) {
      return { kind: "failed", purpose: admitted.purpose, auxRequestId: admitted.auxRequestId, code: "auxiliary_stale" };
    }
    if (input.abortSignal?.aborted === true || !successfulStop(response)) {
      return { kind: "failed", purpose: admitted.purpose, auxRequestId: admitted.auxRequestId, code: "auxiliary_failed" };
    }
    const text = assistantText(response);
    if (!text) return { kind: "failed", purpose: admitted.purpose, auxRequestId: admitted.auxRequestId, code: "auxiliary_empty" };
    return { kind: "ok", purpose: admitted.purpose, auxRequestId: admitted.auxRequestId, text };
  } catch {
    return { kind: "failed", purpose: admitted.purpose, auxRequestId: admitted.auxRequestId, code: "auxiliary_failed" };
  }
}

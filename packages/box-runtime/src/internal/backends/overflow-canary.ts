import { Effect, Stream } from "effect";
import { BackendFailure, isConfirmedOverflow, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import type { CcsPrompt } from "./ccs-codec.ts";
import { observeBackendFailure } from "./failure-observation.ts";
import { readPreparedCall } from "./prepared.ts";

export const MODELD_OVERFLOW_CANARY_AGENT_ENV = "GROKBOX_MODELD_OVERFLOW_CANARY_AGENT";
export const MODELD_OVERFLOW_CANARY_WINDOW_ENV = "GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS";

export type OverflowCanary = {
  agentId: string;
  windowTokens: number;
};

type ModelBackendShape = {
  readonly prepare: (selection: unknown, snapshot: unknown) => Effect.Effect<PreparedCall, unknown>;
  readonly infer: (
    admittedCall: unknown,
    prepared: PreparedCall,
    authLease: AuthLease,
  ) => Stream.Stream<InferenceEvent, unknown>;
};

const AGENT_ID = /^[^\x00-\x1f]{1,128}$/;
const WINDOW_TOKENS = /^[1-9][0-9]{0,14}$/;

/** Both env keys required. Any other shape, including one-sided or non-integer window, stays off. */
export function parseOverflowCanary(env: NodeJS.Dict<string> = {}): OverflowCanary | undefined {
  const agentId = env[MODELD_OVERFLOW_CANARY_AGENT_ENV];
  const windowRaw = env[MODELD_OVERFLOW_CANARY_WINDOW_ENV];
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return undefined;
  if (typeof windowRaw !== "string" || !WINDOW_TOKENS.test(windowRaw)) return undefined;
  const windowTokens = Number(windowRaw);
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) return undefined;
  return { agentId, windowTokens };
}

/** Canary estimator only. UTF-16 text length / 4, ceil. Not a tokenizer and not catalog W. */
export function estimateCanaryTokens(prompt: CcsPrompt): number {
  let chars = prompt.system?.length ?? 0;
  for (const message of prompt.messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") chars += part.text.length;
    }
  }
  return chars <= 0 ? 0 : Math.ceil(chars / 4);
}

export function canaryOverflowFailure(): BackendFailure {
  return observeBackendFailure(
    new BackendFailure("overflow_candidate", {
      overflowCandidate: true,
      overflowEvidence: { providerCode: "context_length_exceeded", httpStatus: 400 },
    }),
    "provider",
    { statusCode: 400, data: { error: { type: "invalid_request_error", code: "context_length_exceeded" } } },
  );
}

export function shouldInterceptOverflowCanary(input: {
  env?: NodeJS.Dict<string>;
  agentId: string;
  prepared: PreparedCall;
}): boolean {
  const canary = parseOverflowCanary(input.env ?? {});
  if (!canary || canary.agentId !== input.agentId) return false;
  const payload = readPreparedCall(input.prepared);
  if (!payload) return false;
  return estimateCanaryTokens(payload.prompt) > canary.windowTokens;
}

/** STEP-scoped CCS intercept. Unset env and fake backends without a prepared prompt pass through. */
export function withOverflowCanary(
  inner: ModelBackendShape,
  agentId: string,
  env: NodeJS.Dict<string> = {},
): ModelBackendShape {
  const canary = parseOverflowCanary(env);
  if (!canary || canary.agentId !== agentId) return inner;
  return {
    prepare: inner.prepare,
    infer: (admitted, prepared, lease) => {
      if (!shouldInterceptOverflowCanary({ env, agentId, prepared })) {
        return inner.infer(admitted, prepared, lease);
      }
      return Stream.fail(canaryOverflowFailure());
    },
  };
}

export function canaryFailureIsConfirmed(failure: BackendFailure): boolean {
  return isConfirmedOverflow(failure.overflowEvidence ?? {});
}

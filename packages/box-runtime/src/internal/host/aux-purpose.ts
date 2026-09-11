import { randomUUID } from "node:crypto";
import { hostVisibleStreamError, type HostPromptExecutor } from "./session.ts";
import type { AuxPurpose } from "./aux-request.ts";

export type HostAuxIntent = Readonly<{
  purpose: AuxPurpose;
  auxRequestId: string;
  turnId: string;
  ctx: unknown;
}>;

// Only the exact Host call-site hook can mint this capability. The usage middleware
// forwards the options object unchanged; no purpose field is read from its body.
const intents = new WeakMap<object, { intent: HostAuxIntent; options: unknown }>();

export function hostAuxIntentFrom(options: unknown): { intent: HostAuxIntent; options: unknown } | undefined {
  return options !== null && typeof options === "object" ? intents.get(options) : undefined;
}

/** Route-only Symbol hook. It neither selects a model nor fabricates a parent STEP. */
export function wrapHostAuxExecutor(input: {
  executor: HostPromptExecutor;
  purpose: unknown;
  turnId: unknown;
  ctx: unknown;
}): HostPromptExecutor | undefined {
  if (input.purpose !== "memory-extraction" && input.purpose !== "episode") return undefined;
  if (typeof input.turnId !== "string" || !input.turnId || input.turnId.length > 128 || /[\x00-\x1f]/.test(input.turnId)) return undefined;
  const executor = input.executor;
  const intent: HostAuxIntent = Object.freeze({
    purpose: input.purpose, auxRequestId: randomUUID(), turnId: input.turnId, ctx: input.ctx,
  });
  const wrapped: HostPromptExecutor = {
    appendMessages(messages) { executor.appendMessages(messages); return wrapped; },
    getMessages: () => executor.getMessages(),
    getState: () => executor.getState(),
    clearMessages: () => executor.clearMessages(),
    stream(ctx, invocationId, tools, options) {
      // The capsule is out-of-band. Restore even malformed options at the leaf;
      // tagging must not normalize away an otherwise-invalid request.
      const taggedOptions = options !== null && typeof options === "object" ? { ...options } : {};
      intents.set(taggedOptions, { intent, options });
      const result = executor.stream(ctx, invocationId, tools, taggedOptions);
      // The native memory consumer only collects fullStream text. A fulfilled
      // abort must not turn a partial extraction into a successful Memory write.
      const response = result.response.then((value) => {
        if (value.finishReason === "abort" || (ctx as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
          throw hostVisibleStreamError({ userVisible: true, code: "model_error", message: "Auxiliary inference was canceled." });
        }
        return value;
      });
      void response.catch(() => undefined);
      return {
        ...result,
        response,
        fullStream: { async *[Symbol.asyncIterator]() {
          for await (const part of result.fullStream) yield part;
          await response;
          if ((ctx as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
            throw hostVisibleStreamError({ userVisible: true, code: "model_error", message: "Auxiliary inference was canceled." });
          }
        } },
      };
    },
  };
  return wrapped;
}

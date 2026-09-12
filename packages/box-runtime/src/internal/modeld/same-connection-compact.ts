import { Effect, Layer } from "effect";
import { HostCompact } from "@grokbox/runtime-kernel/ports";
import type { HostCompactRequest, HostCompactResult } from "@grokbox/runtime-kernel/contract";
import { parseV4ControlFrame } from "../wire/modeld-wire.ts";
import { readOneFrame, writeFrame, type Incoming } from "./server.node.ts";

/** Same-connection resume wait. Host handleSummarization is unbounded; this is the modeld fail-closed bound. */
export const COMPACT_WAIT_MS = 5_000;

function sameTuple(request: HostCompactRequest, resume: {
  agentId: string;
  turnId: string;
  stepId: string;
  bindingId: string;
  selectionRevision: string;
  recoveryNonce: string;
}): boolean {
  const tuple = request.tuple;
  return resume.agentId === tuple.agentId
    && resume.turnId === tuple.turnId
    && resume.stepId === tuple.stepId
    && resume.bindingId === tuple.bindingId
    && resume.selectionRevision === tuple.selectionRevision
    && resume.recoveryNonce === request.recoveryNonce;
}

/** Same-connection v4 HostCompact: emit compact-request, wait for one matching resume-step. */
export function sameConnectionHostCompactLayer(incoming: Incoming): Layer.Layer<HostCompact> {
  let consumed = false;
  return Layer.succeed(HostCompact, {
    request: (input: HostCompactRequest) => Effect.gen(function* () {
      if (consumed) return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      const frame = {
        version: 4,
        method: "compact-request",
        agentId: input.tuple.agentId,
        turnId: input.tuple.turnId,
        stepId: input.tuple.stepId,
        bindingId: input.tuple.bindingId,
        selectionRevision: input.tuple.selectionRevision,
        recoveryNonce: input.recoveryNonce,
        deadlineMs: COMPACT_WAIT_MS,
      };
      incoming.awaitingResume = true;
      const written = yield* Effect.result(writeFrame(incoming.socket, frame));
      if (written._tag === "Failure") {
        incoming.awaitingResume = false;
        return { kind: "unavailable", reason: "unknown" };
      }
      const read = yield* Effect.result(readOneFrame(incoming, COMPACT_WAIT_MS));
      incoming.awaitingResume = false;
      incoming.consumed = true;
      if (read._tag === "Failure") {
        return { kind: "unavailable", reason: read.failure.message === "aborted" ? "cancelled" : "unknown" };
      }
      if (read.success.rest.length > 0) {
        incoming.extra = true;
        incoming.onLate?.();
        return { kind: "unavailable", reason: "unknown" };
      }
      let parsed;
      try {
        parsed = parseV4ControlFrame(read.success.value);
      } catch {
        return { kind: "unavailable", reason: "unknown" };
      }
      if (parsed.method !== "resume-step" || !sameTuple(input, parsed)) {
        return { kind: "unavailable", reason: "unknown" };
      }
      consumed = true;
      return { kind: "snapshot", snapshot: parsed.snapshot };
    }),
  });
}

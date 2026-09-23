import { Effect, Layer } from "effect";
import { HostCompact } from "@grokbox/runtime-kernel/ports";
import { WIRE_VERSION, REQUEST_WALL_DEADLINE_MS, type HostCompactRequest, type HostCompactResult } from "@grokbox/runtime-kernel/contract";
import { parseV4ControlFrame } from "../wire/modeld-wire.ts";
import { readOneFrame, writeFrame, type Incoming } from "./server.node.ts";

/** Reserve within the existing parent wall budget for snapshot admission, attempt1 and settlement. */
export const COMPACT_RESUME_RESERVE_MS = 5_000;

export function compactWaitBudget(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return 0;
  return Math.max(0, Math.floor(Math.min(remainingMs, REQUEST_WALL_DEADLINE_MS) - COMPACT_RESUME_RESERVE_MS));
}

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
export function sameConnectionHostCompactLayer(incoming: Incoming, options: {
  remainingMs: () => number;
}): Layer.Layer<HostCompact> {
  // Supplied by the original STEP owner, including time spent in admission.
  const { remainingMs } = options;
  let consumed = false;
  return Layer.succeed(HostCompact, {
    request: (input: HostCompactRequest) => Effect.gen(function* () {
      if (consumed) return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      const budgetMs = compactWaitBudget(remainingMs());
      if (budgetMs <= 0) return { kind: "unavailable", reason: "cancelled" } satisfies HostCompactResult;
      consumed = true;
      const resumeDeadline = performance.now() + budgetMs;
      const frame = {
        version: WIRE_VERSION,
        method: "compact-request",
        agentId: input.tuple.agentId,
        turnId: input.tuple.turnId,
        stepId: input.tuple.stepId,
        bindingId: input.tuple.bindingId,
        selectionRevision: input.tuple.selectionRevision,
        recoveryNonce: input.recoveryNonce,
        deadlineMs: budgetMs,
      };
      incoming.awaitingResume = true;
      const written = yield* Effect.result(writeFrame(incoming.socket, frame));
      if (written._tag === "Failure") {
        incoming.awaitingResume = false;
        return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      }
      const waitMs = Math.floor(Math.min(resumeDeadline - performance.now(), compactWaitBudget(remainingMs())));
      if (waitMs <= 0) {
        incoming.awaitingResume = false;
        return { kind: "unavailable", reason: "cancelled" } satisfies HostCompactResult;
      }
      const read = yield* Effect.result(readOneFrame(incoming, waitMs));
      incoming.awaitingResume = false;
      incoming.consumed = true;
      if (read._tag === "Failure") {
        return { kind: "unavailable", reason: ["aborted", "disconnected"].includes(read.failure.message) ? "cancelled" : "unknown" } satisfies HostCompactResult;
      }
      if (read.success.rest.length > 0) {
        incoming.extra = true;
        incoming.onLate?.();
        return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      }
      let parsed;
      try {
        parsed = parseV4ControlFrame(read.success.value);
      } catch {
        return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      }
      if (performance.now() >= resumeDeadline || compactWaitBudget(remainingMs()) <= 0
        || parsed.method !== "resume-step" || !sameTuple(input, parsed)) {
        return { kind: "unavailable", reason: "unknown" } satisfies HostCompactResult;
      }
      return { kind: "snapshot", snapshot: parsed.snapshot } satisfies HostCompactResult;
    }).pipe(Effect.ensuring(Effect.sync(() => {
      incoming.awaitingResume = false;
      incoming.consumed = true;
    }))),
  });
}

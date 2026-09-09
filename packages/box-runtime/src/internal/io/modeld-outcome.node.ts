import { Effect } from "effect";
import type { RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { BACKEND_PHASES, FAILURE_REASONS, PROVIDER_CODES, PROVIDER_PARAMS } from "../backends/failure-observation.ts";
import { STEP_FAILURE_CODES, STEP_OUTCOMES, STEP_PHASES, type ModeldStepOutcome } from "../modeld/step-outcome.ts";
import { appendNdjsonLine } from "../host/terminal-journal.node.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function member(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export type ModeldStepOutcomeEvent = { name: "model_step_terminal"; schemaVersion: 3; at: string; [key: string]: unknown };

/** modeld observation only: never claims Host delivery; no free-form error/body/Cause fields. */
export function projectModeldStepOutcome(value: unknown): ModeldStepOutcomeEvent | null {
  const v = record(value);
  if (!v || v.name !== "model_step_terminal" || v.schemaVersion !== 3 || typeof v.at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at) || !Number.isFinite(Date.parse(v.at)) ||
      ![v.hostGenerationId, v.agentId, v.turnId, v.stepId, v.serviceEpoch].every(id) ||
      !member(v.outcome, STEP_OUTCOMES) || !member(v.phase, STEP_PHASES) ||
      typeof v.eventCount !== "number" || !Number.isSafeInteger(v.eventCount) || v.eventCount < 0 || v.eventCount > 65_536) return null;
  const out: ModeldStepOutcomeEvent = {
    name: "model_step_terminal", schemaVersion: 3, at: v.at,
    hostGenerationId: v.hostGenerationId, agentId: v.agentId, turnId: v.turnId, stepId: v.stepId,
    serviceEpoch: v.serviceEpoch, outcome: v.outcome, phase: v.phase, eventCount: v.eventCount,
  };
  if (id(v.bindingId)) out.bindingId = v.bindingId;
  if (member(v.failureCode, STEP_FAILURE_CODES)) out.failureCode = v.failureCode;
  const d = record(v.diagnostic);
  if (d && member(d.phase, BACKEND_PHASES) && member(d.reason, FAILURE_REASONS)) {
    const safe: Record<string, unknown> = { phase: d.phase, reason: d.reason };
    if (typeof d.httpStatus === "number" && Number.isInteger(d.httpStatus) && d.httpStatus >= 400 && d.httpStatus <= 599) safe.httpStatus = d.httpStatus;
    if (member(d.providerCode, PROVIDER_CODES)) safe.providerCode = d.providerCode;
    if (member(d.providerParam, PROVIDER_PARAMS)) safe.providerParam = d.providerParam;
    out.diagnostic = safe;
  }
  return out;
}

export function writeModeldStepOutcome(root: string, request: RunStepRequest, outcome: ModeldStepOutcome) {
  return Effect.tryPromise(async () => {
    const projected = projectModeldStepOutcome({
      ...outcome, name: "model_step_terminal", schemaVersion: 3, at: new Date().toISOString(),
      hostGenerationId: request.hostEpoch.compile, agentId: request.agentId,
      turnId: request.turnId, stepId: request.stepId, serviceEpoch: request.serviceEpoch.incarnationId,
    });
    if (projected) await appendNdjsonLine(root, JSON.stringify(projected));
  }).pipe(Effect.asVoid);
}

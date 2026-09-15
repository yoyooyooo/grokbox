import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import {
  ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
  ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
} from "@grokbox/runtime-kernel/selection";

/** Values that the Host journal projector refuses. agentMessage is never written. */
export const HOST_JOURNAL_FORBIDDEN = /env|token|prompt|authorization|secret|apiKey/i;

export const ROUTE_MODEL_NOT_ADMITTED_AGENT_MESSAGE = ROUTE_MODEL_NOT_ADMITTED_MESSAGE;
export const INVALID_STREAM_AGENT_MESSAGE =
  "The model returned an invalid stream. The request was stopped without retry.";

export type HostFailureMapsFrom =
  | "BoxRuntimeError.failureCode"
  | "BoxRuntimeError"
  | "HostSelectionUnavailableError"
  | "unknown-throw"
  | "hook-reason";

export type HostFailureCatalogRow = {
  reason: string;
  errorCode: string;
  stage: "stream-id" | "admit" | "normalize" | "connect" | "provider";
  agentMessage: string;
  mapsFrom: HostFailureMapsFrom;
  failureCode?: string;
};

/**
 * Single Host-stream failure catalog. Host preload and CLI share this table.
 * New admit/stream classes add a writer, a row, the allowlist reason, and
 * written/observe proof in the same change. Do not park reasons without writers.
 */
export const HOST_FAILURE_CATALOG = [
  {
    reason: "route-model-not-admitted",
    errorCode: "runtime_config_invalid",
    stage: "admit",
    agentMessage: ROUTE_MODEL_NOT_ADMITTED_AGENT_MESSAGE,
    mapsFrom: "BoxRuntimeError.failureCode",
    failureCode: ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
  },
  {
    reason: "selection-unavailable",
    errorCode: "runtime_config_invalid",
    stage: "admit",
    agentMessage: "Model selection is unavailable; no model was selected.",
    mapsFrom: "HostSelectionUnavailableError",
  },
  {
    reason: "admit-refused",
    errorCode: "runtime_config_invalid",
    stage: "admit",
    agentMessage: "Managed route refused this model assignment.",
    mapsFrom: "BoxRuntimeError",
  },
  {
    reason: "admit-threw",
    errorCode: "invalid_envelope",
    stage: "admit",
    agentMessage: "Host admit failed before a model stream started.",
    mapsFrom: "unknown-throw",
  },
  {
    reason: "missing-turn",
    errorCode: "invalid_envelope",
    stage: "admit",
    agentMessage: "Managed session is missing a TURN id.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "missing-binding",
    errorCode: "invalid_envelope",
    stage: "admit",
    agentMessage: "Managed session is missing a Host binding.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "missing-bridge",
    errorCode: "invalid_envelope",
    stage: "admit",
    agentMessage: "Managed session is missing a bridge digest.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "invalid-state",
    errorCode: "invalid_envelope",
    stage: "admit",
    agentMessage: "Managed session state is not a valid Host executor window.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "missing-step-id",
    errorCode: "invalid_envelope",
    stage: "stream-id",
    agentMessage: "Managed stream is missing a STEP id.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "invalid-step-id",
    errorCode: "invalid_envelope",
    stage: "stream-id",
    agentMessage: "Managed stream received an invalid STEP id.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "terminal-rejected",
    errorCode: "invalid_envelope",
    stage: "provider",
    agentMessage: "Managed stream ended in a Host rejection.",
    mapsFrom: "hook-reason",
  },
  {
    reason: "invalid-stream",
    errorCode: "invalid_stream",
    stage: "normalize",
    agentMessage: INVALID_STREAM_AGENT_MESSAGE,
    mapsFrom: "hook-reason",
  },
] as const satisfies readonly HostFailureCatalogRow[];

export type HostStreamRejectReason = (typeof HOST_FAILURE_CATALOG)[number]["reason"];
export type HostFailureCatalogEntry = (typeof HOST_FAILURE_CATALOG)[number];

const byReason = new Map<string, HostFailureCatalogEntry>(HOST_FAILURE_CATALOG.map((row) => [row.reason, row]));
const byFailureCode = new Map<string, HostFailureCatalogEntry>();
for (const row of HOST_FAILURE_CATALOG) {
  if ("failureCode" in row) byFailureCode.set(row.failureCode, row);
}

export function catalogByReason(reason: string): HostFailureCatalogEntry | undefined {
  return byReason.get(reason);
}

export function catalogByFailureCode(failureCode: string): HostFailureCatalogEntry | undefined {
  return byFailureCode.get(failureCode);
}

export function catalogAgentMessage(reason: string): string | undefined {
  return byReason.get(reason)?.agentMessage;
}

export type TerminalRejectMapping = {
  reason: HostStreamRejectReason;
  errorCode: string;
  stage: "admit" | "normalize" | "provider";
};

/** Host-visible mapping for a rejected stream terminal. Backend stream_invalid
 * is the same class as Host invalid_stream; do not collapse it to model_error. */
export function mapTerminalReject(errorCode: string, stage?: string): TerminalRejectMapping {
  if (errorCode === "invalid_stream" || errorCode === "stream_invalid") {
    return { reason: "invalid-stream", errorCode: "invalid_stream", stage: "normalize" };
  }
  return {
    reason: "terminal-rejected",
    errorCode,
    stage: stage === "admit" ? "admit" : stage === "normalize" ? "normalize" : "provider",
  };
}

/** UUIDv4-shaped send nonce. Additive; invalid values are dropped, not a reject. */
export function boundedClientNonce(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 36) return undefined;
  if (/[\n\r]/.test(value)) return undefined;
  if (HOST_JOURNAL_FORBIDDEN.test(value)) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return undefined;
  return value;
}

export type AdmitCatchMapping = {
  reason: HostStreamRejectReason;
  errorCode: string;
  stage: "admit";
};

/**
 * Map a capture-phase throw onto the catalog. Known BoxRuntimeError codes never
 * become admit-threw. Unmapped BoxRuntimeError is the refuse safety net, not an
 * extension slot for new classes.
 */
export function mapAdmitCatch(error: unknown): AdmitCatchMapping {
  if (error instanceof BoxRuntimeError) {
    const coded = error.failureCode ? byFailureCode.get(error.failureCode) : undefined;
    if (coded && coded.mapsFrom === "BoxRuntimeError.failureCode") {
      return { reason: coded.reason, errorCode: coded.errorCode, stage: "admit" };
    }
    return { reason: "admit-refused", errorCode: "runtime_config_invalid", stage: "admit" };
  }
  if (error instanceof Error && error.name === "HostSelectionUnavailableError") {
    return { reason: "selection-unavailable", errorCode: "runtime_config_invalid", stage: "admit" };
  }
  return { reason: "admit-threw", errorCode: "invalid_envelope", stage: "admit" };
}

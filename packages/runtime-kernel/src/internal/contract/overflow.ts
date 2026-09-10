import type { ContextSnapshot } from "./snapshot.ts";

export type RecoveryTuple = {
  agentId: string;
  turnId: string;
  stepId: string;
  bindingId: string;
  selectionRevision: string;
};

export type HostCompactRequest = {
  tuple: RecoveryTuple;
  recoveryNonce: string;
};

export type HostCompactUnavailableReason = "capability_not_ready" | "blocked" | "cancelled" | "unknown";

export type HostCompactResult =
  | { kind: "snapshot"; snapshot: ContextSnapshot }
  | { kind: "unavailable"; reason: HostCompactUnavailableReason }
  | { kind: "no_improvement" };

export type OverflowEvidence = {
  providerCode?: string;
  httpStatus?: number;
  auth?: boolean;
  rateLimited?: boolean;
  payloadTooLarge?: boolean;
  timeout?: boolean;
  disconnected?: boolean;
  unknown?: boolean;
  releasedText?: number;
  releasedReasoning?: number;
  releasedTools?: number;
};

export type RecoveryLedger = {
  tuple: RecoveryTuple;
  recoveryNonce: string;
  compactInvocations: number;
  managedAttempts: number;
  nonceConsumed: boolean;
};

export type CompactFailureCode =
  | "unconfirmed"
  | "released"
  | "capability_not_ready"
  | "blocked"
  | "exhausted"
  | "nonce"
  | "identity"
  | "cancelled"
  | "unknown"
  | "no_improvement";

export class CompactFailure extends Error {
  readonly code: CompactFailureCode;
  constructor(code: CompactFailureCode) {
    super(code);
    this.name = "CompactFailure";
    this.code = code;
  }
}

const CONFIRMED_CODES = new Set(["context_length_exceeded", "context_too_large"]);

/** Structured overflow only. Auth/429/413/5xx/timeout/unknown/message-only stay unconfirmed. */
export function isConfirmedOverflow(evidence: OverflowEvidence): boolean {
  if (evidence.auth || evidence.rateLimited || evidence.payloadTooLarge || evidence.timeout || evidence.disconnected || evidence.unknown) {
    return false;
  }
  const status = evidence.httpStatus;
  if (status === 401 || status === 403 || status === 429 || status === 413 || status === 500 || status === 502 || status === 503) {
    return false;
  }
  if (status !== undefined && status !== 200 && status !== 400) return false;
  return typeof evidence.providerCode === "string" && CONFIRMED_CODES.has(evidence.providerCode);
}

export function emptyRecoveryLedger(tuple: RecoveryTuple, recoveryNonce: string): RecoveryLedger {
  return { tuple, recoveryNonce, compactInvocations: 0, managedAttempts: 1, nonceConsumed: false };
}

export function isKnownZeroRelease(value: unknown): boolean {
  return value === 0 && Number.isInteger(value);
}

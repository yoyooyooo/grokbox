export type BoxRuntimeErrorCode =
  | "runtime_local_only"
  | "invalid_usage"
  | "credential_invalid"
  | "runtime_not_ready"
  | "runtime_ownership_unavailable";

export class BoxRuntimeError extends Error {
  readonly code: BoxRuntimeErrorCode;
  readonly userVisible: boolean;

  constructor(code: BoxRuntimeErrorCode, message: string, extras: { userVisible?: boolean } = {}) {
    super(message);
    this.name = "BoxRuntimeError";
    this.code = code;
    this.userVisible = extras.userVisible === true;
  }
}

export function runtimeNotReady(capability: string, untilTicket: "T26" | "T28"): never {
  throw new BoxRuntimeError(
    "runtime_not_ready",
    `${capability} is not ready; ${untilTicket} must replace this placeholder. No credential, network, or signal side effects ran.`,
    { userVisible: true },
  );
}

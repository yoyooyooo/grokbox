export type BoxRuntimeErrorCode =
  | "runtime_local_only"
  | "invalid_usage"
  | "credential_invalid";

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

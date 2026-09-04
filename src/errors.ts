export const EXIT_CODES = {
  ok: 0,
  invalid_usage: 2,
  discovery_unavailable: 3,
  gateway_unreachable: 4,
  gateway_bad_request: 10,
  gateway_unauthorized: 11,
  gateway_forbidden: 12,
  gateway_not_found: 13,
  gateway_conflict: 14,
  gateway_internal: 15,
  send_delivery_unknown: 16,
  target_not_found: 17,
  target_kind_mismatch: 18,
  target_ambiguous: 19,
  profile_not_found: 20,
  profile_invalid: 21,
  capability_unavailable: 22,
  tailscale_not_ready: 23,
  daemon_endpoint_unavailable: 24,
  bootstrap_unavailable: 25,
  daemon_unreachable: 26,
  daemon_protocol_mismatch: 27,
  operation_outcome_unknown: 28,
  credential_unavailable: 29,
  credential_locked: 30,
  credential_invalid: 31,
  daemon_credential_required: 32,
  daemon_credential_failed: 33,
  daemon_unauthorized: 34,
  fs_path_invalid: 35,
  fs_forbidden: 36,
  fs_not_found: 37,
  fs_not_file: 38,
  fs_not_directory: 39,
  fs_too_large: 40,
  fs_transfer_invalid: 41,
  fs_hash_mismatch: 42,
  fs_destination_exists: 43,
  fs_conflict: 44,
  fs_not_empty: 45,
  fs_upload_invalid: 46,
  process_forbidden: 47,
  process_invalid: 48,
  job_not_found: 49,
  job_conflict: 50,
  job_interrupted: 51,
  event_cursor_invalid: 52,
  event_subscriber_limit: 53,
  sandbox_unavailable: 54,
  sandbox_wake_failed: 55,
  sandbox_keepalive_degraded: 56,
  recover_unavailable: 57,
  recover_failed: 58,
  runtime_unsupported: 59,
  quota_unavailable: 60,
  quota_authorization_failed: 61,
  quota_protocol_unsupported: 62,
  quota_provider_unavailable: 63,
  desktop_unavailable: 64,
} as const;

export type ErrorCode = Exclude<keyof typeof EXIT_CODES, "ok">;

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  failureCode?: string;
  retryable: boolean;
  context?:
    | { clientNonce: string; target: { id: string; kind: "agent" | "group" } }
    | { operationId: string; object?: { id: string; kind: "agent" | "group" }; phase?: string };
};

const RETRYABLE: Record<ErrorCode, boolean> = {
  invalid_usage: false,
  discovery_unavailable: false,
  gateway_unreachable: true,
  gateway_bad_request: false,
  gateway_unauthorized: false,
  gateway_forbidden: false,
  gateway_not_found: false,
  gateway_conflict: false,
  gateway_internal: true,
  send_delivery_unknown: false,
  target_not_found: false,
  target_kind_mismatch: false,
  target_ambiguous: false,
  profile_not_found: false,
  profile_invalid: false,
  capability_unavailable: false,
  tailscale_not_ready: false,
  daemon_endpoint_unavailable: false,
  bootstrap_unavailable: false,
  daemon_unreachable: true,
  daemon_protocol_mismatch: false,
  operation_outcome_unknown: false,
  credential_unavailable: false,
  credential_locked: false,
  credential_invalid: false,
  daemon_credential_required: false,
  daemon_credential_failed: false,
  daemon_unauthorized: false,
  fs_path_invalid: false,
  fs_forbidden: false,
  fs_not_found: false,
  fs_not_file: false,
  fs_not_directory: false,
  fs_too_large: false,
  fs_transfer_invalid: false,
  fs_hash_mismatch: false,
  fs_destination_exists: false,
  fs_conflict: false,
  fs_not_empty: false,
  fs_upload_invalid: false,
  process_forbidden: false,
  process_invalid: false,
  job_not_found: false,
  job_conflict: false,
  job_interrupted: false,
  event_cursor_invalid: false,
  event_subscriber_limit: true,
  sandbox_unavailable: true,
  sandbox_wake_failed: true,
  sandbox_keepalive_degraded: true,
  recover_unavailable: false,
  recover_failed: true,
  runtime_unsupported: false,
  quota_unavailable: false,
  quota_authorization_failed: false,
  quota_protocol_unsupported: false,
  quota_provider_unavailable: true,
  desktop_unavailable: false,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus?: number;
  readonly failureCode?: string;
  readonly retryable: boolean;
  readonly context?: ErrorBody["context"];

  constructor(
    code: ErrorCode,
    message: string,
    extras: {
      httpStatus?: number;
      failureCode?: string;
      retryable?: boolean;
      context?: ErrorBody["context"];
    } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.httpStatus = extras.httpStatus;
    this.failureCode = extras.failureCode;
    this.retryable = extras.retryable ?? RETRYABLE[code];
    this.context = extras.context;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toErrorBody(): ErrorBody {
    const body: ErrorBody = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.httpStatus !== undefined) body.httpStatus = this.httpStatus;
    if (this.failureCode !== undefined) body.failureCode = this.failureCode;
    if (this.context !== undefined) body.context = this.context;
    return body;
  }
}

export function usage(message: string): CliError {
  return new CliError("invalid_usage", message);
}

export function httpStatusToError(
  status: number,
  failureCode: string | undefined,
  fallbackMessage: string,
): CliError {
  if (status === 400) {
    return new CliError("gateway_bad_request", "Gateway rejected the request body.", {
      httpStatus: 400,
      failureCode,
    });
  }
  if (status === 401) {
    return new CliError("gateway_unauthorized", "Gateway rejected the credentials.", {
      httpStatus: 401,
      failureCode,
    });
  }
  if (status === 403) {
    return new CliError("gateway_forbidden", "Gateway forbade the request.", {
      httpStatus: 403,
      failureCode,
    });
  }
  if (status === 404) {
    return new CliError("gateway_not_found", "Gateway method or path was not found.", {
      httpStatus: 404,
      failureCode,
    });
  }
  if (status === 409) {
    return new CliError("gateway_conflict", "Gateway rejected the request.", {
      httpStatus: 409,
      failureCode,
    });
  }
  return new CliError("gateway_internal", fallbackMessage, {
    httpStatus: status,
    failureCode,
  });
}

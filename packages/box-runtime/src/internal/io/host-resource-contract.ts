/** Box OS adapter policy. Configuration parsing remains with the canonical config owner. */
export type HostFilesystemRoot = { name: string; path: string; operations: Array<"stat" | "list" | "read" | "download" | "write" | "mkdir" | "upload" | "remove" | "remove-recursive" | "restore" | "exec"> };
export type HostProcessPolicy = { cwdRoots: string[]; defaultCwdRoot: string; executables: Array<{ name: string; path: string }>;
  environment: string[]; maxConcurrent: number; maxQueued: number; maxRuntimeMs: number; maxOutputBytes: number; shell?: { executable: string } };
export type HostResourceCode = "desktop_unavailable" | "target_not_found" | "invalid_usage" | "config_layout_conflict" | "fs_destination_exists" | "fs_path_invalid" | "fs_not_found" | "fs_forbidden" | "fs_too_large" | "fs_not_empty" | "fs_conflict" | "fs_not_directory" | "fs_not_file" | "fs_transfer_invalid" | "fs_hash_mismatch" | "fs_upload_invalid"
  | "capability_unavailable" | "gateway_internal" | "daemon_unreachable" | "operation_outcome_unknown" | "process_forbidden" | "process_invalid" | "job_interrupted" | "job_conflict" | "job_not_found";
/** Finite adapter errors; transports project these rather than exposing OS errors. */
export class HostResourceError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: HostResourceCode, message: string, options: { retryable?: boolean } = {}) {
    super(message); this.name = "HostResourceError"; this.retryable = options.retryable === true;
  }
}

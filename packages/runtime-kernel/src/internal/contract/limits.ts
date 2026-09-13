/** Safety resource budgets. Not model context windows, token meters, or SLAs. */
export const CONFIG_READ_MAX_BYTES = 128 * 1024;
export const SNAPSHOT_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const ENCODED_PROVIDER_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
export const WIRE_FRAME_MAX_BYTES = 8 * 1024 * 1024;
export const CANONICAL_OUTPUT_MAX_BYTES = 1 * 1024 * 1024;
export const HOST_REPLAY_MAX_EVENTS = 4096;
export const SERVER_ACTIVE_CLIENTS_MAX = 64;
export const SERVER_ACTIVE_STEPS_MAX = 64;
export const PROCESS_RETAINED_PAYLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const ADMISSION_WAIT_MS = 500;
export const PARTIAL_SOCKET_MS = 1_000;
/** Non-renewable STEP wall budget; shared by Host/client/modeld and recovery. */
export const REQUEST_WALL_DEADLINE_MS = 180_000;
export const TURN_IDLE_MS = 5 * 60_000;
export const LEDGER_ENTRIES_MAX = 1024;
export const OWNED_SHUTDOWN_MS = 2_000;

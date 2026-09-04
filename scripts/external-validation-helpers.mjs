const JOB_CLEANUP_TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export function productErrorCodeFromText(stderr) {
  try {
    const body = JSON.parse(String(stderr).trim());
    return typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

export function jobStateProvesCleanup(state) {
  return JOB_CLEANUP_TERMINAL_STATES.has(state);
}

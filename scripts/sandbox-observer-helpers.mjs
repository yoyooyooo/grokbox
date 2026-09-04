const SANDBOX_FAILURES = new Set([
  "unauthorized",
  "rate_limited",
  "provider_refused",
  "provider_unavailable",
  "request_timeout",
  "protocol_invalid",
  "exec_failed",
  "exec_outcome_unknown",
]);

export function projectSandboxFailure(value) {
  if (value === null) return null;
  return typeof value === "string" && SANDBOX_FAILURES.has(value) ? value : "unknown";
}

export function classifySshProbe(result) {
  if (result.ok === true) return "reachable";
  if (result.unavailable === true) return "inconclusive";
  if (result.timedOut === true || /(?:operation|connection) timed out/i.test(String(result.stderr ?? ""))) {
    return "network-nonresponse";
  }
  return "inconclusive";
}

export function analyzeLeaseCoverage(records, startedAtMs, completedAtMs, maximumTickGapMs) {
  let lastTick = 0;
  let lastObservedAtMs = startedAtMs;
  let sequenceValid = true;
  const accepted = [];
  for (const row of records) {
    const valid = (row.status === "healthy" || row.status === "degraded") &&
      Number.isSafeInteger(row.tickCount) && row.tickCount > lastTick &&
      Number.isFinite(row.observedAtMs) && row.observedAtMs > lastObservedAtMs;
    if (!valid) {
      sequenceValid = false;
      continue;
    }
    accepted.push(row);
    lastTick = row.tickCount;
    lastObservedAtMs = row.observedAtMs;
  }
  const tickTimes = accepted.map((row) => row.observedAtMs);
  const continuousCoverage = sequenceValid && tickTimes.length > 0 &&
    tickTimes[0] - startedAtMs <= maximumTickGapMs &&
    tickTimes.every((time, index) => index === 0 || time - tickTimes[index - 1] <= maximumTickGapMs) &&
    completedAtMs - tickTimes[tickTimes.length - 1] <= maximumTickGapMs;
  return {
    observedTicks: accepted.length,
    healthyTicks: accepted.filter((row) => row.status === "healthy").length,
    continuousCoverage,
    sequenceValid,
  };
}

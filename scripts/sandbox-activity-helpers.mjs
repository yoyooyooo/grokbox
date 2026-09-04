export function analyzePeriodicSshCoverage(
  records,
  effectiveStartAtMs,
  stimulusStoppedAtMs,
  intervalMs,
  maximumLatenessMs,
) {
  const expectedTicks = Math.max(1, Math.floor((stimulusStoppedAtMs - effectiveStartAtMs) / intervalMs) + 1);
  let scheduleValid = records.length === expectedTicks;
  let successfulTicks = 0;

  for (let index = 0; index < records.length; index += 1) {
    const row = records[index];
    const expectedAtMs = effectiveStartAtMs + index * intervalMs;
    const valid = row?.stimulusSequence === index &&
      row?.scheduledAtMs === expectedAtMs &&
      Number.isSafeInteger(row?.observedAtMs) &&
      row.observedAtMs >= expectedAtMs &&
      row.observedAtMs - expectedAtMs <= maximumLatenessMs &&
      row?.sshStatus === "reachable" && row?.state === "running";
    if (!valid) scheduleValid = false;
    else successfulTicks += 1;
  }

  return {
    expectedTicks,
    observedTicks: records.length,
    successfulTicks,
    continuousCoverage: scheduleValid && successfulTicks === expectedTicks,
  };
}

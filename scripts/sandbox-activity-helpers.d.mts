export function analyzePeriodicSshCoverage(
  records: Array<{
    stimulusSequence?: unknown;
    scheduledAtMs?: unknown;
    observedAtMs?: unknown;
    sshStatus?: unknown;
    state?: unknown;
  }>,
  effectiveStartAtMs: number,
  stimulusStoppedAtMs: number,
  intervalMs: number,
  maximumLatenessMs: number,
): {
  expectedTicks: number;
  observedTicks: number;
  successfulTicks: number;
  continuousCoverage: boolean;
};

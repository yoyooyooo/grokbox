export function projectSandboxFailure(value: unknown): string | null;
export function classifySshProbe(result: {
  ok?: boolean;
  unavailable?: boolean;
  timedOut?: boolean;
  stderr?: string;
}): "reachable" | "network-nonresponse" | "inconclusive";
export function analyzeLeaseCoverage(
  records: Array<{ status?: unknown; tickCount?: unknown; observedAtMs?: unknown }>,
  startedAtMs: number,
  completedAtMs: number,
  maximumTickGapMs: number,
): {
  observedTicks: number;
  healthyTicks: number;
  continuousCoverage: boolean;
  sequenceValid: boolean;
};

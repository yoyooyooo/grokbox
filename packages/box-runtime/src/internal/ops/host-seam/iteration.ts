import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { structuralShapeSync, type ShapeCandidate, type ShapeReport } from "./shape.ts";

export const ITERATION_BUDGET = 2;
export const ITERATION_TOOL_REVISION = "hso-4.iteration.v1";

export type IterationStatus = "verified_offline" | "failed" | "superseded" | "budget";

export type IterationEvidence = {
  excludeWindows?: Array<{ startByte: number; endByte: number }>;
};

export type IterationResult = {
  process: "host-seam-iteration";
  status: IterationStatus;
  round: number;
  sourceSha256: string;
  writes: 0;
  hostSignals: 0;
  unauthorizedCodeWrite: false;
  candidates: ShapeCandidate[];
  limitations: string[];
  report: ShapeReport;
};

function uniqueRole(candidates: ShapeCandidate[], sliceId: ShapeCandidate["sliceId"]): ShapeCandidate | undefined {
  const rows = candidates.filter((row) => row.sliceId === sliceId);
  return rows.length === 1 ? rows[0] : undefined;
}

function excluded(row: ShapeCandidate, evidence?: IterationEvidence): boolean {
  return (evidence?.excludeWindows ?? []).some((win) => win.startByte === row.startByte && win.endByte === row.endByte);
}

/** Two-round offline shape iteration. Never writes Host/business source. */
export function iterateHostSeamShape(input: {
  source: string;
  sourceSha256?: string;
  evidence?: IterationEvidence;
  prior?: { sourceSha256: string; rounds: number };
}): IterationResult {
  const sourceSha256 = input.sourceSha256 ?? sha256Text(input.source);
  const writes = 0 as const;
  if (input.prior && input.prior.sourceSha256 !== sourceSha256) {
    return {
      process: "host-seam-iteration",
      status: "superseded",
      round: input.prior.rounds,
      sourceSha256,
      writes,
      hostSignals: 0,
      unauthorizedCodeWrite: false,
      candidates: [],
      limitations: ["source_changed"],
      report: structuralShapeSync(input.source),
    };
  }
  const nextRound = (input.prior?.rounds ?? 0) + 1;
  if (nextRound > ITERATION_BUDGET) {
    return {
      process: "host-seam-iteration",
      status: "budget",
      round: input.prior?.rounds ?? ITERATION_BUDGET,
      sourceSha256,
      writes,
      hostSignals: 0,
      unauthorizedCodeWrite: false,
      candidates: [],
      limitations: ["budget"],
      report: structuralShapeSync(input.source),
    };
  }
  const report = structuralShapeSync(input.source);
  const candidates = report.candidates.filter((row) => !excluded(row, input.evidence));
  const create = uniqueRole(candidates, "create-session");
  const agent = uniqueRole(candidates, "agent-id");
  const ok = report.status === "ok" && create !== undefined && agent !== undefined;
  return {
    process: "host-seam-iteration",
    status: ok ? "verified_offline" : "failed",
    round: nextRound,
    sourceSha256,
    writes,
    hostSignals: 0,
    unauthorizedCodeWrite: false,
    candidates,
    limitations: ok ? [] : [...report.limitations, "not_unique_pair"],
    report,
  };
}

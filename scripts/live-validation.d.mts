export type LiveScenario = {
  id: string;
  stableId: string;
  title: string;
  gate: string | null;
  implementation: string | null;
  currentResult: string | null;
  oracle: string;
  blocker: string;
  sourceLinks: string[];
};

export type ReceiptCheck = {
  ok: boolean;
  errors: string[];
  derived: {
    scenario: string | null;
    currentResult: string | null;
    allStepsPassed: boolean;
    hasFailure: boolean;
    hasUnknown: boolean;
    cleanupState: string | null;
    indexEligible: boolean;
  };
};

export function parseLiveIndex(markdown?: string): LiveScenario[];
export function validateReceipt(receipt: unknown, rows?: LiveScenario[]): ReceiptCheck;
export function sourceSnapshot(): {
  sourceCommit: string | null;
  dirty: boolean | null;
  dirtyPaths: string[];
  sourceDigest: string | null;
  sourceFiles: number | null;
  sourceCapture: string;
  package: { name: string; version: string; packageManager?: string; engines: unknown };
  runtime: { node: string; bun: string | null };
};

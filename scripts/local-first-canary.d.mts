export type CreationCanaryPlan = {
  version: 1; requestId: string; cleanupRequestId: string; installationId: string; scopeId: string;
  maxAgeMs: number; expectedNativeGeneration: string; artifactSha256: string; authorizationRef: string | null;
  profile: { name: string; description: string };
  expectedSource: { sourceSha256: string; transformedSha256: string; profileSha256: string; preloadSha256: string; generationId: string };
};
export type CreationCanaryResult = {
  version: 1; kind: "grokbox-creation-canary"; status: string; ok: boolean;
  creation: { state: "passed" | "failed" | "uncertain" | "not-run" | "stale"; stage: string; code?: string };
  cleanup: { state: "passed" | "uncertain" | "not-run"; stage: string };
  targetId: string | null; source: CreationCanaryPlan["expectedSource"] | null;
  observedAtMs: number; freshness: "current" | "stale" | "not-observed"; lastSuccess: number | null; executionQualified: false;
};
export type CanaryFiles = { read: (key: string) => Promise<any>; save: (key: string, value: unknown) => Promise<void> };
export function creationCanaryPlan(value: unknown): CreationCanaryPlan;
export function runCreationCanary(options: CanaryFiles & {
  plan: CreationCanaryPlan; confirm?: boolean; cli: (args: string[], input?: unknown) => Promise<any>; now?: () => number;
}): Promise<CreationCanaryResult>;
export function creationCanaryFiles(directory: string): Promise<CanaryFiles>;
export function creationCanaryCli(entry: string, env?: NodeJS.ProcessEnv): (args: string[], input?: unknown) => Promise<any>;
export function checkCanaryArtifact(entry: string, expected: string): Promise<void>;

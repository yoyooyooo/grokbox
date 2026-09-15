import { lstat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { EnvelopeInsertionGroup } from "./envelope-windows.ts";
import type { ReplayReport } from "./replay.ts";
import type { CandidateArtifact } from "./propose.ts";

export const ANALYZE_TOOL_REVISION = "hso-3.analyze.v2";

export type AgentVerdict =
  | "reuse"
  | "candidate_only"
  | "needs_evidence"
  | "code_change_required"
  | "unrelated_or_not_proven"
  | "blocked_or_superseded";

export type AnalysisEnvelopeEvidence = {
  evidenceKind: "envelope-windows";
  pinSha: string | null;
  candidateSha: string;
  bootstrap: boolean;
  refusal: "missing_golden" | "envelope_unmeasurable" | "envelope_drift" | null;
  requiredIds: string[];
  informationalIds: string[];
  insertionGroups: EnvelopeInsertionGroup[];
  sliceReviewRequired: boolean;
  generationPresent: boolean;
};

export type AnalysisResult = {
  process: "profile-analyze";
  workKey: string;
  episodeRevision: number;
  evidenceDigest: string;
  sourceSha: string;
  verdict: AgentVerdict | null;
  approved: false;
  adopt: false;
  published: false;
  settled: "ok" | "missing_runner" | "timeout" | "budget" | "duplicate" | "superseded";
  gates: string[];
  forbidden: string[];
  effects: { uploads: 0; executes: 0; writes: 0; publish: 0; upgradeRpc: 0 };
  limitations: string[];
  envelope?: AnalysisEnvelopeEvidence;
  next?: string;
};

export function attachWriteEnvelopeInspect(
  result: AnalysisResult,
  inspect: {
    pinSha: string | null;
    candidateSha: string;
    bootstrap: boolean;
    refusal: AnalysisEnvelopeEvidence["refusal"];
    requiredIds: readonly string[];
    informationalIds: readonly string[];
    insertionGroups: EnvelopeInsertionGroup[];
    sliceReviewRequired: boolean;
    generationPresent: boolean;
    next: string;
    limitations?: readonly string[];
  },
): AnalysisResult {
  const extra = inspect.limitations ?? [];
  return {
    ...result,
    limitations: extra.length === 0
      ? result.limitations
      : [...result.limitations, ...extra.filter((row) => !result.limitations.includes(row))],
    envelope: {
      evidenceKind: "envelope-windows",
      pinSha: inspect.pinSha,
      candidateSha: inspect.candidateSha,
      bootstrap: inspect.bootstrap,
      refusal: inspect.refusal,
      requiredIds: [...inspect.requiredIds],
      informationalIds: [...inspect.informationalIds],
      insertionGroups: inspect.insertionGroups,
      sliceReviewRequired: inspect.sliceReviewRequired,
      generationPresent: inspect.generationPresent,
    },
    next: inspect.next,
  };
}

export type AnalysisInput = {
  sourceSha: string;
  evidenceDigest: string;
  workKey: string;
  episodeRevision: number;
  mechanical: { supportGatePassed: boolean; codes: string[]; candidateCount: number };
  sourceDirectives?: string;
};

export type AgentAnalysisPort = {
  analyze(input: AnalysisInput): Promise<Pick<AnalysisResult, "verdict" | "limitations">>;
};

const FORBIDDEN = ["auto-adopt", "auto-publish", "updateHostNow", "autoUpdateBoxNow", "upload-source", "execute-source"];

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

export function createFakeAnalysisPort(table: Record<string, AgentVerdict>): AgentAnalysisPort {
  return {
    async analyze(input) {
      const text = `${input.sourceDirectives ?? ""}${JSON.stringify(input)}`;
      if (/approved\s*[:=]\s*true/i.test(text) || /auto-adopt/i.test(text)) {
        throw new Error("forged approval is not an Agent capability");
      }
      const verdict = table[input.evidenceDigest] ?? table[input.workKey];
      if (!verdict) throw new Error("unknown evidence");
      return { verdict, limitations: ["fake_port_not_llm"] };
    },
  };
}

export function createAnalysisSession() {
  const jobs = new Map<string, { revision: number; result: AnalysisResult }>();
  return {
    async run(input: {
      analysis: AnalysisInput;
      port?: AgentAnalysisPort | null;
      runner?: boolean;
      budgetMs?: number;
    }): Promise<AnalysisResult> {
      const base: AnalysisResult = {
        process: "profile-analyze",
        workKey: input.analysis.workKey,
        episodeRevision: input.analysis.episodeRevision,
        evidenceDigest: input.analysis.evidenceDigest,
        sourceSha: input.analysis.sourceSha,
        verdict: null,
        approved: false,
        adopt: false,
        published: false,
        settled: "ok",
        gates: ["human-review", "no-auto-publish", "no-adopt"],
        forbidden: FORBIDDEN,
        effects: { uploads: 0, executes: 0, writes: 0, publish: 0, upgradeRpc: 0 },
        limitations: ["source_directives_are_data"],
      };
      const prior = jobs.get(input.analysis.workKey);
      if (prior && prior.revision === input.analysis.episodeRevision) {
        return { ...prior.result, settled: "duplicate", approved: false, adopt: false, published: false, effects: base.effects };
      }
      if (prior && input.analysis.episodeRevision > prior.revision) {
        prior.result = { ...prior.result, settled: "superseded", verdict: "blocked_or_superseded" };
      }
      if (input.runner === false || input.port == null) {
        const missing = { ...base, settled: "missing_runner" as const };
        jobs.set(input.analysis.workKey, { revision: input.analysis.episodeRevision, result: missing });
        return missing;
      }
      if (input.budgetMs === 0) {
        const timeout = { ...base, settled: "timeout" as const };
        jobs.set(input.analysis.workKey, { revision: input.analysis.episodeRevision, result: timeout });
        return timeout;
      }
      try {
        const out = await input.port.analyze(input.analysis);
        const result = { ...base, verdict: out.verdict, limitations: [...base.limitations, ...out.limitations] };
        jobs.set(input.analysis.workKey, { revision: input.analysis.episodeRevision, result });
        return result;
      } catch {
        const blocked = { ...base, settled: "budget" as const, verdict: "blocked_or_superseded" as const };
        jobs.set(input.analysis.workKey, { revision: input.analysis.episodeRevision, result: blocked });
        return blocked;
      }
    },
  };
}

export function evidenceDigestOf(report: Pick<ReplayReport, "codes" | "supportGatePassed">, artifact?: CandidateArtifact): string {
  return sha256Text(`${report.supportGatePassed}:${report.codes.join(",")}:${artifact?.candidates.length ?? 0}`);
}

export async function writeAnalysisArtifact(out: string, result: AnalysisResult): Promise<string> {
  if (!isAbsolute(out)) invalid("--out must be an absolute path.");
  const dest = resolve(out);
  if (dest.endsWith("reviewed.json") || dest.endsWith("host-main.cjs")) invalid("out path leak risk.");
  try {
    await lstat(dest);
    invalid("out path already exists.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const parent = await lstat(dirname(dest)).catch(() => null);
  if (parent?.isSymbolicLink()) invalid("out parent must not be a symlink.");
  const body = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(dest, body, { mode: 0o600, flag: "wx" });
  return sha256Bytes(Buffer.from(body));
}

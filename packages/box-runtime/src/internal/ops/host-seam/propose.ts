import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { countOccurrences, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../../host/live-slices.ts";
import type { SlicePatch } from "../../host/profile.ts";
import { liveKnifeRecipe, recipeRevisionOf } from "./replay.ts";

export const PROPOSE_TOOL_REVISION = "hso-3.propose.v1";
const CANDIDATE_MAX = 16;
const PAIR_MAX = 16;
const FIELD_MAX = 8 * 1024;
const ARTIFACT_MAX = 1 * 1024 * 1024;
const SOURCE_MAX = 64 * 1024 * 1024;

export type CandidatePatch = {
  candidateId: string;
  patch: { id: "create-session" | "agent-id"; startAnchor: string; endAnchor: string; find: string; replacement: string };
  sourceRange: { startByte: number; endByte: number; windowSha256: string };
  counts: { pass: number; startGlobal: number; endGlobal: number; findInWindow: number; findGlobal: number; endAfterStart: boolean };
  rank: { score: number; signals: Array<{ signalId: string; group: string; matched: boolean; contribution: number }>; semanticCandidateCount: number };
  limitations: string[];
};

export type CandidatePair = {
  pairId: string;
  orderedCandidateIds: [string, string];
  reviewDigest: string;
  mechanicalReplay: "unique" | "ambiguous" | "missing";
  blockers: string[];
};

export type CandidateArtifact = {
  kind: "host-seam-candidates";
  schemaVersion: 1;
  published: false;
  approved: false;
  source: { sourceSha256: string; bytes: number; encoding: "utf8" };
  baseline: null | { sourceSha256: string; reviewedProfileSha256: string };
  analysis: {
    toolRevision: typeof PROPOSE_TOOL_REVISION;
    recipeRevision: string;
    engines: Array<{ id: string; version: string; status: "ok" | "truncated" }>;
    complete: boolean;
    truncated: boolean;
  };
  candidates: CandidatePatch[];
  pairs: CandidatePair[];
};

export type ProposeSummary = {
  process: "profile-propose";
  published: false;
  approved: false;
  sourceSha256: string;
  candidateCount: number;
  pairCount: number;
  truncated: boolean;
  artifactPath: string;
  artifactDigest: string;
  engines: CandidateArtifact["analysis"]["engines"];
  limitations: string[];
};

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

function offsets(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    found.push(index);
    from = index + needle.length;
  }
  return found;
}

function utf8(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), "utf8");
}

const FINGERPRINTS: Record<"create-session" | "agent-id", Array<{ signalId: string; group: string; needle: string; weight: number }>> = {
  "create-session": [
    { signalId: "shape-two-arg", group: "shape", needle: "createSession(onRequestId, sessionOptions)", weight: 25 },
    { signalId: "neighbor-labeling", group: "neighborhood", needle: "recordPostTurnLabeling", weight: 20 },
    { signalId: "token-prompt-session", group: "token", needle: "createCursorInferencePromptSession", weight: 20 },
  ],
  "agent-id": [
    { signalId: "shape-main-options", group: "shape", needle: "const mainSessionOptions = {", weight: 25 },
    { signalId: "bind-modelId", group: "binding", needle: "modelId: host.subagentModelId", weight: 35 },
    { signalId: "token-createSession-call", group: "token", needle: "host.inference.createSession", weight: 20 },
  ],
};

function fingerprint(source: string, sliceId: "create-session" | "agent-id", start: number, end: number) {
  const neighborhood = source.slice(Math.max(0, start - 512), Math.min(source.length, end + 512));
  const seen = new Set<string>();
  const signals = FINGERPRINTS[sliceId].map((signal) => {
    const matched = neighborhood.includes(signal.needle);
    const contribution = matched && !seen.has(signal.group) ? signal.weight : 0;
    if (matched) seen.add(signal.group);
    return { signalId: signal.signalId, group: signal.group, matched, contribution };
  });
  return { score: signals.reduce((sum, row) => sum + row.contribution, 0), signals };
}

function literalCandidates(source: string, slice: SlicePatch): { rows: CandidatePatch[]; truncated: boolean } {
  if (slice.id !== "create-session" && slice.id !== "agent-id") return { rows: [], truncated: false };
  if ([slice.startAnchor, slice.endAnchor, slice.find, slice.replacement].some((field) => field.length > FIELD_MAX)) {
    return { rows: [], truncated: true };
  }
  const starts = offsets(source, slice.startAnchor);
  const ends = offsets(source, slice.endAnchor);
  const startGlobal = countOccurrences(source, slice.startAnchor);
  const endGlobal = countOccurrences(source, slice.endAnchor);
  const findGlobal = countOccurrences(source, slice.find);
  const rows: CandidatePatch[] = [];
  let truncated = false;
  for (const start of starts) {
    for (const end of ends) {
      if (end < start) continue;
      if (rows.length >= CANDIDATE_MAX) {
        truncated = true;
        break;
      }
      const window = source.slice(start, end);
      const findInWindow = countOccurrences(window, slice.find);
      const limitations: string[] = ["textual_evidence_only", "not_executable_method"];
      if (startGlobal !== 1 || endGlobal !== 1) limitations.push("ambiguous-site");
      if (findInWindow !== 1) limitations.push(findInWindow === 0 ? "find-missing" : "find-duplicate");
      const before = start > 0 ? source[start - 1] : "";
      if (before === "\"" || before === "'" || before === "`") limitations.push("in_string_unverified");
      const fp = fingerprint(source, slice.id, start, end);
      const uniqueBonus = startGlobal === 1 && endGlobal === 1 && findInWindow === 1 ? 20 : 5;
      const candidateId = sha256Text(`${slice.id}:${start}:${end}:${slice.find}`).slice(0, 16);
      rows.push({
        candidateId,
        patch: {
          id: slice.id,
          startAnchor: slice.startAnchor,
          endAnchor: slice.endAnchor,
          find: slice.find,
          replacement: slice.replacement,
        },
        sourceRange: { startByte: utf8(source, start), endByte: utf8(source, end), windowSha256: sha256Text(window) },
        counts: {
          pass: 0,
          startGlobal,
          endGlobal,
          findInWindow,
          findGlobal,
          endAfterStart: end >= start,
        },
        rank: { score: fp.score + uniqueBonus, signals: fp.signals, semanticCandidateCount: starts.length },
        limitations,
      });
    }
  }
  rows.sort((a, b) => b.rank.score - a.rank.score || a.sourceRange.startByte - b.sourceRange.startByte || a.candidateId.localeCompare(b.candidateId));
  return { rows, truncated };
}

export function proposeFromSource(source: string, baseline: CandidateArtifact["baseline"] = null): CandidateArtifact {
  const recipe = liveKnifeRecipe();
  const create = literalCandidates(source, recipe.find((slice) => slice.id === "create-session") ?? LIVE_SLICE_PATCHES[0]!);
  const agent = literalCandidates(source, recipe.find((slice) => slice.id === "agent-id") ?? LIVE_SLICE_PATCHES[1]!);
  const candidates = [...create.rows, ...agent.rows];
  const truncated = create.truncated || agent.truncated || candidates.length > CANDIDATE_MAX * 2;
  const creates = create.rows;
  const agents = agent.rows;
  const pairs: CandidatePair[] = [];
  for (const left of creates) {
    for (const right of agents) {
      if (pairs.length >= PAIR_MAX) break;
      const unique = left.counts.startGlobal === 1 && left.counts.findInWindow === 1 && right.counts.startGlobal === 1 && right.counts.findInWindow === 1;
      const blockers = [...left.limitations, ...right.limitations].filter((item, index, all) => all.indexOf(item) === index);
      if (!unique) blockers.push("pair_not_unique");
      const orderedCandidateIds: [string, string] = [left.candidateId, right.candidateId];
      const reviewDigest = sha256Text(`${orderedCandidateIds.join("+")}:${left.patch.find}:${right.patch.find}`);
      pairs.push({
        pairId: `pair-${pairs.length + 1}`,
        orderedCandidateIds,
        reviewDigest,
        mechanicalReplay: unique ? "unique" : left.counts.findInWindow === 0 || right.counts.findInWindow === 0 ? "missing" : "ambiguous",
        blockers,
      });
    }
  }
  const bytes = Buffer.byteLength(source, "utf8");
  return {
    kind: "host-seam-candidates",
    schemaVersion: 1,
    published: false,
    approved: false,
    source: { sourceSha256: sha256Text(source), bytes, encoding: "utf8" },
    baseline,
    analysis: {
      toolRevision: PROPOSE_TOOL_REVISION,
      recipeRevision: recipeRevisionOf(recipe),
      engines: [
        { id: "literal", version: "v1", status: truncated ? "truncated" : "ok" },
        { id: "fingerprint", version: "v1", status: "ok" },
      ],
      complete: !truncated,
      truncated,
    },
    candidates,
    pairs,
  };
}

export async function readProposeSource(from: string): Promise<string> {
  if (!isAbsolute(from)) invalid("--from must be an absolute Host path.");
  const path = resolve(from);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) invalid("Host bundle input must be a regular non-symlink file.");
  if (info.nlink > 1) invalid("Host bundle input must not be a hardlink alias.");
  if (info.size > SOURCE_MAX) invalid("Host bundle exceeds the propose size budget.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = await handle.readFile();
    const source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) invalid("Host bundle must be valid UTF-8.");
    return source;
  } finally {
    await handle.close();
  }
}

export async function writeCandidateArtifact(out: string, from: string, artifact: CandidateArtifact): Promise<{ digest: string; path: string }> {
  if (!isAbsolute(out)) invalid("--out must be an absolute path.");
  const dest = resolve(out);
  const source = resolve(from);
  if (dest === source) invalid("out path must not be the input Host file.");
  if (dest.endsWith("reviewed.json") || dest.endsWith("host-main.cjs")) invalid("out path leak risk.");
  try {
    await lstat(dest);
    invalid("out path already exists.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const parent = await lstat(dirname(dest)).catch(() => null);
  if (parent?.isSymbolicLink()) invalid("out parent must not be a symlink.");
  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(body) > ARTIFACT_MAX) invalid("candidate artifact exceeds 1 MiB.");
  await writeFile(dest, body, { mode: 0o600, flag: "wx" });
  return { digest: sha256Bytes(Buffer.from(body)), path: dest };
}

export function proposeSummary(artifact: CandidateArtifact, written: { digest: string; path: string }): ProposeSummary {
  return {
    process: "profile-propose",
    published: false,
    approved: false,
    sourceSha256: artifact.source.sourceSha256,
    candidateCount: artifact.candidates.length,
    pairCount: artifact.pairs.length,
    truncated: artifact.analysis.truncated,
    artifactPath: written.path,
    artifactDigest: written.digest,
    engines: artifact.analysis.engines,
    limitations: [...new Set(artifact.candidates.flatMap((row) => row.limitations))],
  };
}

export function autoPublishTopCandidate(_artifact: CandidateArtifact): { published: false } {
  return { published: false };
}

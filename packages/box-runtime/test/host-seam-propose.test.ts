import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReviewedProfile, validateReviewedProfile } from "../src/internal/process/profile.node.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";
import {
  autoPublishTopCandidate,
  proposeFromSource,
  proposeSummary,
  writeCandidateArtifact,
} from "../src/internal/ops/host-seam/propose.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const MULTI = LIVE_SHAPED_HOST.replace(
  "const api = {",
  `const decoy = {
  createSession(onRequestId, sessionOptions) {
    return null;
    },
    recordPostTurnLabeling(args) {
      return args;
    },
};
const api = {`,
);

const STRINGY = `const decoy = "createSession(onRequestId, sessionOptions) {";\n${LIVE_SHAPED_HOST}`;

describe("HSO-3 propose", () => {
  test("enumerates multi-candidates with stable rank and no approval", () => {
    const artifact = proposeFromSource(MULTI);
    expect(artifact.kind).toBe("host-seam-candidates");
    expect(artifact.published).toBe(false);
    expect(artifact.approved).toBe(false);
    const creates = artifact.candidates.filter((row) => row.patch.id === "create-session");
    expect(creates.length).toBeGreaterThan(1);
    const scores = creates.map((row) => row.rank.score);
    const sorted = [...creates].sort((a, b) => b.rank.score - a.rank.score || a.sourceRange.startByte - b.sourceRange.startByte || a.candidateId.localeCompare(b.candidateId));
    expect(creates.map((row) => row.candidateId)).toEqual(sorted.map((row) => row.candidateId));
    expect(new Set(scores).size).toBeGreaterThanOrEqual(1);
    expect(artifact.candidates.every((row) => row.limitations.includes("not_executable_method"))).toBe(true);
    expect(artifact.candidates.some((row) => row.limitations.includes("ambiguous-site"))).toBe(true);
    const again = proposeFromSource(MULTI);
    expect(again.candidates.map((row) => row.candidateId)).toEqual(artifact.candidates.map((row) => row.candidateId));
  });

  test("string fake anchors are limited and candidates are not reviewed profiles", () => {
    const artifact = proposeFromSource(STRINGY);
    expect(artifact.candidates.some((row) => row.limitations.includes("in_string_unverified"))).toBe(true);
    expect(() => parseReviewedProfile(artifact)).toThrow(/Invalid reviewed profile/);
    expect(validateReviewedProfile(artifact, STRINGY).ok).toBe(false);
    expect(autoPublishTopCandidate(artifact)).toEqual({ published: false });
  });

  test("out conflict is refused and reviewed.json is not published", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso3-propose-"));
    const from = join(root, "host.cjs");
    const out = join(root, "candidates.json");
    await writeFile(from, LIVE_SHAPED_HOST);
    const artifact = proposeFromSource(LIVE_SHAPED_HOST);
    const written = await writeCandidateArtifact(out, from, artifact);
    const summary = proposeSummary(artifact, written);
    expect(JSON.stringify(summary)).not.toContain("createCursorInferencePromptSession");
    expect(JSON.stringify(summary)).not.toContain(LIVE_SHAPED_HOST.slice(0, 40));
    await expect(writeCandidateArtifact(out, from, artifact)).rejects.toThrow(/already exists/);
    await expect(writeCandidateArtifact(from, from, artifact)).rejects.toThrow(/must not be the input/);
    await expect(writeCandidateArtifact(join(root, "reviewed.json"), from, artifact)).rejects.toThrow(/leak/);
    expect(await readFile(reviewedProfilePath(root), "utf8").catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  });
});

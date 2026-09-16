import { describe, expect, test } from "bun:test";
import { NATIVE_REQUEST_SOURCES, observeNativeTurn, projectNativeTurnObservation } from "../src/internal/host/turn-observation.ts";
import { nextObservationIdentity, projectObservationIdentity } from "../src/internal/host/observation-identity.node.ts";
import { projectHostSeamStage } from "../src/internal/host/terminal-journal.node.ts";
import { projectRuntimeBuildInfo } from "@grokbox/runtime-kernel/contract";

const PARENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE = "DO_NOT_COPY_NATIVE_TOOL_ID_OR_PROMPT";

describe("native session lineage is observed without inventing execution identity", () => {
  for (const requestSource of NATIVE_REQUEST_SOURCES) {
    test(`native source ${requestSource} is an allowlisted fact`, () => {
      expect(observeNativeTurn({ requestSource })).toMatchObject({ source: requestSource, lineage: "absent", sourceEvidence: "native-session-options" });
    });
  }
  test("explicit parent/root UUIDs survive; raw tool identifiers and arbitrary options never do", () => {
    const result = observeNativeTurn({ requestSource: "agent", isSubagent: true, lineage: {
      parentRequestId: PARENT, rootParentRequestId: ROOT, parentAgentToolCallId: PRIVATE + "\n", prompt: PRIVATE,
    }, prompt: PRIVATE });
    expect(result).toMatchObject({ source: "agent", lineage: "provided", isSubagent: true,
      nativeParentRequestId: PARENT, nativeRootParentRequestId: ROOT, parentToolCallIdObserved: true });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(result).not.toHaveProperty("parentStepId");
    expect(result).not.toHaveProperty("parentTurnId");
    const projected = projectHostSeamStage({ name: "host_seam_stage", schemaVersion: 1,
      stage: "hook_enter", result: "entered", at: "2026-01-01T00:00:00.000Z", agentId: "owned", turnId: "turn", nativeTurn: result });
    expect(projected?.nativeTurn).toEqual(result);
  });
  test("unknown sources and malformed/partial lineage are not guessed from text or proximity", () => {
    expect(observeNativeTurn({ requestSource: PRIVATE, lineage: { parentRequestId: PARENT } })).toMatchObject({ source: "unknown", lineage: "invalid" });
    expect(observeNativeTurn({ prompt: "background resume", lineage: { parentRequestId: PRIVATE, rootParentRequestId: ROOT } })).toMatchObject({ source: "not_provided", lineage: "invalid" });
    expect(observeNativeTurn({})).toMatchObject({ lineage: "absent" });
    expect(projectNativeTurnObservation({ version: 1, sourceEvidence: "native-session-options", source: PRIVATE, lineage: "absent" })).toBeUndefined();
  });
  test("observation does not execute native option getters", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "lineage", { get() { reads++; throw new Error(PRIVATE); } });
    expect(observeNativeTurn(input)).toMatchObject({ lineage: "absent" });
    expect(reads).toBe(0);
  });
});

test("producer-local sequence is explicit and is not a cross-process clock", () => {
  const a = nextObservationIdentity("host"), b = nextObservationIdentity("host");
  expect(a.writerId).toBe(b.writerId);
  expect(b.sequence).toBe(a.sequence + 1);
  expect(projectObservationIdentity(a)).toEqual(a);
  expect(projectObservationIdentity({ ...a, eventId: "foreign" })).toBeUndefined();
  expect(projectObservationIdentity({ ...a, sequence: -1 })).toBeUndefined();
});

test("build metadata accepts only source fingerprint and bounded versions", () => {
  const build = { version: 1, kind: "bundled", sourceDigest: "a".repeat(64), compilerVersion: "0.28.2",
    sdkVersions: { ai: "5.0.253", openai: "2.0.125", effect: "4.0.0-beta.107" }, environment: PRIVATE };
  expect(projectRuntimeBuildInfo(build)).toMatchObject({ kind: "bundled", sourceDigest: "a".repeat(64) });
  expect(JSON.stringify(projectRuntimeBuildInfo(build))).not.toContain(PRIVATE);
  expect(projectRuntimeBuildInfo({ ...build, sourceDigest: PRIVATE })).toBeUndefined();
});

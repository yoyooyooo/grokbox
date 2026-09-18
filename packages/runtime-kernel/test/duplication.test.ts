import { expect, test } from "bun:test";
import { duplicateSource, duplicatePlan, duplicateRequest, duplicateInputDigest, duplicateCreated, duplicateEffectId } from "../src/continuity.ts";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const source = { agentId: sourceId, scopeId: "a".repeat(64), generation: "b".repeat(64), profileRevision: "c".repeat(64), routineRevision: "d".repeat(64),
  harness: "box" as const, observedAtMs: 1000, returnedRoutines: 1, enabledRoutines: 1, routineCoverage: "native_returned_window" as const };
const request = () => duplicateRequest({ version: 1, operationId, source, planRevision: duplicatePlan(source).revision });

test("plan revisions bind copying semantics and source revisions, not a refreshed observation timestamp", () => {
  const plan = duplicatePlan(source);
  expect(duplicatePlan({ ...source, observedAtMs: 2000 }).revision).toBe(plan.revision);
  for (const changed of [{ harness: "temporal" as const }, { scopeId: "f".repeat(64) }, { generation: "f".repeat(64) },
    { profileRevision: "f".repeat(64) }, { routineRevision: "f".repeat(64) }, { enabledRoutines: 0 }]) {
    expect(duplicatePlan({ ...source, ...changed }).revision).not.toBe(plan.revision);
  }
  expect(plan.effects).toMatchObject({ clearsConversation: true, guaranteedBox: false, nativeIdempotency: false, routinesAutomaticallyPaused: false });
  expect(plan.routineCoverageComplete).toBe(false);
});

test("only bounded data is accepted and dangerous accessors/coercions never run", () => {
  let touched = false;
  for (const key of Object.keys(source)) {
    const value = { ...source }; Object.defineProperty(value, key, { get() { touched = true; throw Error(); }, enumerable: true });
    expect(() => duplicateSource(value)).toThrow("invalid_material");
  }
  expect(() => duplicateSource({ ...source, harness: { toString() { touched = true; return "box"; } } })).toThrow("invalid_material");
  for (const mutation of [{ enabledRoutines: 2 }, { returnedRoutines: 101 }, { observedAtMs: NaN }, { routineCoverage: "complete" }, { rawPrompt: "do-not-copy" }]) {
    expect(() => duplicateSource({ ...source, ...mutation })).toThrow("invalid_material");
  }
  expect(touched).toBe(false);
});

test("saved request and native identity response are exact, detached and independently bound", () => {
  const r = request(); expect(duplicateInputDigest(r)).toHaveLength(64);
  const result = { version: 1, operationId, sourceAgentId: sourceId, targetAgentId: targetId, scopeId: source.scopeId,
    generation: source.generation, receivedAtMs: 1100, evidence: "native_response" };
  expect(duplicateCreated(result, r).targetAgentId).toBe(targetId);
  for (const mutation of [{ operationId: targetId }, { sourceAgentId: targetId }, { targetAgentId: sourceId }, { scopeId: "f".repeat(64) },
    { generation: "f".repeat(64) }, { receivedAtMs: 999 }, { evidence: "name-match" }, { token: "never" }]) {
    expect(() => duplicateCreated({ ...result, ...mutation }, r)).toThrow("invalid_material");
  }
  expect(duplicateEffectId(operationId)).toBe(duplicateEffectId(operationId));
  expect(duplicateEffectId(operationId)).not.toBe(duplicateEffectId(targetId));
  expect(() => duplicateRequest({ ...r, planRevision: "0".repeat(64) })).toThrow("invalid_material");
});

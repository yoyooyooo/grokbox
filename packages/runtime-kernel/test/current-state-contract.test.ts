import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applicationObservation, assertInitializationPermission, captureCurrentRequest, initializationDigest, initializeCurrentRequest,
  nativeCurrentHead, nativeQualification, preparedCurrentState, type InitializeCurrentRequest } from "../src/continuity.ts";

const head = () => ({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId: "a".repeat(64), hostSourceSha: "b".repeat(64),
  nativeSchema: "owned-v1", hostGeneration: "host-1", contextRevision: "c".repeat(64), activationEpoch: "epoch-1",
  rootHash: null, state: "empty" as const, effects: "clear" as const });
const request = (): InitializeCurrentRequest => ({ operationId: randomUUID(), effectId: randomUUID(), expected: head(), policyRevision: "d".repeat(64),
  snapshot: { owner: "continuity.recovery", ref: randomUUID(), revision: "e".repeat(64) } });

test("head and request are bounded data, not arbitrary native commands or session switches", () => {
  expect(nativeCurrentHead(head())).toEqual(head());
  for (const patch of [{ sessionId: "another" }, { path: "/private" }, { contextRevision: "not-a-digest" },
    { state: "empty", rootHash: "f".repeat(64) }, { hostGeneration: "x".repeat(129) }, { scopeId: randomUUID() }]) {
    expect(() => nativeCurrentHead({ ...head(), ...patch })).toThrow();
  }
  expect(() => initializeCurrentRequest({ ...request(), action: "eval" })).toThrow();
  expect(() => initializeCurrentRequest({ ...request(), expected: { ...head(), effects: "unresolved" } })).toThrow("not_prepared");
});

test("parsers do not evaluate accessors and detach input objects", () => {
  let reads = 0; const input = { ...request(), get ignored() { reads++; return "SECRET"; } };
  expect(() => initializeCurrentRequest(input)).toThrow(); expect(reads).toBe(0);
  const original = request(), parsed = initializeCurrentRequest(original); original.expected.hostGeneration = "changed";
  expect(parsed.expected.hostGeneration).toBe("host-1");
  const capture = captureCurrentRequest({ requestId: randomUUID(), expected: head() }); expect(capture.expected.state).toBe("empty");
});

test("operation digest binds exact target, source material, expected state, effect and policy", () => {
  const r = request(), digest = initializationDigest(r);
  for (const next of [{ ...r, effectId: randomUUID() }, { ...r, snapshot: { ...r.snapshot, revision: "f".repeat(64) } },
    { ...r, expected: { ...r.expected, activationEpoch: "epoch-2" } }, { ...r, policyRevision: "f".repeat(64) }]) expect(initializationDigest(next)).not.toBe(digest);
  expect(initializationDigest(structuredClone(r))).toBe(digest);
});

test("authority age is checked against the original sample and the exact host/policy", () => {
  const r = request(), now = 1700000000000;
  const permission = { allowed: true, operationId: r.operationId, agentId: r.expected.agentId, scopeId: r.expected.scopeId,
    policyRevision: r.policyRevision, ownership: "confirmed_box", observedAtMs: now - 5000, hostGeneration: r.expected.hostGeneration };
  expect(assertInitializationPermission(permission, r, now).observedAtMs).toBe(now - 5000);
  expect(() => assertInitializationPermission(permission, r, now + 1)).toThrow("ownership_unconfirmed");
  expect(() => assertInitializationPermission(permission, r, now - 5001)).toThrow("ownership_unconfirmed");
  expect(() => assertInitializationPermission({ ...permission, hostGeneration: "another" }, r, now)).toThrow("ownership_unconfirmed");
  expect(() => assertInitializationPermission({ ...permission, allowed: false }, r, now)).toThrow("policy_changed");
});

test("native qualification must be an explicit source/schema pair, not a boolean or arbitrary body", () => {
  expect(nativeQualification({ hostSourceSha: head().hostSourceSha, nativeSchema: "owned-v1" })).toEqual({ hostSourceSha: head().hostSourceSha, nativeSchema: "owned-v1" });
  expect(() => nativeQualification({ qualified: true })).toThrow();
  expect(() => nativeQualification({ hostSourceSha: "latest", nativeSchema: "owned-v1" })).toThrow();
});

test("candidate and applied receipt bind the same operation; absence never becomes a successful receipt", () => {
  const r = request(), attempt = { ...r, inputDigest: initializationDigest(r) };
  expect(preparedCurrentState({ candidateHash: "f".repeat(64), rootHash: "a".repeat(64), inputDigest: attempt.inputDigest }, attempt).inputDigest).toBe(attempt.inputDigest);
  expect(() => preparedCurrentState({ candidateHash: "f".repeat(64), rootHash: "a".repeat(64), inputDigest: "e".repeat(64) }, attempt)).toThrow();
  expect(applicationObservation({ state: "absent", current: head() }, attempt)).toEqual({ state: "absent", current: head() });
  expect(() => applicationObservation({ state: "applied", current: head(), marker: { state: "done" } }, attempt)).toThrow();
  expect(() => applicationObservation({ state: "absent", current: { ...head(), agentId: randomUUID() } }, attempt)).toThrow();
});

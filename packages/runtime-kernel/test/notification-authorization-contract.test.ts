import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { automaticAuthorizationView, validateNoticeAuthorization } from "@grokbox/runtime-kernel/observation";

const current = () => ({ version: 2 as const, consent: "explicit-enable" as const, id: randomUUID(), operationId: "enable-current",
  requestDigest: "a".repeat(64), bindingRevision: 2, activatedAtMs: Date.now(), modelRevision: "b".repeat(64),
  qualificationRevision: "c".repeat(64), nativeTurnObserved: false as const, includesExistingWork: false as const });

test("the sole ongoing authorization is explicit enable, independent of any test delivery", () => {
  const input = current(), result = validateNoticeAuthorization(input);
  expect(result).toEqual(input); expect(result).not.toBe(input);
  expect(automaticAuthorizationView(result)).toMatchObject({ state: "authorized", consent: "explicit-enable", testRequired: false,
    includesExistingWork: false, nativeTurnObserved: false, currentEligibility: "requires_fresh_checks" });
});

test("a historical tested-consent grant cannot authorize current notifications or be normalized into explicit enable", () => {
  const { consent: _, ...base } = current();
  const old = { ...base, version: 1, seedWorkId: randomUUID(), seedAttemptId: randomUUID(), seedEnvelopeDigest: "d".repeat(64),
    seedAcceptedAtMs: base.activatedAtMs - 1, receiverAttestation: "operator-confirmed-reminder" };
  const before = JSON.stringify(old);
  expect(() => validateNoticeAuthorization(old)).toThrow("invalid_automatic_authorization");
  expect(() => automaticAuthorizationView(old as never)).toThrow("invalid_automatic_authorization");
  expect(JSON.stringify(old)).toBe(before);
  for (const patch of [{ version: 3 }, { consent: "legacy-tested-consent" }, { consent: undefined }, { testPassed: true },
    { nativeTurnObserved: true }, { includesExistingWork: true }]) {
    expect(() => validateNoticeAuthorization({ ...current(), ...patch })).toThrow("invalid_automatic_authorization");
  }
});

for (const field of ["version", "consent", "id", "bindingRevision"]) test(`authorization rejects ${field} accessors without evaluating them`, () => {
  let reads = 0;
  const input = current();
  Object.defineProperty(input, field, { enumerable: true, get: () => { reads++; return field === "version" ? 2 : "explicit-enable"; } });
  expect(() => validateNoticeAuthorization(input)).toThrow("invalid_automatic_authorization");
  expect(reads).toBe(0);
});

test("inherited, symbol or non-enumerable authorization fields do not become a different accepted document", () => {
  expect(() => validateNoticeAuthorization(Object.create(current()))).toThrow("invalid_automatic_authorization");
  const withSymbol = { ...current(), [Symbol("private")]: "hidden" };
  expect(() => validateNoticeAuthorization(withSymbol)).toThrow("invalid_automatic_authorization");
  const hidden = current(); Object.defineProperty(hidden, "legacy", { value: true, enumerable: false });
  expect(() => validateNoticeAuthorization(hidden)).toThrow("invalid_automatic_authorization");
});

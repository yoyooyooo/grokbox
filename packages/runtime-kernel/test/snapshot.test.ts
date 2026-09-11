import { describe, expect, test } from "bun:test";
import { EnvelopeError, contextSnapshotBody, parseContextSnapshot } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";

function body(overrides: Record<string, unknown> = {}) {
  return contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }],
    messages: [{ role: "user", content: "ask" }],
    tools: [],
    options: {},
    ...overrides,
  });
}

function sealed(overrides: Record<string, unknown> = {}) {
  const snapshotBody = body(overrides);
  return { ...snapshotBody, snapshotDigest: computeSnapshotDigest(snapshotBody) };
}

function rejectCode(value: unknown): string {
  try {
    parseContextSnapshot(value);
    throw new Error("expected EnvelopeError");
  } catch (error) {
    expect(error).toBeInstanceOf(EnvelopeError);
    return (error as EnvelopeError).code;
  }
}

describe("parseContextSnapshot canonical boundary", () => {
  test("Astra combined alien/invalid toolChoice/fake digest is rejected", () => {
    const invalid = {
      version: 1,
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      systemMessages: [{ role: "system", content: "root" }],
      messages: [{ role: "alien", content: "must-not-drop" }],
      tools: [],
      options: { toolChoice: "invalid" },
      snapshotDigest: "0".repeat(64),
    };
    expect(["invalid_envelope", "unsupported_options"]).toContain(rejectCode(invalid));
  });

  test("unknown role is rejected even when the digest matches the invalid body", () => {
    expect(rejectCode(sealed({ messages: [{ role: "alien", content: "must-not-drop" }] }))).toBe("invalid_envelope");
  });

  test("invalid toolChoice is rejected even when the digest matches the invalid body", () => {
    expect(rejectCode(sealed({ options: { toolChoice: "invalid" } }))).toBe("unsupported_options");
  });

  test("format-valid digest that does not match recomputed body is rejected", () => {
    expect(rejectCode({ ...body(), snapshotDigest: "0".repeat(64) })).toBe("invalid_envelope");
  });

  test("valid snapshot is cloned, frozen, and digest-checked", () => {
    const accepted = parseContextSnapshot(sealed());
    expect(accepted.messages).toEqual([{ role: "user", content: "ask" }]);
    expect(accepted.snapshotDigest).toBe(computeSnapshotDigest(contextSnapshotBody(accepted)));
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.systemMessages[0])).toBe(true);
    expect(() => {
      accepted.systemMessages[0]!.content = "post-hash-root";
    }).toThrow();
    expect(accepted.systemMessages[0]!.content).toBe("root");
  });
});

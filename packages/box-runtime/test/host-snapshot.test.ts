import { describe, expect, test } from "bun:test";
import { EnvelopeError, contextSnapshotBody, parseContextSnapshot } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";

describe("Host context snapshot immutability", () => {
  test("Astra parser case is rejected before an empty encode path", () => {
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
    expect(() => parseContextSnapshot(invalid)).toThrow(EnvelopeError);
  });

  test("system root mutation cannot leave a stale digest", () => {
    const snapshot = hostToContextSnapshot({
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "original-root",
      state: [{ role: "user", content: "ask" }],
    });
    const before = snapshot.snapshotDigest;
    expect(() => {
      snapshot.systemMessages[0]!.content = "post-hash-root";
    }).toThrow();
    expect(snapshot.systemMessages[0]!.content).toBe("original-root");
    expect(snapshot.snapshotDigest).toBe(before);
    expect(computeSnapshotDigest(contextSnapshotBody(snapshot))).toBe(snapshot.snapshotDigest);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.systemMessages[0])).toBe(true);
  });
});

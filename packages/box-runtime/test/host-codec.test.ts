import { describe, expect, test } from "bun:test";
import { EnvelopeError } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";

const schema = { type: "object", properties: { q: { type: "string" } } };
const tools = [{ name: "lookup", inputSchema: schema }];

describe("Host context snapshot", () => {
  test("root in state appears exactly once and digest matches canonical hash", () => {
    const snapshot = hostToContextSnapshot({
      profileId: "state-root",
      abiIdentity: "host-abi-v1",
      state: [
        { role: "system", content: "root-from-state" },
        { role: "user", content: "hello" },
      ],
      tools,
    });
    expect(snapshot.systemMessages).toEqual([{ role: "system", content: "root-from-state" }]);
    expect(snapshot.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(snapshot.systemMessages).toHaveLength(1);
    expect(snapshot.messages.some((message) => message.role === "system")).toBe(false);
    expect(snapshot.snapshotDigest).toBe(computeSnapshotDigest(contextSnapshotBody(snapshot)));
  });

  test("independent root is exactly once and cannot coexist with state system", () => {
    const snapshot = hostToContextSnapshot({
      profileId: "independent-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "root-independent",
      state: [{ role: "user", content: "hello" }],
      tools,
    });
    expect(snapshot.systemMessages).toEqual([{ role: "system", content: "root-independent" }]);
    expect(() => hostToContextSnapshot({
      profileId: "dup",
      abiIdentity: "host-abi-v1",
      independentRoot: "root-independent",
      state: [{ role: "system", content: "also" }, { role: "user", content: "hello" }],
      tools,
    })).toThrow(EnvelopeError);
  });

  test("missing root provenance fails before provider", () => {
    expect(() => hostToContextSnapshot({
      profileId: "missing",
      abiIdentity: "host-abi-v1",
      state: [{ role: "user", content: "hello" }],
      tools,
    })).toThrow(EnvelopeError);
  });
});

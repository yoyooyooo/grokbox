import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvelopeError, SNAPSHOT_JSON_MAX_BYTES, contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const schema = { type: "object", properties: { q: { type: "string" } } };

function loadProfile(name: string): {
  profileId: string;
  abiIdentity: string;
  state: unknown;
  tools: unknown;
  independentRoot?: string;
} {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as {
    profileId: string;
    abiIdentity: string;
    state: unknown;
    tools: unknown;
    independentRoot?: string;
  };
}

describe("Host context snapshot", () => {
  test("authored state-root profile has required root exactly once", () => {
    const profile = loadProfile("t21-state-root.json");
    const snapshot = hostToContextSnapshot(profile);
    expect(snapshot.profileId).toBe("t21-state-root");
    expect(snapshot.systemMessages).toEqual([{ role: "system", content: "root-from-state" }]);
    expect(snapshot.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(snapshot.systemMessages).toHaveLength(1);
    expect(snapshot.messages.some((message) => message.role === "system")).toBe(false);
    expect(snapshot.snapshotDigest).toBe(computeSnapshotDigest(contextSnapshotBody(snapshot)));
  });

  test("authored independent-root profile has required root exactly once", () => {
    const profile = loadProfile("t21-independent-root.json");
    const snapshot = hostToContextSnapshot(profile);
    expect(snapshot.systemMessages).toEqual([{ role: "system", content: "root-independent" }]);
    expect(snapshot.messages.some((message) => message.role === "system")).toBe(false);
    expect(() => hostToContextSnapshot({
      ...profile,
      state: [{ role: "system", content: "also" }, { role: "user", content: "hello" }],
    })).toThrow(EnvelopeError);
  });

  test("missing or unknown root provenance fails before provider", () => {
    expect(() => hostToContextSnapshot({
      profileId: "missing",
      abiIdentity: "host-abi-v1",
      state: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", inputSchema: schema }],
    })).toThrow(EnvelopeError);
    expect(() => hostToContextSnapshot({
      profileId: "empty-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "",
      state: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", inputSchema: schema }],
    })).toThrow(EnvelopeError);
  });

  test("Host execute/getters never enter snapshot; bad schema does not catch/continue", () => {
    let executed = 0;
    let read = 0;
    const snapshot = hostToContextSnapshot({
      profileId: "tools",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "hello" }],
      tools: {
        lookup: {
          parameters: { jsonSchema: schema },
          execute: () => {
            executed += 1;
          },
        },
      },
    });
    expect(executed).toBe(0);
    expect(JSON.stringify(snapshot.tools)).not.toContain("execute");
    expect(snapshot.tools).toEqual([{ name: "lookup", inputSchema: schema }]);

    const getterTool = {
      name: "lookup",
      get inputSchema() {
        read += 1;
        return schema;
      },
    };
    expect(() => hostToContextSnapshot({
      profileId: "getter",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "hello" }],
      tools: [getterTool],
    })).toThrow(EnvelopeError);
    expect(read).toBe(0);

    expect(() => hostToContextSnapshot({
      profileId: "bad-schema",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", inputSchema: { type: "array" } }],
    })).toThrow(EnvelopeError);
  });

  test("unsupported content and oversize fail before provider without leaking sentinels", () => {
    try {
      hostToContextSnapshot({
        profileId: "unsupported",
        abiIdentity: "host-abi-v1",
        independentRoot: "root",
        state: [{ role: "user", content: [{ type: "file", url: "private-file-sentinel" }] }],
        tools: [{ name: "lookup", inputSchema: schema }],
      });
      throw new Error("expected EnvelopeError");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeError);
      expect(String(error)).not.toContain("private-file-sentinel");
    }
    expect(() => hostToContextSnapshot({
      profileId: "oversize",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "x".repeat(SNAPSHOT_JSON_MAX_BYTES + 1) }],
      tools: [{ name: "lookup", inputSchema: schema }],
    })).toThrow(EnvelopeError);
  });
});

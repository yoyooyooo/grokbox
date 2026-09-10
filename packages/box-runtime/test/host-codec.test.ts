import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvelopeError, SNAPSHOT_JSON_MAX_BYTES, contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { cloneHostExecutorWindow, hostToContextSnapshot } from "../src/internal/host/context-codec.ts";
import { sendCcsRequest } from "../src/internal/backends/ccs-codec.ts";

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

async function httpCount(snapshot: ReturnType<typeof hostToContextSnapshot>): Promise<number> {
  let count = 0;
  const deny = async (): Promise<Response> => {
    count += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const fetch = Object.assign(deny, { preconnect: deny }) as typeof globalThis.fetch;
  try {
    await sendCcsRequest({
      snapshot,
      api: "chat",
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL: "https://ccs.test/v1",
      fetch,
    });
  } catch { /* ignore */ }
  return count;
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
  });

  test("wrong source, unknown provenance, and stray system do not fall back", async () => {
    const independent = loadProfile("t21-independent-root.json");
    expect(() => hostToContextSnapshot({
      ...independent,
      independentRoot: undefined,
      state: [{ role: "system", content: "stray-system" }, { role: "user", content: "hello" }],
    })).toThrow(EnvelopeError);

    const stateRoot = loadProfile("t21-state-root.json");
    expect(() => hostToContextSnapshot({
      ...stateRoot,
      independentRoot: "wrong-source-root",
    })).toThrow(EnvelopeError);

    expect(() => hostToContextSnapshot({
      profileId: "unqualified-profile",
      abiIdentity: "host-abi-v1",
      independentRoot: "should-not-count",
      state: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", inputSchema: schema }],
    })).toThrow(EnvelopeError);

    expect(await httpCount(hostToContextSnapshot(loadProfile("t21-independent-root.json")))).toBeGreaterThan(0);
  });

  test("Host execute/getters never enter snapshot; bad schema does not catch/continue", () => {
    let executed = 0;
    let read = 0;
    const snapshot = hostToContextSnapshot({
      profileId: "t21-independent-root",
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
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "hello" }],
      tools: [getterTool],
    })).toThrow(EnvelopeError);
    expect(read).toBe(0);

    expect(() => hostToContextSnapshot({
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", inputSchema: { type: "array" } }],
    })).toThrow(EnvelopeError);
  });

  test("unsupported content and oversize fail before provider without leaking sentinels", () => {
    try {
      hostToContextSnapshot({
        profileId: "t21-independent-root",
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
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      independentRoot: "root",
      state: [{ role: "user", content: "x".repeat(SNAPSHOT_JSON_MAX_BYTES + 1) }],
      tools: [{ name: "lookup", inputSchema: schema }],
    })).toThrow(EnvelopeError);
  });
});

describe("Host tool-result extras from live Host unredact", () => {
  test("providerOptions and experimental_content on tool-result do not unsupported_content", () => {
    const cloned = cloneHostExecutorWindow([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "SendToUser", args: { text: "ok" }, providerOptions: { cursor: { t: 1 } } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "SendToUser",
          result: { ok: true },
          providerOptions: { cursor: { t: 1 } },
          experimental_content: [{ type: "text", text: "ok" }],
        }],
      },
    ]);
    expect(cloned).toHaveLength(3);
    const tool = cloned[2]!;
    expect(tool.role).toBe("tool");
    expect(Array.isArray(tool.content)).toBe(true);
    const part = (tool.content as Array<Record<string, unknown>>)[0]!;
    expect(part.type).toBe("tool-result");
    expect(part.providerOptions).toEqual({ cursor: { t: 1 } });
    expect(part.experimental_content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("unknown tool-result keys still fail closed", () => {
    expect(() => cloneHostExecutorWindow([{
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", result: {}, extra: true }],
    }])).toThrow(EnvelopeError);
  });
});

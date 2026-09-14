import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  bindHostCompactHook,
  requestHostCompact,
  resetHostCompactSlotForTests,
  stateSystemCompactHookOptions,
} from "../src/internal/host/compact.ts";
import {
  GROKBOX_HANDLE_SUMMARIZATION_KEYS,
  GROKBOX_HANDLE_SUMMARIZATION_STATIC,
  nativeSettledSnapshotMessages,
} from "./host-compact-abi-fixture.ts";

const TUPLE = {
  agentId: "abi-agent",
  turnId: "abi-turn",
  stepId: "abi-step",
  bindingId: "abi-bind",
  selectionRevision: "abi-rev",
};

const ALL_MESSAGES = [
  { role: "system", content: "sys" },
  { role: "user", content: "settled" },
  { role: "assistant", content: "in-flight step output" },
] as const;

afterEach(() => {
  resetHostCompactSlotForTests();
});

describe("grokbox HostCompact handleSummarization ABI", () => {
  test("current call is WaitForCompletion + input_token_limit_error and omits settledMessageCount", async () => {
    const resourceAccessor = { id: "abi-resource" };
    let options: Record<string, unknown> | undefined;
    bindHostCompactHook(stateSystemCompactHookOptions())({
      orchestrator: {
        async handleSummarization(...args: unknown[]) {
          const seventh = args[6];
          expect(seventh !== null && typeof seventh === "object" && !Array.isArray(seventh)).toBe(true);
          options = seventh as Record<string, unknown>;
          return "summary";
        },
      },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => [...ALL_MESSAGES] },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor,
      stepClosed: () => false,
    });

    const result = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(result.kind).toBe("snapshot");
    expect(options).toBeDefined();
    expect(options).toMatchObject({
      ...GROKBOX_HANDLE_SUMMARIZATION_STATIC,
      currentInvocationId: TUPLE.stepId,
      resourceAccessor,
    });
    expect(Object.keys(options ?? {}).sort()).toEqual([...GROKBOX_HANDLE_SUMMARIZATION_KEYS]);
    expect("settledMessageCount" in (options ?? {})).toBe(false);
    expect(options?.settledMessageCount).toBeUndefined();
  });

  test("compact.ts source still matches that call shape", async () => {
    const source = await readFile(new URL("../src/internal/host/compact.ts", import.meta.url), "utf8");
    expect(source).toContain('backgroundSummarizationMode: "WaitForCompletion"');
    expect(source).toContain('triggerReason: "input_token_limit_error"');
    expect(source).toContain("forceExternalModel: true");
    expect(source).not.toContain("settledMessageCount");
  });
});

describe("native settledMessageCount fork (decision input)", () => {
  test("only Background + present field switches the settled prefix; WaitForCompletion never slices", () => {
    const sliced = ALL_MESSAGES.slice(0, 2);
    const withField = { settledMessageCount: 2 };

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "Background",
      ...withField,
    })).toEqual(sliced);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "Background",
    })).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "WaitForCompletion",
      ...withField,
    })).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "BackgroundAndPersistIfCompleted",
      ...withField,
    })).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, GROKBOX_HANDLE_SUMMARIZATION_STATIC)).toEqual(ALL_MESSAGES);
    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      ...GROKBOX_HANDLE_SUMMARIZATION_STATIC,
      ...withField,
    })).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "Background",
      fullSummarization: true,
      ...withField,
    })).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages(ALL_MESSAGES, {
      backgroundSummarizationMode: "Background",
      ...withField,
    }, false)).toEqual(ALL_MESSAGES);

    expect(nativeSettledSnapshotMessages([
      { role: "user", content: "a" },
      { role: "system", content: "sys" },
      { role: "assistant", content: "in-flight" },
    ], {
      backgroundSummarizationMode: "Background",
      settledMessageCount: 1,
    })).toEqual([
      { role: "user", content: "a" },
      { role: "system", content: "sys" },
      { role: "assistant", content: "in-flight" },
    ]);
  });
});

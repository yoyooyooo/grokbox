import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EnvelopeError } from "@grokbox/runtime-kernel/contract";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { lookupHostRootContract, qualifyHostRootContract } from "../src/internal/host/root-contract.ts";
import { inferRootFromHostSelection, snapshotFromEnvelope } from "../src/internal/host/modeld-produce.node.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { HEX, SYNTHETIC_OPENAI, TEST_BINDING, withFakeHttpSession } from "./context-continuity-fixture.ts";

const compileOf = (profileId: string) => ({
  profileId,
  profileSha256: HEX("e"),
  sourceSha256: HEX("b"),
  transformedSha256: HEX("d"),
});

const stateMessages = [
  { role: "system" as const, content: "AUTHOR_SELECTED_ROOT_1" },
  { role: "user" as const, content: "HOST_QUESTION" },
];
const userOnly = [{ role: "user" as const, content: "HOST_QUESTION" }];

describe("profile-bound Host root provenance", () => {
  test("unknown patch profileIds stay unqualified; known snapshot-root ids lookup", () => {
    expect(lookupHostRootContract("t21-state-root")).toEqual({
      profileId: "t21-state-root",
      abiIdentity: "host-abi-v1",
      rootSource: "state-system",
    });
    expect(lookupHostRootContract("t21-independent-root")?.rootSource).toBe("independent");
    expect(lookupHostRootContract("unsupported-review-profile")).toBeUndefined();
    expect(lookupHostRootContract("e07-shaped")).toBeUndefined();
    expect(lookupHostRootContract("patch-profile")).toBeUndefined();
    expect(lookupHostRootContract(undefined)).toBeUndefined();
    expect(() => qualifyHostRootContract("unsupported-review-profile", "host-abi-v1")).toThrow(EnvelopeError);
  });

  test("shape inference remains the unbound fallback; independent contract does not relabel from a system message", () => {
    const envelope = buildHostEnvelope(stateMessages);
    expect(inferRootFromHostSelection(envelope)).toEqual({
      profileId: "t21-state-root",
      abiIdentity: "host-abi-v1",
    });
    expect(() => snapshotFromEnvelope(envelope, {
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
    })).toThrow(EnvelopeError);
  });

  test("session hook binds known compile roots and does not fail-close unknown compiled profiles", async () => {
    await withFakeHttpSession({ turnId: "TURN_UNUSED", fn: async ({ dir, requests }) => {
      await writeFile(join(dir, "models.json"), `${JSON.stringify({
        version: 3,
        models: { [SYNTHETIC_OPENAI.id]: SYNTHETIC_OPENAI },
        assignments: { main: null, agents: { "agent-tom": { modelId: SYNTHETIC_OPENAI.id } } },
      })}\n`);

      const stream = async (profileId: string, messages: unknown[], independentRoot: string | undefined, step: string) => {
        const before = requests.length;
        const hook = bindHostSessionHook({
          mode: "route",
          durableRoot: dir,
          runRoot: dir,
          binding: TEST_BINDING,
          compile: compileOf(profileId),
        });
        const managed = hook({
          originalSession: { kind: "official" },
          agentId: "agent-tom",
          sessionOptions: {
            invocationId: `TURN_${step}`,
            ...(independentRoot ? { independentRoot } : {}),
          },
        });
        expect(isHostPromptSession(managed)).toBe(true);
        if (!isHostPromptSession(managed)) throw new Error("session");
        const handle = managed.getExecutor(messages).stream({}, `STEP_${step}`);
        let rejected: unknown;
        try {
          await handle.response;
        } catch (error) {
          rejected = error;
        }
        return { rejected, http: requests.length - before };
      };

      expect(await stream("t21-state-root", stateMessages, undefined, "state-positive")).toMatchObject({
        rejected: undefined,
        http: 1,
      });
      expect(await stream("t21-independent-root", userOnly, "AUTHOR_SELECTED_ROOT_1", "independent-positive")).toMatchObject({
        rejected: undefined,
        http: 1,
      });
      const relabel = await stream(
        "t21-independent-root",
        stateMessages,
        undefined,
        "declared-independent-but-state-only",
      );
      expect(relabel.http).toBe(0);
      expect(relabel.rejected).toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
      expect(await stream("unsupported-review-profile", stateMessages, undefined, "unknown-compiled-profile")).toMatchObject({
        rejected: undefined,
        http: 1,
      });
    } });
  }, 20_000);
});

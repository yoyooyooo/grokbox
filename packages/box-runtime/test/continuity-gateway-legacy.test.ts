import { expect, test } from "bun:test";
import { createContinuityGatewayIO } from "../src/internal/io/continuity-gateway.node.ts";

test("legacy Memory RPC is not an allowed current continuity capability", async () => {
  let calls = 0;
  const gateway = createContinuityGatewayIO(
    async () => {
      calls += 1;
      throw new Error("transport should not be reached");
    },
    "/tmp/grokbox-test-root",
    new AbortController().signal,
    {
      routineProvision: async () => ({}),
      agentRoutines: async () => ({}),
    },
  );
  await expect(gateway.rpc("getAgentMemories" as never, {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toBe(0);
});

import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";

// Native-shaped model/profile choice remains Host-owned. The patch only adds identity.
const source = `
module.exports = async function run(host) {
  const inferenceRequestId = "owned-turn";
  const options2 = { clientNonce: "00000000-0000-4000-8000-000000000119" };
  const emitRequestId = () => {};
  const executorProfile = host.subagentType === "executor" ? host.subagentModelId : void 0;
  const mainSessionOptions = {
    ...executorProfile === void 0 ? { modelId: host.subagentModelId } : { executorProfile },
    requestSource: "owned-test"
  };
  return (async () => host.inference.createSession(emitRequestId, mainSessionOptions))();
};
`;
for (const subagentType of ["ordinary", "executor"]) {
  test(`agent-id seam preserves current Host ${subagentType} selection`, async () => {
    const applied = transformUnchecked(source, LIVE_SLICE_PATCHES.filter((slice) => slice.id === "agent-id"));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const module = { exports: undefined as unknown as (host: unknown) => Promise<Record<string, unknown>> };
    runInContext(applied.source, createContext({ module }));
    const result = await module.exports({
      subagentType, subagentModelId: "native-choice", getConversationId: () => "owned-agent",
      inference: { createSession: (_emit: unknown, options: unknown) => options },
    });
    expect(result).toEqual({
      agentId: "owned-agent", invocationId: "owned-turn",
      clientNonce: "00000000-0000-4000-8000-000000000119",
      requestSource: "owned-test",
      ...(subagentType === "executor" ? { executorProfile: "native-choice" } : { modelId: "native-choice" }),
    });
  });
}

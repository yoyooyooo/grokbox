import { expect, test } from "bun:test";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { createContinuityGatewayIO } from "../src/internal/io/continuity-gateway.node.ts";
const source = { baseUrl: "http://fixture.invalid", pid: 123, startedAt: 1 };
const identity = sha256Text(canonicalJson([source.baseUrl, source.pid, source.startedAt]));
const programs = { routineProvision: async () => null, agentRoutines: async () => null };
test("first native read verifies expected generation in the actual reply, not just a forwarded option", async () => {
  let calls = 0;
  const gateway = createContinuityGatewayIO(async (_method, _input, _signal, _timeout, _bytes, expected) => {
    calls++; expect(expected).toBe(identity);
    return { result: { entries: [] }, source: { ...source, startedAt: 2 } };
  }, "/fixture", new AbortController().signal, programs);
  await expect(gateway.rpc("getAgentTranscriptTail", {}, { timeoutMs: 1000, expectedGeneration: identity })).rejects.toThrow("source_changed");
  expect(calls).toBe(1);
});
test("an existing pinned gateway rejects a conflicting request identity without dispatch", async () => {
  let calls = 0;
  const gateway = createContinuityGatewayIO(async () => { calls++; return { result: [], source }; }, "/fixture", new AbortController().signal, programs);
  await gateway.listAgents(1000);
  await expect(gateway.rpc("sendPrompt", {}, { timeoutMs: 1000, expectedGeneration: "f".repeat(64) })).rejects.toThrow("source_changed");
  expect(calls).toBe(1);
});

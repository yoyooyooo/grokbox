import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { createLocalFirstBridge, HOST_LOCAL_FIRST_SYMBOL } from "../src/internal/host/local-first.ts";
import { LOCAL_FIRST_SLICES } from "../src/internal/host/local-first-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { isLocalFirstReceipt } from "@grokbox/runtime-kernel/products";
import { LOCAL_FIRST_SHAPED_HOST } from "./local-first-shaped-host.ts";

export const localFirstSource = { sourceSha256: "a".repeat(64), transformedSha256: "b".repeat(64), profileSha256: "c".repeat(64), generationId: "synthetic-loaded-generation" };
function fixture() {
  const bridge = createLocalFirstBridge(localFirstSource);
  const patched = transformUnchecked(LOCAL_FIRST_SHAPED_HOST, LOCAL_FIRST_SLICES); if (!patched.ok) throw Error(patched.code);
  const native = runInNewContext(`${patched.source}\n({createHostGatewayApi, SyntheticCreationIdentity})`, {
    [Symbol.for(HOST_LOCAL_FIRST_SYMBOL)]: bridge,
  });
  const state = { enabled: true, remote: 0, foreground: 0, factories: 0, writes: 0, retries: 0, registrationError: false,
    readError: false, temporal: false, factoryError: false, requests: [] as any[], rows: new Map<string, any>() };
  const identity = new native.SyntheticCreationIdentity();
  identity.deps = { retry: { runWithRetry: (run: () => unknown) => { state.retries++; return run(); } } };
  identity.isWriteEnabled = async () => state.enabled;
  identity.createRemoteAgentFirst = async () => { state.remote++; return {}; };
  identity.ensureServerBacked = async (id: string) => {
    const result = await identity.requestMint(async (q: any) => {
      state.writes++; state.requests.push(q);
      if (state.registrationError) throw Error("transport_response_lost");
      return { outcome: "created", agent: { agentId: id, id: `server-${id}`, harness: state.temporal ? "temporal" : "box" } };
    }, { agentId: id, createIntent: "register-existing-local", createCaller: "ensure-server-backed" });
    Object.assign(state.rows.get(id), { harness: result.agent.harness, serverId: result.agent.id });
    return { kind: "server_backed", serverId: result.agent.id, harness: result.agent.harness };
  };
  const manager = {
    createBackgroundAgent: async (p: any, origin: string, options: any) => {
      state.factories++; expect(origin).toBe("user"); expect(options).toEqual({ isIntroductionSuppressed: true, isKickstartRequested: false });
      if (state.factoryError) throw Error("factory_response_lost");
      const agent = { ...p, id: randomUUID(), isGroup: false }; state.rows.set(agent.id, agent); return { agent, transcript: [] };
    },
    listAgents: async () => { if (state.readError) throw Error("read_unavailable"); return [...state.rows.values()]; },
    createAgent: async () => { state.foreground++; return {}; },
  };
  const api = native.createHostGatewayApi({ extensions: { api: () => identity } }, manager);
  const args = { clientNonce: randomUUID(), name: "Quiet fixture", description: "", harness: "box", isIntroductionSuppressed: true, isKickstartRequested: false };
  return { api, identity, state, bridge, args };
}

test("recipe calls native local factory, forwards Box registration once and returns its unchanged identity", async () => {
  const f = fixture(), result = await f.api.createAgent(f.args), r = result.grokboxCreation;
  expect(isLocalFirstReceipt(r)).toBe(true); expect(r.outcome).toBe("registered"); expect(r.stage).toBe("readback");
  expect(r.localAgentId).toBe(result.agent.id); expect(r.firstResponse.serverId).toBe(r.binding.serverId);
  expect(f.state.requests).toEqual([{ agentId: result.agent.id, createIntent: "register-existing-local", createCaller: "ensure-server-backed",
    harness: "box", introductionSuppressed: true, kickstartRequested: false }]);
  expect([f.state.factories, f.state.writes, f.state.remote, f.state.foreground, f.state.retries]).toEqual([1, 1, 0, 0, 0]);
  expect(await f.api.createAgent(f.args)).toEqual(result); expect(f.state.factories).toBe(1);
  expect(f.bridge.read(f.args.clientNonce)).toEqual(r); expect(f.bridge.read(randomUUID())).toBeNull();
  await expect(f.api.createAgent({ ...f.args, name: "changed" })).rejects.toThrow("request_conflict");
});

test("unselected default/Temporal paths retain the original factory and retry behavior", async () => {
  const f = fixture();
  await f.api.createAgent({ ...f.args, harness: "temporal" }); await f.api.createAgent({ ...f.args, harness: undefined });
  expect([f.state.factories, f.state.remote, f.state.foreground]).toEqual([0, 2, 2]);
  const request = { agentId: randomUUID(), createIntent: "fresh" };
  expect(await f.identity.requestMint(async (q: unknown) => q, request)).toBe(request); expect(f.state.retries).toBe(1);
});

for (const failure of ["registrationError", "readError", "temporal"] as const) test(`${failure} retains first response, original identity and phase without retry, cleanup or model`, async () => {
  const f = fixture(); f.state[failure] = true;
  const result = await f.api.createAgent(f.args), r = result.grokboxCreation;
  expect(isLocalFirstReceipt(r)).toBe(true); expect(r.localAgentId).toBe(result.agent.id); expect(r.settled).toBe(true);
  expect(r.outcome).toBe(failure === "temporal" ? "mismatch" : "unknown");
  expect(r.stage).toBe(failure === "registrationError" ? "registration" : failure === "readError" ? "readback" : "server-result");
  expect(r.firstResponse?.harness ?? null).toBe(failure === "registrationError" ? null : failure === "temporal" ? "temporal" : "box");
  await f.api.createAgent(f.args); expect(f.state.factories).toBe(1); expect(f.state.writes).toBe(1); expect(f.state.retries).toBe(0);
});

test("authority refusal precedes creation; lost factory results remain unknown under the same request", async () => {
  const f = fixture(); f.state.enabled = false;
  await expect(f.api.createAgent(f.args)).rejects.toThrow("registration_unavailable"); expect(f.state.factories).toBe(0);
  f.state.enabled = true; f.state.factoryError = true;
  await expect(f.api.createAgent(f.args)).rejects.toThrow("factory_response_lost");
  await expect(f.api.createAgent(f.args)).rejects.toThrow("factory_response_lost");
  expect(f.state.factories).toBe(1); expect(f.state.writes).toBe(0);
  expect(f.bridge.read(f.args.clientNonce)).toMatchObject({ localAgentId: null, stage: "local-factory", outcome: "unknown", settled: true });
});

test("concurrent requests keep registration identities separate and same-request callers share one factory", async () => {
  const f = fixture();
  const other = { ...f.args, clientNonce: randomUUID(), name: "Second quiet fixture" };
  const [one, two, repeated] = await Promise.all([f.api.createAgent(f.args), f.api.createAgent(other), f.api.createAgent(f.args)]);
  expect(one.agent.id).not.toBe(two.agent.id); expect(repeated).toEqual(one);
  expect([f.state.factories, f.state.writes]).toEqual([2, 2]);
  expect(f.bridge.read(f.args.clientNonce)?.localAgentId).toBe(one.agent.id);
  expect(f.bridge.read(other.clientNonce)?.localAgentId).toBe(two.agent.id);
});

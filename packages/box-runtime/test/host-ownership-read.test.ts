import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "../src/internal/host/ownership-read.ts";
import { OWNERSHIP_READ_SLICES } from "../src/internal/host/ownership-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { OWNERSHIP_SHAPED_HOST } from "./ownership-shaped-host.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const readLocal = () => ({ harness: "box", serverId: "server-1" });
const readWindow = () => ({ kind: "inactive" });
const rows = [{ agentId: A, id: "server-1", harness: "box", createdAtMs: 123n, updatedAtMs: 124n, description: "PRIVATE_SENTINEL", token: "PRIVATE_SENTINEL" },
  { agentId: B, id: "server-2", harness: "temporal" }];

test("one native read returns only named finite identity metadata; no credentials or transcript", async () => {
  let reads = 0;
  const result = await bindHostOwnershipRead()({ agentIds: [A, B, C], readLocal, readWindow, listServer: async () => { reads++; return { agents: rows, token: "PRIVATE_SENTINEL" }; } });
  expect(reads).toBe(1);
  expect(result.state).toBe("observed");
  expect(result.agents).toHaveLength(3);
  expect(result.agents[0]).toMatchObject({ server: { serverId: "server-1", harness: "box", createdAtMs: "123" }, local: { stable: true }, serverEvidence: "found" });
  expect(result.agents[1]).toMatchObject({ server: { harness: "temporal" } });
  expect(result.agents[2]).toMatchObject({ server: null, serverEvidence: "not_returned" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});

test("bad target IDs, duplicates and too many targets refuse before server/auth", async () => {
  let reads = 0;
  for (const agentIds of [[], ["../../other"], [A, A], Array(33).fill(A), undefined]) {
    const result = await bindHostOwnershipRead()({ agentIds, readLocal, readWindow, listServer: async () => { reads++; throw Error("never"); } });
    expect(result.state).toBe("invalid_request");
  }
  expect(reads).toBe(0);
});

test("missing, duplicate and unknown server identity cannot be promoted to box", async () => {
  const result = await bindHostOwnershipRead()({ agentIds: [A, B], readLocal, readWindow, listServer: async () => ({ agents: [rows[0], rows[0], { agentId: B, id: "server-2", harness: "unsupported" }] }) });
  expect(result.agents[0]).toMatchObject({ server: null, serverEvidence: "ambiguous" });
  expect(result.agents[1]).toMatchObject({ server: { harness: "unknown" } });
});

test("server authorization and malformed responses have sanitized failures, not default box", async () => {
  for (const [listServer, errorCode] of [
    [async () => { throw Object.assign(new Error("PRIVATE_SENTINEL"), { code: 16 }); }, "authorization_unavailable"],
    [async () => ({ token: "PRIVATE_SENTINEL" }), "invalid_response"],
    [async () => { throw Error("PRIVATE_SENTINEL"); }, "server_read_failed"],
  ] as const) {
    const result = await bindHostOwnershipRead()({ agentIds: [A], readLocal, readWindow, listServer });
    expect(result).toMatchObject({ state: "unavailable", errorCode });
    expect(result.agents[0]).toMatchObject({ server: null, serverEvidence: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  }
});

test("bounded timeout aborts native read; overlapping reads are refused", async () => {
  const hook = bindHostOwnershipRead({ timeoutMs: 20 });
  let signal: AbortSignal | undefined;
  const ports = { agentIds: [A], readLocal, readWindow, listServer: async (s: AbortSignal) => { signal = s; return await new Promise(() => {}); } };
  const first = hook(ports);
  expect((await hook(ports)).state).toBe("busy");
  expect(await first).toMatchObject({ state: "unavailable", errorCode: "timeout" });
  expect(signal?.aborted).toBe(true);
});

test("local identity or migration-window changes remain in evidence", async () => {
  let reads = 0;
  let windows = 0;
  const result = await bindHostOwnershipRead()({ agentIds: [A],
    readLocal: () => ({ harness: ++reads === 1 ? "box" : "temporal", serverId: "server-1" }),
    readWindow: () => ++windows === 1 ? ({ kind: "inactive" }) : ({ kind: "active", status: "busy", secret: "PRIVATE_SENTINEL" }),
    listServer: async () => ({ agents: rows }),
  });
  expect(result.agents[0]).toMatchObject({ local: { stable: false } });
  expect(result).toMatchObject({ localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "active", status: "busy" } } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});

test("actual applied Gateway wrapper leaves ordinary status unchanged and borrows only native read/auth", async () => {
  const applied = transformUnchecked(OWNERSHIP_SHAPED_HOST, OWNERSHIP_READ_SLICES);
  if (!applied.ok) throw Error(applied.code);
  let nativeReads = 0;
  let credentialReads = 0;
  const context = createContext({
    Symbol,
    globalThis: { [Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)]: bindHostOwnershipRead() },
    // createHostGatewayApi receives environment directly, not extension context.host.
    deps: { environment: { backend: { backendUrl: "https://owned.invalid" } }, getHealth: () => ({ isBusy: false }),
      extensions: { api(name: string) {
        if (name === "host-upgrade") return { getVersionState: () => ({ version: "owned" }) };
        if (name === "auth") return {
          getAccessToken: async () => { credentialReads++; return "PRIVATE_SENTINEL"; },
          peekAccessToken: () => "PRIVATE_SENTINEL", getTeamId: async () => null, getMachineId: () => "owned-machine",
        };
        if (name === "resume-ownership") return { getSettledHostWindow: readWindow };
        if (name === "turn-execution") return { isLocalWorkAllowed: true, canExecute: true };
        throw Error(`unexpected native dependency: ${name}`);
      } } },
    BASE_HOST_CAPABILITIES: { fixture: true },
    GrokBotService: {},
    tokenSubjectScope: () => "a".repeat(64),
    createSandCursorBackendClient: (_service: unknown, opts: { backend: unknown; getAccessToken: () => Promise<string> }) => ({
      async listGrokBotAgents(_args: unknown, input: { signal: AbortSignal }) {
        expect(input.signal.aborted).toBe(false);
        expect(opts.backend).toEqual({ backendUrl: "https://owned.invalid" });
        expect(await opts.getAccessToken()).toBe("PRIVATE_SENTINEL");
        nativeReads++;
        return { agents: rows };
      },
    }),
    getSandAgentsRootDir: () => "/owned/agents", getSandProfilePath: (p: string) => `${p}/profile.json`,
    readSandProfileHarness: () => "box", readSandProfileServerId: () => "server-1",
  });
  runInContext(applied.source + "\nglobalThis.api = ownershipFixtureAPI;", context);
  const api = (context.globalThis as unknown as { api: { getHostStatus(input: unknown): Promise<any> } }).api;
  expect(await api.getHostStatus({})).toEqual({ version: "owned", isBusy: false, capabilities: { fixture: true } });
  expect(nativeReads).toBe(0);
  const result = await api.getHostStatus({ grokboxOwnershipAgentIds: [A] });
  expect(result.grokboxOwnership).toMatchObject({ schemaVersion: 3, state: "observed",
    localExecution: { before: { allowed: true, bound: true }, after: { allowed: true, bound: true } },
    agents: [{ server: { harness: "box" } }] });
  expect(nativeReads).toBe(1);
  expect(credentialReads).toBe(1);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});

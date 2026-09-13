import { expect, test } from "bun:test";
import { decideManagedOwnership, inspectOwnership } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const A = "77777777-7777-4777-8777-777777777777";
const at = 20_000;
const scope = { backend: "https://owned.invalid", account: "a".repeat(64), team: null, machine: "owned-machine" };
const baseline = {
  agentIds: [A], readScope: () => scope,
  readWindow: () => ({ kind: "inactive" }),
  readLocal: () => ({ serverId: "owned-id", harness: "box" }),
  listServer: async () => ({ agents: [{ agentId: A, id: "owned-id", harness: "box", viewerIsOwner: true }] }),
};

for (const condition of ["paused", "unbound", "missing", "throws", "malformed"] as const) {
  test(`inactive migration is not local-execution permission: ${condition}`, async () => {
    const read = bindHostOwnershipRead({ now: () => at });
    const ports = { ...baseline, readExecution: condition === "missing" ? undefined : () => {
      if (condition === "throws") throw new Error("PRIVATE_EXECUTION_SENTINEL");
      if (condition === "malformed") return { allowed: "true", bound: "true" };
      return { allowed: condition !== "paused", bound: condition !== "unbound" };
    } };
    const result = await read(ports);
    // Registration is a separate fact; the native pause can deny eligibility
    // without inventing a different Server harness or a migration.
    expect(inspectOwnership({ agentIds: [A], snapshot: result }).agents[0]?.state).toBe("confirmed_box");
    expect(decideManagedOwnership({ agentId: A, snapshot: result, nowMs: at }).ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_EXECUTION_SENTINEL");
  });
}

test("scope, registration and native execution are all present before admission", async () => {
  const read = bindHostOwnershipRead({ now: () => at });
  const ports = { ...baseline, readExecution: () => ({ allowed: true, bound: true }) };
  const result = await read(ports);
  expect(result).toMatchObject({ schemaVersion: 3,
    localExecution: { before: { allowed: true, bound: true }, after: { allowed: true, bound: true } } });
  expect(decideManagedOwnership({ agentId: A, snapshot: result, nowMs: at }).ok).toBe(true);
});

test("native pause during List cannot be hidden by an inactive migration window", async () => {
  let allowed = true;
  const ports = { ...baseline, readExecution: () => ({ allowed, bound: true }),
    listServer: async () => { allowed = false; return baseline.listServer(); } };
  const result = await bindHostOwnershipRead({ now: () => at })(ports);
  expect(decideManagedOwnership({ agentId: A, snapshot: result, nowMs: at }).ok).toBe(false);
  expect(result).toMatchObject({ localExecution: { before: { allowed: true }, after: { allowed: false } } });
});

test("Server cache hit always rereads native local-work state", async () => {
  let allowed = true, serverReads = 0, executionReads = 0;
  const read = bindHostOwnershipRead({ now: () => at, cacheMs: 2000 });
  const ports = { ...baseline, readExecution: () => { executionReads++; return { allowed, bound: true }; },
    listServer: async () => { serverReads++; return baseline.listServer(); } };
  expect(decideManagedOwnership({ agentId: A, snapshot: await read(ports), nowMs: at }).ok).toBe(true);
  allowed = false;
  expect(decideManagedOwnership({ agentId: A, snapshot: await read(ports), nowMs: at }).ok).toBe(false);
  expect(serverReads).toBe(1);
  expect(executionReads).toBe(4);
});

test("older scoped evidence remains readable but never silently grants local-work permission", () => {
  const snapshot = { ...ownedOwnershipSnapshot([A], { nowMs: at }), schemaVersion: 2 };
  expect(inspectOwnership({ agentIds: [A], snapshot }).agents[0]?.state).toBe("confirmed_box");
  expect(decideManagedOwnership({ agentId: A, snapshot, nowMs: at }).ok).toBe(false);
});

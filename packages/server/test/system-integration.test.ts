import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { projectRuntimeStatus, type StatusEvidence } from "@grokbox/runtime-kernel/status";
import { readControllerOperation } from "@grokbox/box-runtime/runtime";
import { systemHostView, systemIntegrationView, integrationOperationView } from "@grokbox/client/contract";
import { systemIntegrationQuery, type SystemIntegrationDomain } from "../src/system-integration.ts";
import type { Principal } from "../src/access.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const owner: Principal = { id: "installation-owner", capabilities: ["system.read", "operations.read"] };
const observation = <T>(source: string, value: T) => ({ source, value, gap: null, observedAt: "2026-09-22T12:00:00.000Z" });
const evidence: StatusEvidence = {
  now: "2026-09-22T12:00:00.000Z", durableRoot: "/private/root/must-not-leak",
  desired: observation("config.json/runtime.desiredMode", "route"),
  attestation: observation("attestation.json", null),
  coordinator: observation("state/coordinator.json", { circuit: "open", circuitReason: "pending_uncertain" }),
  operationJournal: observation("ops/adopt.json", { pending: true, phase: "unknown" }),
  modeld: observation("modeld.sock", { required: true, ready: false }),
  controllerLiveness: { source: "controller", value: null, gap: "missing", observedAt: null },
  bridgeHost: observation("processes", { actual: "unknown", origin: "ambiguous", coverage: "window-open", reason: "missing_role" }),
  hostDelivery: { source: "run/log/events.ndjson", value: null, gap: "missing", observedAt: null },
};
const query = (domain: SystemIntegrationDomain, path: string, principal = owner, method = "GET") =>
  Effect.runPromise(systemIntegrationQuery(domain, principal, method, new URL(path, "http://localhost")));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-integration-read-")); roots.push(root);
  await mkdir(join(root, "state"), { mode: 0o700 });
  const path = join(root, "state", "controller-operations.json");
  const document = JSON.stringify({ operation1: { fingerprint: "private-original-fingerprint", state: "unknown",
    prefix: { signaled: true, spawned: false, guardian: false } } });
  await writeFile(path, document, { mode: 0o600 });
  return { root, path, document };
}

test("Host and integration views preserve gaps and separate adoption from official lifecycle", async () => {
  const { root } = await fixture();
  let reads = 0;
  const domain = { root, readStatus: async () => { reads++; return projectRuntimeStatus(evidence); } };
  const host = await query(domain, "/v1/system/host");
  const integration = await query(domain, "/v1/system/integration");
  expect(systemHostView(host)).toBe(true);
  expect(systemIntegrationView(integration)).toBe(true);
  expect(host).toMatchObject({ component: "official-host", lifecycleOwner: "official-supervisor", actual: "unknown", origin: "ambiguous" });
  expect(integration).toMatchObject({ bridge: { value: { desired: "route", actual: "unknown" } },
    circuit: { value: { state: "open" } }, recovery: { value: { state: "recovery-required" } } });
  expect(JSON.stringify([host, integration])).not.toContain(evidence.durableRoot);
  expect(reads).toBe(2);
  expect(await readdir(join(root, "state"))).toEqual(["controller-operations.json"]);
});

test("original unknown receipt and reconciliation never clear the journal or authorize replay", async () => {
  const { root, path, document } = await fixture();
  const domain = { root, readStatus: async () => projectRuntimeStatus(evidence) };
  const operation = await query(domain, "/v1/system/integration/operations/operation1");
  expect(integrationOperationView(operation)).toBe(true);
  expect(operation).toMatchObject({ state: "unknown", owner: "original-controller", effects: { signaled: true }, replayAuthorized: false });
  expect(JSON.stringify(operation)).not.toContain("fingerprint");
  const reconciled = await query(domain, "/v1/system/integration/operations/operation1/reconciliation");
  expect(reconciled).toMatchObject({ reconciliation: "observation-only", operation: { state: "unknown", replayAuthorized: false } });
  expect(await readFile(path, "utf8")).toBe(document);
  expect(await readdir(join(root, "state"))).toEqual(["controller-operations.json"]);
});

test("authorization and malformed input refuse before inspecting native status or receipt", async () => {
  let touched = 0;
  const domain = { root: "/unused", readStatus: async () => { touched++; return projectRuntimeStatus(evidence); },
    readOperation: () => { touched++; return null; } };
  const delegated: Principal = { id: "delegated", capabilities: ["system.read", "operations.read"] };
  await expect(query(domain, "/v1/system/integration/operations/operation1", delegated)).rejects.toThrow("installation owner");
  await expect(query(domain, "/v1/system/host", { id: "no-access", capabilities: [] })).rejects.toThrow("required capability");
  await expect(query(domain, "/v1/system/host?refresh=true")).rejects.toThrow("query parameters");
  await expect(query(domain, "/v1/system/host", owner, "POST")).rejects.toThrow("accepts a read");
  expect(touched).toBe(0);
});

test("original receipt lookup does not initialize missing state and preserves corrupted evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-integration-missing-")); roots.push(root);
  expect(readControllerOperation(root, "unknown-operation")).toBeNull();
  expect(await readdir(root)).toEqual([]);
  const { root: corruptRoot, path } = await fixture();
  await writeFile(path, "{corrupt", { mode: 0o600 });
  await expect(query({ root: corruptRoot }, "/v1/system/integration/operations/operation1")).rejects.toThrow("journal is unavailable");
  expect(await readFile(path, "utf8")).toBe("{corrupt");
});

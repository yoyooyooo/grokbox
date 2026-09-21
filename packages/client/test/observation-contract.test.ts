import { test, expect } from "bun:test";
import { incidentList, observationEvents, observationSnapshot, managementService } from "../src/observation-validation.ts";
import type { IncidentList, ObservationEventPage, ObservationSnapshot } from "../src/contract.ts";

const I = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333", E = "44444444-4444-4444-8444-444444444444";
const snapshot: ObservationSnapshot = {
  source: "local-observations", admissionAuthority: false, coverage: "watched-bots-only", databaseId: D, collectorEpoch: E,
  scopeId: "a".repeat(64), cursor: `${D}:${E}:1`, readAtMs: 100,
  collector: { recordedRunning: true, liveness: "not-probed", lastHeartbeatMs: 90 }, storage: { schemaVersion: 4 },
  agents: [{ agentId: A, botRef: `bot:${I}:${A}`, lastKnown: { state: "confirmed_box", serverHarness: "box", localHarness: "box" },
    lastAttemptMs: 90, lastSuccessMs: 90, freshness: "fresh" }],
};
const incidents: IncidentList = { source: "local-observations", coverage: "retained-incidents", databaseId: D, collectorEpoch: E, nextCursor: null,
  incidents: [{ id: A, incidentRef: `incident:${I}:${D}:${A}`, scopeId: "a".repeat(64), agentId: A, botRef: `bot:${I}:${A}`,
    rule: "ownership_conflict", status: "open", firstSeenAtMs: 90, lastSeenAtMs: 100, resolvedAtMs: null, revision: 1, acknowledged: false, snoozeUntilMs: null }],
};
const events: ObservationEventPage = { source: "local-observations", coverage: "retained-events", cursor: `${D}:${E}:2`, hasMore: false, retentionFloor: 0, gap: null,
  entries: [{ eventId: A, seq: 2, collectorEpoch: E, kind: "incident_opened", scopeId: "a".repeat(64), agentId: A, botRef: `bot:${I}:${A}`,
    incidentId: A, incidentRef: `incident:${I}:${D}:${A}`, observedAtMs: 100, previousHarness: "box", currentHarness: "temporal", observationIntervalStartMs: 90 }],
};

test("service status binds the managed component and does not invent boot or execution authority", () => {
  const status = { component: "server", state: "running", observation: { owner: "management-server", state: "not_configured", reason: "not_configured",
    desiredRevision: null, collectorEpoch: null, startedAtMs: 1, lastReceiptAtMs: null, replacements: 0, targets: 0,
    createsDatabase: false, notifiesDirectly: false, bootInstalled: false } };
  expect(managementService(status)).toBe(true);
  for (const value of [
    { ...status, component: "modeld" }, { ...status, secret: "synthetic-private-sentinel" },
    { ...status, observation: { ...status.observation, owner: "daemon" } },
    { ...status, observation: { ...status.observation, bootInstalled: true } },
    { ...status, observation: { ...status.observation, reason: "unsafe/private/path" } },
    { ...status, observation: { ...status.observation, targets: 33 } },
    { ...status, observation: { ...status.observation, source: { raw: "synthetic-private-sentinel" } } },
  ]) expect(managementService(value)).toBe(false);
});

test("snapshot transport refuses forged authority, identities, process liveness and private additions", () => {
  expect(observationSnapshot(snapshot, I)).toBe(true);
  for (const invalid of [
    { ...snapshot, admissionAuthority: true }, { ...snapshot, apiKey: "synthetic-private-sentinel" },
    { ...snapshot, storage: { ...snapshot.storage, migrationRequired: false } },
    { ...snapshot, cursor: `${A}:${E}:1` }, { ...snapshot, collector: { ...snapshot.collector, liveness: "running" } },
    { ...snapshot, agents: [...snapshot.agents, ...snapshot.agents] },
    { ...snapshot, agents: [{ ...snapshot.agents[0], botRef: `bot:${D}:${A}` }] },
    { ...snapshot, agents: [{ ...snapshot.agents[0], lastKnown: null }] },
    { ...snapshot, agents: [{ ...snapshot.agents[0], lastSuccessMs: 101 }] },
    { ...snapshot, collector: { ...snapshot.collector, recordedRunning: false } },
  ]) expect(observationSnapshot(invalid, I)).toBe(false);
});

test("incident pages keep database identity and bounded public fields, not diagnostic payloads", () => {
  expect(incidentList(incidents, I, 1)).toBe(true);
  for (const invalid of [
    { ...incidents, incidents: [incidents.incidents[0], incidents.incidents[0]] },
    { ...incidents, incidents: [{ ...incidents.incidents[0], diagnosis: { providerKey: "synthetic-private-sentinel" } }] },
    { ...incidents, incidents: [{ ...incidents.incidents[0], incidentRef: `incident:${I}:${A}:${A}` }] },
    { ...incidents, incidents: [{ ...incidents.incidents[0], status: "healthy" }] },
    { ...incidents, incidents: [{ ...incidents.incidents[0], revision: 0 }] },
    { ...incidents, nextCursor: `${A}:${E}:incidents:90:${A}` },
    { ...incidents, incidents: [], nextCursor: `${D}:${E}:incidents:90:${A}` },
  ]) expect(incidentList(invalid, I, 1)).toBe(false);
});

test("event pages preserve the requested cursor scope, order and visible retention gap", () => {
  const after = `${D}:${E}:1`;
  expect(observationEvents(events, I, 1, after)).toBe(true);
  for (const invalid of [
    { ...events, cursor: `${D}:${A}:2` }, { ...events, cursor: `${D}:${E}:3` },
    { ...events, entries: [{ ...events.entries[0], seq: 1 }] },
    { ...events, entries: [{ ...events.entries[0], incidentRef: `incident:${I}:${A}:${A}` }] },
    { ...events, entries: [{ ...events.entries[0], notification: { body: "synthetic-private-sentinel" } }] },
    { ...events, entries: [...events.entries, ...events.entries] },
    { ...events, entries: [], hasMore: true },
  ]) expect(observationEvents(invalid, I, 1, after)).toBe(false);
  const expired = { ...events, entries: [], cursor: `${D}:${E}:2`, retentionFloor: 2, gap: "history-truncated" };
  expect(observationEvents(expired, I, 1)).toBe(true);
  expect(observationEvents({ ...expired, gap: null }, I, 1)).toBe(false);
});

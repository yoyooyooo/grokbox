import { expect, test } from "bun:test";
import { SERVER_ACTIVITY_SHAPED_HOST } from "./server-activity-shaped-host.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerActivityObserver, HOST_SERVER_ACTIVITY_SYMBOL } from "../src/internal/host/server-activity-observation.ts";
import { SERVER_ACTIVITY_OBSERVATION_SLICES } from "../src/internal/host/server-activity-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { projectControlEvent } from "../src/internal/io/journal.node.ts";
import { projectServerActivitySnapshot, projectActivitySession, ACTIVITY_MAX_SESSIONS, inspectOwnership } from "@grokbox/runtime-kernel/contract";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = 1_700_000_000_000;
const live = (extra = {}) => ({ agentId, sessionId: "", isRunning: false, hasRunningSubagents: true,
  isComposingMessage: false, updatedAtMs: BigInt(base), staleAfterMs: 90_000n, ...extra });
const overlay = () => ({ live: { isRunning: true, isRunningTurn: false, runningSessionIds: [""], private: "PRIVATE" } });

test("native child-only activity and empty default session retain their source, timer and live projection independently", () => {
  let now = base;
  const events: Record<string, unknown>[] = [];
  const observer = createServerActivityObserver({ generation: "generation", instrumented: true, now: () => now, emit: e => events.push(e) });
  observer.received(live(), { ttlMs: 90000, elapsedMs: 0, remainingMs: 90000 });
  observer.armed(agentId, "", true);
  now += 91000;
  const before = observer.snapshot([agentId], overlay)!;
  expect(before.agents[0]).toMatchObject({ projection: { isRunning: true, isRunningTurn: false, runningSessionIds: [""] },
    sessions: [{ isRunning: false, hasRunningSubagents: true, sessionId: "", timer: "armed", serverUpdatedAtMs: base, serverStaleAfterMs: 90000 }] });
  // Query does not expire, stop, or relabel the native state.
  observer.settled(agentId, "");
  expect(observer.snapshot([agentId], () => ({ live: { isRunning: false } }))!.agents[0]).toMatchObject({
    projection: { isRunning: false }, sessions: [{ timer: "settled", settledAtMs: now }] });
  expect(events.map(e => e.event)).toEqual(["received", "armed", "settled"]);
  expect(JSON.stringify(before)).not.toContain("PRIVATE");
});

test("bounded witness reports eviction, does not synthesize absent session or trust a failed native query", () => {
  const observer = createServerActivityObserver({ generation: "g", instrumented: false, now: () => base });
  for (let i = 0; i < ACTIVITY_MAX_SESSIONS + 2; i++) observer.received(live({ sessionId: `session-${i}` }), {});
  const snapshot = observer.snapshot([agentId], () => { throw Error("PRIVATE"); })!;
  expect(snapshot).toMatchObject({ instrumented: false, evictedSessions: 2, agents: [{ sessionsTruncated: true, projection: { state: "unavailable" } }] });
  expect(snapshot.agents[0]!.sessions).toHaveLength(32);
  expect(observer.snapshot(Array(33).fill(agentId), overlay)).toBeUndefined();
});

test("safe projections omit private fields, accessors, invalid numeric facts and execution authority", () => {
  let touched = 0;
  const session = projectActivitySession({ ...live(), observedAtMs: base, timer: "armed", serverStaleAfterMs: NaN,
    get serverUpdatedAtMs() { touched++; throw Error("PRIVATE"); }, credential: "PRIVATE", instruction: "PRIVATE" });
  expect(touched).toBe(0);
  expect(session).toMatchObject({ sessionId: "", hasRunningSubagents: true });
  expect(session?.serverUpdatedAtMs).toBeUndefined();
  expect(session?.serverStaleAfterMs).toBeUndefined();
  expect(JSON.stringify(session)).not.toContain("PRIVATE");
  expect(projectServerActivitySnapshot({ version: 1, source: "other" })).toBeUndefined();
  expect(inspectOwnership({ agentIds: [agentId], snapshot: { activityObservation: { admitted: true } } }).agents[0]?.managedEligibility).toBe("blocked");
});

// The full-profile fixture includes this same executable interoperability seam.
const shaped = SERVER_ACTIVITY_SHAPED_HOST + "\nreturn createSyntheticServerActivity();\n";

test("applied native-shaped hooks preserve timer ownership, immediate expiry, replacement guards and original exceptions", () => {
  const applied = transformUnchecked(shaped, SERVER_ACTIVITY_OBSERVATION_SLICES);
  if (!applied.ok) throw Error(applied.code);
  const observer = createServerActivityObserver({ generation: "g", instrumented: true, now: () => base });
  const global = { [Symbol.for(HOST_SERVER_ACTIVITY_SYMBOL)]: observer };
  const owner = new Function("globalThis", applied.source)(global);
  owner.applyLive({ ...live(), ttl: 0 });
  expect(observer.snapshot([agentId], overlay)!.agents[0]?.sessions[0]?.timer).toBe("settled");
  owner.applyLive({ ...live(), ttl: 90000 });
  owner.applyLive({ ...live(), ttl: 90000 });
  owner.timers[0]();
  expect(observer.snapshot([agentId], overlay)!.agents[0]?.sessions[0]?.timer).toBe("armed");
  owner.timers[1]();
  expect(observer.snapshot([agentId], overlay)!.agents[0]?.sessions[0]?.timer).toBe("settled");
  expect(() => owner.applyLive({ ...live(), ttl: 123 })).toThrow("native-failure");
  expect(observer.snapshot([agentId], overlay)!.agents[0]?.sessions[0]?.timer).toBe("failed");
  const badObserver = { received() { throw Error("observer-failure"); }, armed() { throw Error("observer-failure"); } };
  const unaffected = new Function("globalThis", applied.source)({ [Symbol.for(HOST_SERVER_ACTIVITY_SYMBOL)]: badObserver });
  expect(unaffected.applyLive({ ...live(), ttl: 90000 }).live.isRunning).toBe(true);
});

test("the same safe activity event survives actual journal write and read projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "activity-observation-"));
  let recorded: Record<string, unknown> | undefined;
  const observer = createServerActivityObserver({ generation: "g", instrumented: true, now: () => base, emit: e => { recorded = e; } });
  observer.received(live(), { ttlMs: 90000 });
  try {
    expect(await appendHostJournal(root, { ...recorded, secret: "PRIVATE" })).toBe("written");
    const bytes = await readFile(join(root, "log/events.ndjson"), "utf8");
    expect(bytes).not.toContain("PRIVATE");
    expect(projectControlEvent(JSON.parse(bytes.trim()))).toMatchObject({ name: "host_server_activity_observation", event: "received",
      session: { hasRunningSubagents: true, isRunning: false, sessionId: "" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

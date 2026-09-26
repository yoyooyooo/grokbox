import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createNoticeReplayFence, projectNoticeWorker } from "../src/observation.ts";

test("durable replay snapshot admits unsent work after its floor, retains unknown and exact rejected retry identity", () => {
  const original = createNoticeReplayFence(1000, 4);
  const input = { workId: randomUUID(), occurrenceIdentity: "a".repeat(64), attemptId: randomUUID(),
    createdAtMs: 1100, occurrenceAtMs: 1100, expiresAtMs: 10000, nowMs: 1200 };
  expect(original.claim(input)).toBeNull();
  const restarted = createNoticeReplayFence(2000, 4, original.snapshot());
  expect(restarted.claim({ ...input, nowMs: 2000 })).toBe("prior_lifetime_attempt");
  expect(restarted.claim({ ...input, occurrenceIdentity: "b".repeat(64), workId: randomUUID(), nowMs: 2000 })).toBeNull();
  expect(restarted.definitelyRejected({ ...input, nowMs: 2000 })).toBeTrue();
  const again = createNoticeReplayFence(2100, 4, restarted.snapshot());
  expect(again.claim({ ...input, attemptId: randomUUID(), retryOf: input.attemptId, nowMs: 2100 })).toBeNull();
  expect(again.check(2000)).toBe("replay_clock_reversed");
  const worker = { state: "waiting", cycles: 1, lastCycleAtMs: 2100, lastCycle: null, nextDelayMs: 5000,
    owner: "management-server", automaticDiagnosis: false, automaticIssue: false, pollingCallsModels: false,
    serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed", replayFence: again.status() };
  expect(projectNoticeWorker(worker).replayFence).toMatchObject({ policy: "binding-durable-attempts-v1", restoresExistingWork: true });
  expect(() => projectNoticeWorker({ ...worker, replayFence: { ...again.status(), restoresExistingWork: false } })).toThrow();
});

test("corrupt and over-capacity durable replay snapshots cannot become an empty fence", () => {
  const base = createNoticeReplayFence(1000, 1).snapshot();
  expect(() => createNoticeReplayFence(2000, 1, { ...base, highWaterMs: 999 })).toThrow();
  const entry = { occurrenceIdentity: "a".repeat(64), workId: randomUUID(), attemptId: randomUUID(), rejected: false, expiresAtMs: 3000 };
  expect(() => createNoticeReplayFence(2000, 1, { ...base, entries: [entry, entry] })).toThrow();
});

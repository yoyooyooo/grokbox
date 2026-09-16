import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunObserver, projectRunObservation, type RunObservation } from "../src/internal/host/run-observation.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";

function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

test("a busy private task queues a group task; buffered replies do not claim publication", async () => {
  let time = 0;
  const events: RunObservation[] = [];
  const observer = createRunObserver({ generation: "fixture-host", now: () => time, emit: e => events.push(e) });
  const privateDone = barrier(), entered = barrier(), groupDone = barrier(), buffered = barrier();
  const privateTask = observer.queue("member", async () => { entered.release(); await privateDone.promise; }, { source: "turn" });
  const working = privateTask.task(); await entered.promise;
  let tail: Promise<unknown> = Promise.resolve(working);
  const owner = { async runLocalRoomMemberTurn(args: object): Promise<unknown> {
    const intercepted = observer.group(owner, args); if (intercepted) return intercepted;
    const item = observer.queue("member", async () => {
      observer.buffered(); buffered.release(); await groupDone.promise;
      return "same-native-result";
    }, { source: "group-member" });
    tail = tail.then(() => item.task());
    return await tail;
  } };
  time = 100;
  const group = owner.runLocalRoomMemberTurn({ room: { id: "group" }, member: { id: "member" }, prompt: "PRIVATE_SENTINEL" });
  expect(events.filter(e => e.state === "started")).toHaveLength(1);
  const queued = events.find(e => e.source === "group-member" && e.state === "queued")!;
  expect(queued.blockingDispatchId).toBe(events[0]!.dispatchId);
  expect(queued.groupId).toBe("group");
  time = 50_000; privateDone.release(); await buffered.promise;
  expect(events.find(e => e.source === "group-member" && e.state === "started")?.waitMs).toBe(49_900);
  expect(events.some(e => e.state === "reply_buffered")).toBe(true);
  expect(events.some(e => e.state === "member_returned")).toBe(false);
  groupDone.release(); expect(await group).toBe("same-native-result");
  expect(events.at(-1)).toMatchObject({ state: "member_returned", bufferedReplies: 1 });
  expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(events)).not.toContain("published");
});

test("queue cancellation invokes the original callback once and does not start work", () => {
  const events: RunObservation[] = []; let cancelled = 0, started = 0;
  const observer = createRunObserver({ generation: "h", emit: e => events.push(e) });
  const queued = observer.queue("member", () => { started++; }, { source: "group-member", onCancelled: () => { cancelled++; return 7; } });
  expect((queued.options as { onCancelled: () => number }).onCancelled()).toBe(7);
  expect(cancelled).toBe(1); expect(started).toBe(0);
  expect(events.map(e => e.state)).toEqual(["queued", "cancelled"]);
});

test("observation writer errors never replace original task results or failures", async () => {
  const observer = createRunObserver({ generation: "h", emit: () => { throw new Error("observer-only"); } });
  const pass = observer.queue("member", () => 42, {});
  expect(await pass.task()).toBe(42);
  const original = new Error("native-task");
  const fail = observer.queue("member", () => { throw original; }, {});
  await expect(fail.task()).rejects.toBe(original);
});

test("group scheduling records survive writer/projector/reader without private fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-observation-"));
  try {
    const event = { name: "host_run_observation", at: "2026-01-01T00:00:00.000Z", hostGenerationId: "h", agentId: "member", dispatchId: "dispatch",
      groupId: "group", groupDispatchId: "group-run", source: "group-member", state: "queued", blockingDispatchId: "private-run", prompt: "SENTINEL", args: { password: "SECRET" } };
    expect(await appendHostJournal(root, event)).toBe("written");
    expect((await observeEvents(root)).events as unknown[]).toEqual([projectRunObservation(event)]);
    expect(JSON.stringify(await observeEvents(root))).not.toMatch(/SENTINEL|SECRET|password/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

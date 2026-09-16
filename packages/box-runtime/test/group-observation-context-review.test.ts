import { expect, test } from "bun:test";
import { createRunObserver, type RunObservation } from "../src/internal/host/run-observation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("a queued group task keeps group identity when the scheduler invokes it outside the enqueue context", async () => {
  const events: RunObservation[] = [];
  const observer = createRunObserver({ generation: "test-generation", emit: event => events.push(event) });
  const gate = deferred<void>();
  let queued: (() => unknown) | undefined;
  let seen: ReturnType<typeof observer.current>;
  const owner = { runLocalRoomMemberTurn(args: object): Promise<unknown> {
    const instrumented = observer.group(owner, args);
    if (instrumented) return instrumented;
    queued = observer.queue("member-a", async () => {
      seen = observer.current();
      observer.buffered();
    }, { source: "group-member" }).task;
    return gate.promise;
  } };
  const pending = owner.runLocalRoomMemberTurn({ room: { id: "group-a" }, member: { id: "member-a" } });
  expect(observer.current()).toBeUndefined();
  expect(queued).toBeDefined();
  await queued!();
  gate.resolve(); await pending;
  expect(seen).toMatchObject({ agentId: "member-a", groupId: "group-a" });
  expect(events.filter(event => event.state === "reply_buffered")).toHaveLength(1);
  expect(events.find(event => event.state === "member_returned")?.bufferedReplies).toBe(1);
});

test("a private task does not inherit the group that happens to wake the scheduler", async () => {
  const events: RunObservation[] = [];
  const observer = createRunObserver({ generation: "test-generation", emit: event => events.push(event) });
  let seen: ReturnType<typeof observer.current>;
  const privateTask = observer.queue("member-a", async () => {
    seen = observer.current();
    observer.buffered();
  }, { source: "turn" }).task;
  const owner = { runLocalRoomMemberTurn(args: object): Promise<unknown> {
    const instrumented = observer.group(owner, args);
    if (instrumented) return instrumented;
    return Promise.resolve(privateTask());
  } };
  await owner.runLocalRoomMemberTurn({ room: { id: "unrelated-group" }, member: { id: "member-a" } });
  expect(seen).toMatchObject({ agentId: "member-a", source: "turn" });
  expect(seen?.groupId).toBeUndefined();
  expect(events.filter(event => event.state === "reply_buffered")).toHaveLength(0);
});

test("task rejection is unchanged and no exception message enters observation events", async () => {
  const events: RunObservation[] = [];
  const observer = createRunObserver({ generation: "test-generation", emit: event => events.push(event) });
  const error = new Error("PRIVATE_SENTINEL_NEVER_LOG");
  const wrapped = observer.queue("member-a", async () => { throw error; }, { source: "turn" });
  await expect(wrapped.task()).rejects.toBe(error);
  expect(events.map(event => event.state)).toEqual(["queued", "started", "failed"]);
  expect(JSON.stringify(events)).not.toContain(error.message);
  expect(observer.current()).toBeUndefined();
});

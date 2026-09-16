import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const HOST_RUN_OBSERVATION_SYMBOL = "grokbox.host.run-observation.v1";
const STATES = ["queued", "started", "finished", "failed", "cancelled", "reply_buffered", "member_returned"] as const;
const SOURCES = ["group-member", "turn", "agent", "automation", "handoff-resume", "background", "unknown"] as const;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
export type RunObservation = {
  name: "host_run_observation"; at: string; hostGenerationId: string;
  agentId: string; dispatchId: string; state: typeof STATES[number]; source: typeof SOURCES[number];
  groupId?: string; groupDispatchId?: string; blockingDispatchId?: string;
  waitMs?: number; elapsedMs?: number; bufferedReplies?: number;
};
export function projectRunObservation(v: unknown): RunObservation | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (x.name !== "host_run_observation" || typeof x.at !== "string" || !Number.isFinite(Date.parse(x.at))
    || !id(x.agentId) || !id(x.dispatchId) || !id(x.hostGenerationId)
    || !STATES.includes(x.state as never) || !SOURCES.includes(x.source as never)) return null;
  const out: Record<string, unknown> = { name: x.name, at: x.at, hostGenerationId: x.hostGenerationId,
    agentId: x.agentId, dispatchId: x.dispatchId, state: x.state, source: x.source };
  for (const k of ["groupId", "groupDispatchId", "blockingDispatchId"]) if (id(x[k])) out[k] = x[k];
  for (const k of ["waitMs", "elapsedMs", "bufferedReplies"]) {
    const n = x[k]; if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out[k] = n;
  }
  return out as RunObservation;
}

type GroupContext = { owner: object; args: object; groupId: string; memberId: string; groupDispatchId: string; replies: number };
type TaskContext = { agentId: string; dispatchId: string; source: typeof SOURCES[number] };
/** Instrument the native scheduler, do not replace it. Queue priority, cancellation,
 * member order and delivery semantics remain owned by the original Host. */
export function createRunObserver(input: { generation: string; emit: (event: RunObservation) => void; now?: () => number }) {
  const groups = new AsyncLocalStorage<GroupContext | undefined>();
  const tasks = new AsyncLocalStorage<TaskContext>();
  const active = new Map<string, TaskContext>();
  const now = input.now ?? Date.now;
  const emit = (v: Omit<RunObservation, "name" | "at" | "hostGenerationId">) => {
    try { input.emit({ ...v, name: "host_run_observation", at: new Date(now()).toISOString(), hostGenerationId: input.generation }); } catch { /* observation is never execution authority */ }
  };
  const groupFields = (g?: GroupContext) => g ? { groupId: g.groupId, groupDispatchId: g.groupDispatchId } : {};
  return {
    group(owner: { runLocalRoomMemberTurn: (args: object) => Promise<unknown> }, args: unknown): Promise<unknown> | undefined {
      if (!args || typeof args !== "object") return undefined;
      const previous = groups.getStore();
      if (previous?.owner === owner && previous.args === args) return undefined;
      const x = args as { room?: { id?: unknown }; member?: { id?: unknown } };
      if (!id(x.room?.id) || !id(x.member?.id)) return undefined;
      const group: GroupContext = { owner, args, groupId: x.room.id, memberId: x.member.id, groupDispatchId: randomUUID(), replies: 0 };
      return groups.run(group, async () => {
        try { return await owner.runLocalRoomMemberTurn(args); }
        finally { emit({ agentId: group.memberId, dispatchId: group.groupDispatchId, state: "member_returned", source: "group-member", ...groupFields(group), bufferedReplies: group.replies }); }
      });
    },
    queue(agentId: unknown, task: () => unknown, options: unknown) {
      if (!id(agentId) || typeof task !== "function") return { task, options };
      const raw = options && typeof options === "object" ? options as Record<string, unknown> : {};
      const source = SOURCES.includes(raw.source as never) ? raw.source as typeof SOURCES[number] : "unknown";
      const group = groups.getStore(), context: TaskContext = { agentId, source, dispatchId: randomUUID() };
      const queuedAt = now(), blocker = active.get(agentId);
      const base = { ...context, ...groupFields(group) };
      emit({ ...base, state: "queued", ...(blocker ? { blockingDispatchId: blocker.dispatchId } : {}) });
      let started = false;
      // The native queue may invoke this closure from a different async chain.
      // Bind the context captured at enqueue, including an explicit absence of
      // a group, rather than borrowing whichever task woke the scheduler.
      const wrapped = () => groups.run(group, () => tasks.run(context, async () => {
        started = true; active.set(agentId, context);
        const begun = now();
        emit({ ...base, state: "started", waitMs: Math.max(0, begun - queuedAt) });
        try { const result = await task(); emit({ ...base, state: "finished", elapsedMs: Math.max(0, now() - begun) }); return result; }
        catch (error) { emit({ ...base, state: "failed", elapsedMs: Math.max(0, now() - begun) }); throw error; }
        finally { if (active.get(agentId) === context) active.delete(agentId); }
      }));
      const onCancelled = raw.onCancelled;
      return { task: wrapped, options: { ...raw, onCancelled: (...args: unknown[]) => {
        if (!started) emit({ ...base, state: "cancelled", waitMs: Math.max(0, now() - queuedAt) });
        return typeof onCancelled === "function" ? onCancelled(...args) : undefined;
      } } };
    },
    buffered() {
      const group = groups.getStore(), task = tasks.getStore();
      if (!group) return;
      group.replies++;
      emit({ agentId: group.memberId, dispatchId: task?.dispatchId ?? group.groupDispatchId,
        state: "reply_buffered", source: "group-member", ...groupFields(group), bufferedReplies: group.replies });
    },
    current() { const task = tasks.getStore(), group = groups.getStore(); return task ? { ...task, ...groupFields(group) } : undefined; },
  };
}

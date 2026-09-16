import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { classifyAlert, observationId, own, projectAlertEvent, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";
import { readFailureLink, type FailureLink } from "./alert-provenance.ts";

export const HOST_ALERT_OBSERVATION_SYMBOL = "grokbox.host.alert-observation.v1";
type Context = { decisionId: string; link?: FailureLink; agentId?: string; clientNonce?: string };
type Fact = Omit<AlertObservationEvent, "name" | "schemaVersion" | "eventId" | "sourceInstanceId" | "sourceSequence" | "hostGenerationId" | "at" | "observedAt">;
type SafeTray = Pick<AlertObservationEvent, "trayId" | "agentId" | "nativeRequestId" | "count" | "classification" | "classificationEvidence" | "stepId" | "stepEvidence" | "failureId" | "decisionId" | "clientNonce" | "failureCategory" | "httpStatus" | "presentationVersion">;
type State = { revisions: Map<string, number>; live: Map<string, SafeTray> };

/** Observe the native manager; do not become a second manager. Metadata follows
 * the native live set and is removed with it. Publication references are local
 * to one invocation: a failed emit cannot be acknowledged by a later emit. */
export function createAlertObserver(input: {
  generation: string;
  emit: (event: AlertObservationEvent) => void;
  now?: () => number;
  sourceInstanceId?: string;
  nativeSourceSha256?: string;
  preloadSha256?: string;
  capture?: AlertObservationEvent["capture"];
  observerRole?: AlertObservationEvent["observerRole"];
}) {
  const sourceInstanceId = input.sourceInstanceId ?? randomUUID(), now = input.now ?? Date.now;
  let sourceSequence = 0, closed = false;
  const contexts = new AsyncLocalStorage<Context>();
  const removals = new AsyncLocalStorage<AlertObservationEvent["removalReason"]>();
  const managers = new WeakMap<object, State>(), installed = new WeakSet<object>();
  const state = (manager: object) => {
    let value = managers.get(manager);
    if (!value) { value = { revisions: new Map(), live: new Map() }; managers.set(manager, value); }
    return value;
  };
  const emit = (fact: Fact): AlertObservationEvent | undefined => {
    if (closed) return;
    try {
      const at = new Date(now()).toISOString();
      const event = projectAlertEvent({ ...fact, name: "host_alert_observation", schemaVersion: 1,
        eventId: randomUUID(), sourceInstanceId, sourceSequence: sourceSequence++, hostGenerationId: input.generation,
        nativeSourceSha256: input.nativeSourceSha256, preloadSha256: input.preloadSha256, capture: input.capture, observerRole: input.observerRole, at, observedAt: at });
      if (event) { input.emit(event); return event; }
    } catch { /* Writer health/sequence gaps expose loss, never alter native execution. */ }
  };
  const safeTray = (raw: unknown): SafeTray | undefined => {
    const trayId = own(raw, "id");
    if (!observationId(trayId) || own(raw, "kind") !== "error") return;
    const agentId = own(raw, "agentId"), nativeRequestId = own(raw, "requestId"), count = own(raw, "count");
    const classification = classifyAlert(raw), inherited = contexts.getStore();
    // A callback running inside another Agent's context is not a causal link.
    const context = inherited?.agentId !== undefined && inherited.agentId === agentId ? inherited : undefined;
    const link = context && context.link?.agentId === agentId ? context.link : undefined;
    return { trayId, ...(observationId(agentId) ? { agentId } : {}), ...(observationId(nativeRequestId) ? { nativeRequestId } : {}),
      ...(Number.isSafeInteger(count) && Number(count) >= 0 ? { count: Number(count) } : {}),
      ...(link?.code ? { classification: link.code, classificationEvidence: "direct" as const }
        : { ...(classification.code ? { classification: classification.code } : {}), classificationEvidence: classification.evidence }),
      ...(link?.stepId ? { stepId: link.stepId, stepEvidence: "direct" as const }
        : classification.stepId ? { stepId: classification.stepId, stepEvidence: classification.stepEvidence } : {}),
      ...(link ? { failureId: link.failureId } : {}),
      ...(link?.summary ? { failureCategory: link.summary.category, ...(link.summary.http ? { httpStatus: link.summary.http.status } : {}), presentationVersion: "failure-facts-v1" as const } : {}),
      ...(context ? { decisionId: context.decisionId, ...(context.clientNonce ? { clientNonce: context.clientNonce } : {}) } : {}) };
  };
  const published = (references: readonly AlertObservationEvent[]) => {
    for (const event of references) emit({ kind: "channel_published", relatedEventId: event.eventId, publicationBoundary: "native_emitter_returned",
      ...(event.trayId ? { trayId: event.trayId } : {}), ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.decisionId ? { decisionId: event.decisionId } : {}), ...(event.failureId ? { failureId: event.failureId } : {}),
      ...(event.stepId ? { stepId: event.stepId, stepEvidence: event.stepEvidence } : {}) });
  };
  emit({ kind: "observer_started" });

  const api = {
    /** Wrappers preserve receiver, return value/Promise identity and thrown error.
     * Native listeners still own publication; this is not an App receipt. */
    attachManager(manager: object): (() => void) | undefined {
      if (closed || installed.has(manager)) return;
      const native = manager as { getTrays: () => unknown; emit: (event: unknown) => unknown; [key: string]: unknown };
      if (typeof native.getTrays !== "function" || typeof native.emit !== "function") return;
      const restores: Array<() => void> = [];
      const wrap = (key: string, around: (original: Function, receiver: unknown, args: unknown[]) => unknown) => {
        const original = native[key];
        if (typeof original !== "function") return;
        const descriptor = Object.getOwnPropertyDescriptor(manager, key);
        const replacement = function(this: unknown, ...args: unknown[]) {
          return closed || this !== manager ? Reflect.apply(original, this, args) : around(original, this, args);
        };
        Object.defineProperty(manager, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: replacement });
        restores.push(() => {
          if (native[key] !== replacement) return;
          if (descriptor) Object.defineProperty(manager, key, descriptor); else delete native[key];
        });
      };
      try {
        api.attach(manager, Reflect.apply(native.getTrays, manager, []));
        for (const [method, reason] of [["dismiss", "explicit_dismiss"], ["clearAll", "clear_all"], ["clearForAgent", "agent_clear"], ["enforceCap", "evicted"]] as const) {
          wrap(method, (original, receiver, args) => removals.run(removals.getStore() ?? reason, () => Reflect.apply(original, receiver, args)));
        }
        wrap("emit", (original, receiver, args) => {
          const event = args[0], references: AlertObservationEvent[] = [];
          try {
            const type = own(event, "type");
            if (type === "pushed") {
              const raw = own(event, "tray"), id = own(raw, "id");
              const recorded = api.mutated(manager, observationId(id) && state(manager).live.has(id) ? "tray_updated" : "tray_created", raw);
              if (recorded) references.push(recorded);
            } else if (type === "dismissed") {
              const recorded = api.removed(manager, own(event, "id"), removals.getStore() ?? "unknown");
              if (recorded) references.push(recorded);
            } else if (type === "cleared") {
              for (const id of [...state(manager).live.keys()]) {
                const recorded = api.removed(manager, id, removals.getStore() ?? "unknown");
                if (recorded) references.push(recorded);
              }
            }
          } catch { /* Observation is not native control flow. */ }
          const result = Reflect.apply(original, receiver, args);
          // Current qualified Host emit is synchronous. This branch additionally
          // preserves Promise identity should an explicitly tested emitter use it.
          if (result instanceof Promise) {
            void result.then(() => published(references), () => undefined).catch(() => undefined);
          } else published(references);
          return result;
        });
        installed.add(manager);
        emit({ kind: "manager_attached" });
      } catch {
        for (const restore of restores.reverse()) { try { restore(); } catch { /* no escalation */ } }
        return;
      }
      return () => { for (const restore of restores.reverse()) restore(); installed.delete(manager); managers.delete(manager); };
    },
    /** Evaluate the native decision/task once. The error link is only accepted
     * from a locally registered error for this exact Agent. */
    decision<T>(error: unknown, facts: { agentId?: unknown; clientNonce?: unknown }, shouldEmit: boolean, task: () => T): T {
      let context: Context;
      try {
        const agentId = observationId(facts.agentId) ? facts.agentId : undefined;
        const candidate = readFailureLink(error), link = agentId && candidate?.agentId === agentId ? candidate : undefined;
        context = { decisionId: randomUUID(), ...(link ? { link } : {}), ...(agentId ? { agentId } : {}),
          ...(observationId(facts.clientNonce) ? { clientNonce: facts.clientNonce } : {}) };
        emit({ kind: "decision", decisionId: context.decisionId, decision: shouldEmit ? "emit" : "suppress",
          reason: shouldEmit ? "native_error" : "stale_run", ruleVersion: "native-host-v1", decisionBasis: "native_branch",
          ...(context.agentId ? { agentId: context.agentId } : {}), ...(context.clientNonce ? { clientNonce: context.clientNonce } : {}),
          ...(link?.summary ? { failureCategory: link.summary.category, ...(link.summary.http ? { httpStatus: link.summary.http.status } : {}), presentationVersion: "failure-facts-v1" as const } : {}),
          ...(link ? { failureId: link.failureId, ...(link.stepId ? { stepId: link.stepId, stepEvidence: "direct" as const } : {}),
            ...(link.code ? { classification: link.code, classificationEvidence: "direct" as const } : {}) } : {}) });
      } catch { return task(); }
      return contexts.run(context, task);
    },
    suppressed(agentId: unknown, reason: "background_automation" | "native_rate_limit") {
      emit({ kind: "decision", decisionId: randomUUID(), decision: "suppress", reason, ruleVersion: "native-host-v1", decisionBasis: "native_branch",
        ...(observationId(agentId) ? { agentId } : {}) });
    },
    removalReason() { return removals.getStore(); },
    withRemovalReason<T>(reason: NonNullable<AlertObservationEvent["removalReason"]>, task: () => T): T { return removals.run(reason, task); },
    attach(manager: object, trays: unknown) {
      if (closed || !Array.isArray(trays)) return;
      for (const raw of trays) {
        const safe = safeTray(raw);
        if (!safe?.trayId) continue;
        const value = state(manager); value.live.set(safe.trayId, safe); value.revisions.set(safe.trayId, 0);
        emit({ kind: "tray_snapshot", ...safe, trayRevision: 0 });
      }
    },
    mutated(manager: object, kind: "tray_created" | "tray_updated", raw: unknown): AlertObservationEvent | undefined {
      if (closed) return;
      try {
        const safe = safeTray(raw);
        if (!safe?.trayId) return;
        const value = state(manager), revision = (value.revisions.get(safe.trayId) ?? 0) + 1;
        value.revisions.set(safe.trayId, revision); value.live.set(safe.trayId, safe);
        if (!safe.decisionId) {
          safe.decisionId = randomUUID();
          emit({ kind: "decision", decisionId: safe.decisionId, decision: kind === "tray_created" ? "emit" : "merge",
            reason: kind === "tray_created" ? "native_error" : "native_dedupe", ruleVersion: "native-host-v1", decisionBasis: "mutation_observed", ...safe });
        }
        return emit({ kind, ...safe, trayRevision: revision });
      } catch { return; }
    },
    removed(manager: object, raw: unknown, reason: NonNullable<AlertObservationEvent["removalReason"]>): AlertObservationEvent | undefined {
      if (closed) return;
      try {
        const value = state(manager), id = typeof raw === "string" ? raw : own(raw, "id");
        if (!observationId(id)) return;
        const safe = value.live.get(id) ?? safeTray(raw) ?? { trayId: id };
        const revision = (value.revisions.get(id) ?? 0) + 1;
        value.live.delete(id); value.revisions.delete(id);
        return emit({ kind: "tray_removed", ...safe, trayRevision: revision, removalReason: removals.getStore() ?? reason, actor: "unknown" });
      } catch { return; }
    },
    close() { closed = true; contexts.disable(); removals.disable(); },
  };
  return api;
}

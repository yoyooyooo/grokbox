import { expect, test } from "bun:test";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { hostVisibleStreamError } from "../src/internal/host/session.ts";
import { classifyAlert, sameExecution, traceAlerts, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";
import { projectAlert } from "../../cli/src/outcome.ts";

class TrayFixture {
  trays: Record<string, unknown>[] = [];
  rejectPublication = false;
  getTrays() { return this.trays; }
  emit(_event: unknown): unknown { if (this.rejectPublication) throw new Error("native publish failure"); return undefined; }
  push(id: string, agentId = "agent-a") {
    const tray = { id, agentId, kind: "error" };
    this.trays = this.trays.filter(t => t.id !== id).concat(tray);
    this.emit({ type: "pushed", tray });
    return tray;
  }
  dismiss(id: string) {
    if (!this.trays.some(t => t.id === id)) return false;
    this.trays = this.trays.filter(t => t.id !== id);
    this.emit({ type: "dismissed", id });
    return true;
  }
}
function fixture(native = new TrayFixture()) {
  const events: AlertObservationEvent[] = [];
  const observer = createAlertObserver({ generation: "host-a", emit: e => events.push(e) });
  observer.attachManager(native);
  return { native, events, observer };
}

test("a later successful publication never acknowledges a prior failed emit", () => {
  const f = fixture();
  f.native.rejectPublication = true;
  expect(() => f.native.push("same")).toThrow("native publish failure");
  const first = f.events.find(e => e.kind === "tray_created")!;
  f.native.rejectPublication = false;
  f.native.push("same");
  const second = f.events.find(e => e.kind === "tray_updated")!;
  const published = f.events.filter(e => e.kind === "channel_published");
  expect(published.map(e => e.relatedEventId)).toEqual([second.eventId]);
  expect(published.some(e => e.relatedEventId === first.eventId)).toBe(false);
});

test("a borrowed native emit keeps its receiver and cannot mutate the installed manager's trace", () => {
  const f = fixture(), other = new TrayFixture();
  const before = f.events.length;
  Reflect.apply(f.native.emit, other, [{ type: "pushed", tray: { id: "foreign", kind: "error" } }]);
  expect(f.events).toHaveLength(before);
});

test("async native emission preserves the same Promise and records only observed fulfilment", async () => {
  class AsyncTray extends TrayFixture {
    pending!: Promise<void>;
    emit(_event: unknown) { return this.pending; }
  }
  const native = new AsyncTray(), f = fixture(native);
  let resolve!: () => void, reject!: (error: Error) => void;
  native.pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const same = native.emit({ type: "pushed", tray: { id: "a", kind: "error" } });
  expect(same).toBe(native.pending);
  expect(f.events.some(e => e.kind === "channel_published")).toBe(false);
  reject(new Error("private publisher failure"));
  await same.catch(() => undefined);
  await Promise.resolve();
  expect(f.events.some(e => e.kind === "channel_published")).toBe(false);
  native.pending = new Promise<void>(yes => { resolve = yes; });
  const successful = native.emit({ type: "pushed", tray: { id: "b", kind: "error" } });
  resolve(); await successful; await Promise.resolve();
  expect(f.events.filter(e => e.kind === "channel_published").map(e => e.trayId)).toEqual(["b"]);
});

test("another agent cannot acquire the originating failure link from AsyncLocalStorage", () => {
  const f = fixture();
  const error = hostVisibleStreamError({ userVisible: true, code: "invalid_stream", message: "synthetic", failureId: "failure-a", agentId: "agent-a", invocationId: "step-a" });
  f.observer.decision(error, { agentId: "agent-b" }, true, () => f.native.push("tray-b", "agent-b"));
  const report = traceAlerts(f.events, { agentId: "agent-b" });
  expect(report.traces.flatMap(t => t.events).some(e => e.failureId === "failure-a" || e.stepId === "step-a")).toBe(false);
});

test("legacy evidence stays legacy after multiple safe projections", () => {
  const raw = { id: "tray", kind: "error", agentId: "a", detail: "Parallel tool calls are not supported. Rejected calls were not executed. (invocationId=legacy-step)" };
  const once = projectAlert(raw)!;
  expect(once.classificationEvidence).toBe("legacy_text_derived");
  expect(once.stepEvidence).toBe("legacy_text_derived");
  expect(projectAlert(once)).toEqual(once);
  expect(classifyAlert(once)).toMatchObject({ evidence: "legacy_text_derived", stepEvidence: "legacy_text_derived" });
});

test("a supplied generation cannot join a terminal that omitted that generation", () => {
  expect(sameExecution({ agentId: "a", turnId: "t", stepId: "s", hostGenerationId: "h" }, { agentId: "a", turnId: "t", stepId: "s" })).toBe(false);
});

test("conflicting copies of the same source event are reported, never chosen by arrival order", () => {
  const f = fixture(); f.native.push("a");
  const created = f.events.find(e => e.kind === "tray_created")!;
  const changed = { ...created, kind: "tray_removed" as const, removalReason: "explicit_dismiss" as const };
  const first = traceAlerts([...f.events, changed], { trayId: "a" });
  const second = traceAlerts([changed, ...f.events], { trayId: "a" });
  expect(first.traces[0].integrity).toBe("conflict");
  expect(second.evidence).toEqual(first.evidence);
  expect(first.traces[0]?.trays[0]?.hostState).toBe("unknown_integrity");
  expect(second.traces[0]?.trays[0]?.hostState).toBe("unknown_integrity");
});

test("observing an already present tray does not manufacture a creation or channel publication", () => {
  const native = new TrayFixture(); native.trays = [{ id: "present", kind: "error" }];
  const f = fixture(native);
  expect(f.events.filter(e => e.trayId === "present").map(e => e.kind)).toEqual(["tray_snapshot"]);
  expect(traceAlerts(f.events, { trayId: "present" }).traces[0].trays[0]).toMatchObject({ published: false, appRendered: "not_observed", userRead: "not_proven" });
});

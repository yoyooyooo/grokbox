import type { ServerResponse } from "node:http";
import { Effect } from "effect";
import { RESPONSE_MAX_BYTES, type ObservationEventPage, type ObservationWatchFrame } from "@grokbox/client/contract";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { observationQuery, type ManagementObservations } from "./observations.ts";
import { pageInput } from "./pagination.ts";

export const WATCH_LIMITS = Object.freeze({ subscriptions: 8, durationMs: 30_000, maxDurationMs: 60_000,
  intervalMs: 1000, maxPages: 128, maxBytes: 4 * 1024 * 1024, drainMs: 5000 });
/** Concurrent readers at the same cursor share only an in-flight disk read.
 * No new history/cache, collector, timer, authorization result or native query. */
export function shareObservationReads(source: ManagementObservations | undefined): ManagementObservations | undefined {
  if (!source) return undefined;
  const pending = new Map<string, ReturnType<ManagementObservations["events"]>>();
  return { ...source, events: (after, limit) => {
    const key = `${after ?? ""}/${limit ?? 100}`;
    const existing = pending.get(key); if (existing) return existing;
    if (pending.size >= WATCH_LIMITS.subscriptions) return Promise.reject(new HttpFailure(503, "unavailable", "The observation reader is at capacity."));
    const task = source.events(after, limit); pending.set(key, task);
    void task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => undefined);
    return task;
  } };
}
/** Node's write(false) is backpressure, not a successful remote delivery. Wait
 * for drain or cancellation before another page; never buffer a second queue. */
export function writeWatchChunk(response: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off("drain", ready); response.off("close", closed); response.off("error", closed); signal.removeEventListener("abort", closed); };
    const ready = () => { cleanup(); resolve(); };
    const closed = () => {
      cleanup();
      // An interrupted drain cannot be followed by another buffered error frame.
      // Tear down only this owned subscription socket, not the collector.
      if (signal.aborted && !response.destroyed) response.destroy();
      reject(new HttpFailure(503, "unavailable", "The event subscriber disconnected."));
    };
    if (signal.aborted || response.destroyed || response.writableEnded) return closed();
    response.once("drain", ready); response.once("close", closed); response.once("error", closed); signal.addEventListener("abort", closed, { once: true });
    try { if (response.write(chunk)) ready(); } catch { closed(); }
  });
}

export function watchObservationEvents(input: {
  installationId: string; source: ManagementObservations | undefined; principal: Principal; url: URL;
  authorize: () => Effect.Effect<Principal, unknown>;
  emit: (frame: ObservationWatchFrame, signal: AbortSignal) => Promise<void>;
  disconnected: AbortSignal;
}) {
  const program = Effect.gen(function* () {
    const settings = yield* Effect.try({ try: () => {
      requireCapability(input.principal, "observations.read");
      const query = new URL(input.url); query.pathname = "/v1/observation-events";
      const values = query.searchParams.getAll("durationMs");
      if (values.length > 1 || values[0] !== undefined && !/^[1-9][0-9]{0,5}$/.test(values[0])) throw new HttpFailure(400, "invalid_input", "Invalid event watch duration.");
      const durationMs = values[0] === undefined ? WATCH_LIMITS.durationMs : Number(values[0]); query.searchParams.delete("durationMs");
      const page = pageInput(query);
      if (durationMs > WATCH_LIMITS.maxDurationMs || !page.cursor || page.cursor.length > 128) throw new HttpFailure(400, "invalid_input", "Event watching requires a snapshot cursor and a duration of at most 60 seconds.");
      return { query, durationMs };
    }, catch: error => error });
    let cursor = settings.query.searchParams.get("cursor")!, bytes = 0, pages = 0;
    const deadline = Date.now() + settings.durationMs;
    const emit = (frame: ObservationWatchFrame) => Effect.tryPromise({ try: signal => input.emit(frame, signal), catch: error => error })
      .pipe(Effect.timeout(`${WATCH_LIMITS.drainMs} millis`));
    while (true) {
      const principal = yield* input.authorize();
      yield* Effect.try({ try: () => {
        if (principal.id !== input.principal.id) throw new HttpFailure(401, "authentication_required", "The event subscriber identity changed.");
        requireCapability(principal, "observations.read");
      }, catch: error => error });
      settings.query.searchParams.set("cursor", cursor);
      const page = (yield* observationQuery(input.installationId, input.source, principal, settings.query).pipe(Effect.timeout("10 seconds"),
        Effect.mapError(error => error instanceof HttpFailure ? error : new HttpFailure(504, "source_timeout", "The observation read exceeded its deadline.")))) as ObservationEventPage;
      // Recheck after an asynchronous disk read, before disclosing another frame.
      const current = yield* input.authorize();
      yield* Effect.try({ try: () => {
        if (current.id !== principal.id) throw new HttpFailure(401, "authentication_required", "The event subscriber identity changed.");
        requireCapability(current, "observations.read");
      }, catch: error => error });
      const size = Buffer.byteLength(JSON.stringify(page)) + 512;
      if (size > RESPONSE_MAX_BYTES) return yield* Effect.fail(new HttpFailure(503, "source_invalid", "An observation page exceeds the stream frame bound."));
      if (bytes + size > WATCH_LIMITS.maxBytes || pages >= WATCH_LIMITS.maxPages) {
        yield* emit({ kind: "end", cursor, reason: "capacity" }); return;
      }
      yield* emit({ kind: "page", page }); cursor = page.cursor; bytes += size; pages++;
      if (Date.now() >= deadline) { yield* emit({ kind: "end", cursor, reason: "duration" }); return; }
      if (!page.hasMore) yield* Effect.sleep(`${Math.min(WATCH_LIMITS.intervalMs, Math.max(1, deadline - Date.now()))} millis`);
    }
  });
  const disconnected = Effect.callback<never>(resume => {
    const stop = () => resume(Effect.interrupt);
    if (input.disconnected.aborted) stop(); else input.disconnected.addEventListener("abort", stop, { once: true });
    return Effect.sync(() => input.disconnected.removeEventListener("abort", stop));
  });
  return Effect.raceFirst(program, disconnected);
}

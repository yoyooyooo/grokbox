import { ManagementClientError, type ManagementClient, type ObservationEventPage } from "@grokbox/client";

export type EventWatchState = { state: "connecting" | "connected" | "reconnecting" | "gap" | "stopped"; cursor: string; error?: ManagementClientError };
export type EventWatchListener = { page: (page: ObservationEventPage) => void; status: (state: EventWatchState) => void };
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
  });
}
/** The router service owns one watch. Normal bounded windows continue from the
 * last verified cursor; failures get at most three read-only reconnect attempts.
 * Gaps and identity/permission/protocol failures require explicit intervention. */
export function startEventWatch(api: ManagementClient, principalId: string, cursor: string, listener: EventWatchListener): () => void {
  const owner = new AbortController();
  let current = cursor, failures = 0;
  const publish = (state: EventWatchState["state"], error?: ManagementClientError) => { if (!owner.signal.aborted) listener.status({ state, cursor: current, ...(error ? { error } : {}) }); };
  const run = async () => {
    while (!owner.signal.aborted) {
      publish(failures ? "reconnecting" : "connecting");
      try {
        const session = (await api.consoleSession(owner.signal)).data;
        if (session.principalId !== principalId) throw new ManagementClientError("authentication_required", "The signed-in identity changed; reload before watching events.");
        if (!session.capabilities.includes("observations.read")) throw new ManagementClientError("permission_denied", "The current session cannot read observations.");
        for await (const frame of api.watchObservationEvents({ cursor: current, limit: 50, durationMs: 30_000, signal: owner.signal })) {
          if (owner.signal.aborted) return;
          if (frame.data.kind === "page") { listener.page(frame.data.page); current = frame.data.page.cursor; publish("connected"); }
          else failures = 0;
        }
      } catch (failure) {
        if (owner.signal.aborted) return;
        const error = failure instanceof ManagementClientError ? failure : new ManagementClientError("unavailable", "The event view was interrupted.");
        if (error.code === "cursor_gap" || error.code === "source_changed") { publish("gap", error); return; }
        if (!["unavailable", "source_unavailable", "source_timeout"].includes(error.code) || ++failures > 3) { publish("stopped", error); return; }
        publish("reconnecting", error); await wait(Math.min(8000, 1000 * 2 ** (failures - 1)), owner.signal);
      }
    }
  };
  void run().catch(() => publish("stopped", new ManagementClientError("unavailable", "The event subscriber could not continue.")));
  return () => owner.abort();
}

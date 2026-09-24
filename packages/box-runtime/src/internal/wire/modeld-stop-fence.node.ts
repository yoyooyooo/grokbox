import { createConnection } from "node:net";
import { Effect } from "effect";
import { BoxRuntimeError, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME } from "./modeld-wire.ts";
import { modeldSocketPath } from "./modeld-probe.node.ts";

/** An owner-side idle fence lives on this connection. A read-only legacy probe
 * cannot acquire it and cannot authorize an idle-stop signal. */
export function acquireModeldStopFence(runRoot: string, expectedEpoch: string, rootId: string) {
  return Effect.acquireRelease(Effect.callback<{ active: () => boolean; release: () => Promise<void> }, BoxRuntimeError>(resume => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    let acknowledged = false, settled = false, lost = false;
    let bytes: Buffer = Buffer.alloc(0);
    const fail = () => {
      lost = true;
      clearTimeout(timer);
      socket.destroy();
      if (!settled) {
        settled = true;
        resume(Effect.fail(new BoxRuntimeError("invalid_usage", "modeld idle-stop fence unavailable or busy; no signal was sent")));
      }
    };
    const timer = setTimeout(fail, 2000);
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("close", () => { lost = true; if (!settled) fail(); });
    socket.on("connect", () => socket.write(encodeModeldFrame({ version: WIRE_VERSION, method: "fence-stop", expectedEpoch, rootId })));
    socket.on("data", (chunk: Buffer) => {
      if (acknowledged || bytes.length + chunk.length > MODELD_MAX_FRAME + 4) { fail(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const frame = decodeModeldFrame(bytes);
      if (!frame) return;
      if ("error" in frame || frame.rest.length !== 0) { fail(); return; }
      const value = frame.value as Record<string, unknown> | null;
      if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "fenced,method,ok,rootId,serverGeneration,version"
        || value.ok !== true || value.method !== "fence-stop" || value.version !== WIRE_VERSION
        || value.serverGeneration !== expectedEpoch || value.rootId !== rootId || value.fenced !== true) { fail(); return; }
      acknowledged = true;
      settled = true;
      clearTimeout(timer);
      resume(Effect.succeed({ active: () => acknowledged && !lost && !socket.destroyed && !socket.readableEnded,
        release: () => new Promise<void>(resolve => {
          if (socket.closed) { resolve(); return; }
          socket.once("close", resolve);
          socket.destroy();
        }) }));
    });
    return Effect.sync(() => { if (!acknowledged) { clearTimeout(timer); socket.destroy(); } });
  }), fence => Effect.promise(fence.release));
}

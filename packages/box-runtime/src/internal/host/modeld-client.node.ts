import { createConnection } from "node:net";
import {
  acceptModeldFrame,
  clientSessionFor,
  decodeModeldFrame,
  encodeModeldFrame,
  MODELD_MAX_FRAME,
  type ClientSession,
} from "../wire/modeld-wire.ts";
import { modeldSocketPath } from "../wire/modeld-probe.node.ts";

/** Effect-free Host client. Schema/sequence/method SM. EOF without complete session is incomplete. */
export async function requestModeld(runRoot: string, body: unknown, timeoutMs = 2_000): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    let session: ClientSession;
    try { session = clientSessionFor(body); }
    catch (error) {
      reject(error instanceof Error ? error : new Error("request"));
      return;
    }
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    const frames: unknown[] = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    let done = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (!done) reject(new Error("incomplete"));
      else resolve(frames);
    };
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame(body)); }
      catch (error) { finish(error instanceof Error ? error : new Error("write")); }
    });
    socket.on("data", (chunk: Buffer) => {
      if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
        finish(new Error("frame"));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const decoded = decodeModeldFrame(buf);
        if (decoded == null) break;
        if ("error" in decoded) {
          finish(new Error(decoded.error));
          return;
        }
        buf = Buffer.from(decoded.rest);
        try {
          const next = acceptModeldFrame(session, decoded.value);
          session = next.session;
          frames.push(decoded.value);
          if (next.done) {
            done = true;
            if (buf.length > 0) {
              finish(new Error("extra_keys"));
              return;
            }
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error("malformed_frame"));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish());
    socket.on("close", () => { if (!settled) finish(); });
  });
}

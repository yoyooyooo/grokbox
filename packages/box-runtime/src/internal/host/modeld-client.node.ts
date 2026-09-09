import { createConnection } from "node:net";
import { decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME } from "../wire/modeld-wire.ts";
import { modeldSocketPath } from "../wire/modeld-probe.node.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTerminal(value: unknown): boolean {
  return isRecord(value) && (
    value.kind === "terminal"
    || value.method === "health"
    || value.method === "cancel-step"
    || value.ok === false
  );
}

/** Effect-free Host client. EOF without terminal is incomplete/unknown, not success. */
export async function requestModeld(runRoot: string, body: unknown, timeoutMs = 2_000): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    const frames: unknown[] = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    let sawTerminal = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (!sawTerminal) reject(new Error("incomplete"));
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
        frames.push(decoded.value);
        buf = Buffer.from(decoded.rest);
        if (isTerminal(decoded.value)) {
          sawTerminal = true;
          finish();
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish());
    socket.on("close", () => { if (!settled) finish(); });
  });
}

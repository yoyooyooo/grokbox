import { createConnection } from "node:net";
import { join } from "node:path";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME } from "./modeld-wire.ts";

export function modeldSocketPath(runRoot: string): string {
  return join(runRoot, "modeld.sock");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bounded read-only health. No credentials, admission, or Effect. */
export async function probeModeldHealth(runRoot: string, timeoutMs = 80): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => {
      try {
        socket.write(encodeModeldFrame({ method: "health", version: WIRE_VERSION }));
      } catch {
        finish(false);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
        finish(false);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeModeldFrame(buf);
      if (decoded == null) return;
      if ("error" in decoded) {
        finish(false);
        return;
      }
      const value = decoded.value;
      finish(
        isRecord(value) &&
          value.ok === true &&
          value.method === "health" &&
          value.version === WIRE_VERSION &&
          typeof value.serverGeneration === "string" &&
          /^[a-f0-9-]{36}$/.test(value.serverGeneration),
      );
    });
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("close", () => {
      if (!settled) finish(false);
    });
  });
}

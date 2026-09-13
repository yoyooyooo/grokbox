import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import type { ModeldServiceScope } from "@grokbox/runtime-kernel/status";
import { join, resolve as resolvePath } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { acceptModeldFrame, decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME } from "./modeld-wire.ts";

export function modeldSocketPath(runRoot: string): string {
  return join(runRoot, "modeld.sock");
}

/** A deployment-root identity, not a token, PID witness or ownership grant.
 * Paths are resolved, not printed. Aliased roots must be explicitly requalified. */
export function modeldRootId(durableRoot: string, runRoot: string): string {
  return sha256Text(canonicalJson([resolvePath(durableRoot), resolvePath(runRoot)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Finite read-only probe. Does not create, unlink or repair a socket. */
async function probe(runRoot: string, method: "health" | "service-info", timeoutMs: number): Promise<Record<string, unknown> | null> {
  return await new Promise((resolve) => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame({ method, version: WIRE_VERSION })); }
      catch { finish(null); }
    });
    socket.on("data", (chunk: Buffer) => {
      if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) { finish(null); return; }
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeModeldFrame(buf);
      if (decoded === null) return;
      if ("error" in decoded || decoded.rest.length !== 0) { finish(null); return; }
      try {
        acceptModeldFrame({ method }, decoded.value);
        finish(isRecord(decoded.value) && decoded.value.ok === true ? decoded.value : null);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => { if (!settled) finish(null); });
  });
}

/** Health alone intentionally makes no claim about configuration scope. */
export async function probeModeldHealth(runRoot: string, timeoutMs = 80): Promise<boolean> {
  return (await probe(runRoot, "health", timeoutMs)) !== null;
}

export async function probeModeldIdentity(runRoot: string, timeoutMs = 200): Promise<{ rootId: string; generation: string } | null> {
  const result = await probe(runRoot, "service-info", timeoutMs);
  if (!result || typeof result.rootId !== "string" || typeof result.serverGeneration !== "string") return null;
  return { rootId: result.rootId, generation: result.serverGeneration };
}

export type ModeldServiceObservation = {
  ready: boolean | null;
  scope: ModeldServiceScope;
  serviceEpoch: string | null;
  observedAt: string;
};

/** Readiness for this installation, not for an arbitrary responding socket.
 * No fallback may turn a missing identity into permission to use the service.
 * A legacy/occupied/unresponsive path remains unknown, never repaired here. */
export async function observeModeldService(durableRoot: string, runRoot: string): Promise<ModeldServiceObservation> {
  const observedAt = new Date().toISOString();
  const identity = await probeModeldIdentity(runRoot);
  if (identity) {
    const matched = identity.rootId === modeldRootId(durableRoot, runRoot);
    return { ready: matched, scope: matched ? "matched" : "mismatch", serviceEpoch: identity.generation, observedAt };
  }
  let absent = false;
  try { lstatSync(modeldSocketPath(runRoot)); }
  catch (error) {
    // Access errors and invalid parent paths are not proof of absence.
    absent = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
  return { ready: absent ? false : null, scope: absent ? "not_observed" : "unavailable", serviceEpoch: null, observedAt };
}

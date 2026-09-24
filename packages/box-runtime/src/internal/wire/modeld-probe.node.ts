import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import type { ModeldServiceScope } from "@grokbox/runtime-kernel/status";
import { join, resolve as resolvePath } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { WIRE_VERSION, projectExecutionCapacity, type ExecutionCapacity } from "@grokbox/runtime-kernel/contract";
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
async function probe(runRoot: string, method: "health" | "service-info" | "execution-status", timeoutMs: number, version: 4 | 5 | 6 | 7 | typeof WIRE_VERSION = WIRE_VERSION, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (signal?.aborted) return null;
  return await new Promise((resolve) => {
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      resolve(value);
    };
    const aborted = () => finish(null);
    signal?.addEventListener("abort", aborted, { once: true });
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame({ method, version })); }
      catch { finish(null); }
    });
    socket.on("data", (chunk: Buffer) => {
      if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) { finish(null); return; }
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeModeldFrame(buf);
      if (decoded === null) return;
      if ("error" in decoded || decoded.rest.length !== 0) { finish(null); return; }
      try {
        if (!isRecord(decoded.value) || decoded.value.version !== version) { finish(null); return; }
        // Only these finite read-only methods share an unchanged v4/v5/v6 shape.
        // This normalization is NOT available to run-step or Host execution.
        acceptModeldFrame({ method }, { ...decoded.value, version: WIRE_VERSION });
        finish(decoded.value.ok === true ? decoded.value : null);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => { if (!settled) finish(null); });
  });
}

/** Health alone intentionally makes no claim about configuration scope. */
export async function probeModeldHealth(runRoot: string, timeoutMs = 80, signal?: AbortSignal): Promise<boolean> {
  return (await probe(runRoot, "health", timeoutMs, WIRE_VERSION, signal)) !== null;
}

export async function probeModeldIdentity(runRoot: string, timeoutMs = 200): Promise<{ rootId: string; generation: string } | null> {
  const result = await probe(runRoot, "service-info", timeoutMs);
  if (!result || typeof result.rootId !== "string" || typeof result.serverGeneration !== "string") return null;
  return { rootId: result.rootId, generation: result.serverGeneration };
}

export async function probeModeldExecution(runRoot: string, timeoutMs = 500): Promise<{ generation: string; execution: ExecutionCapacity } | null> {
  const response = await probe(runRoot, "execution-status", timeoutMs);
  const execution = projectExecutionCapacity(response?.execution);
  return response && typeof response.serverGeneration === "string" && execution ? { generation: response.serverGeneration, execution } : null;
}

/** Operator-only transition probe. A verified legacy identity is enough to
 * inspect/replace a service, never enough to call it with a managed STEP. */
export async function probeModeldReplacement(runRoot: string, timeoutMs = 500) {
  for (const version of [WIRE_VERSION, 7, 6, 5, 4] as const) {
    const identity = await probe(runRoot, "service-info", timeoutMs, version);
    if (!identity || typeof identity.rootId !== "string" || typeof identity.serverGeneration !== "string") continue;
    const activity = await probe(runRoot, "execution-status", timeoutMs, version);
    const execution = projectExecutionCapacity(activity?.execution);
    if (!execution || activity?.serverGeneration !== identity.serverGeneration) return null;
    return { rootId: identity.rootId, generation: identity.serverGeneration, wireVersion: version, execution };
  }
  return null;
}

export type ModeldServiceObservation = {
  ready: boolean | null;
  scope: ModeldServiceScope;
  serviceEpoch: string | null;
  observedAt: string;
  execution?: ExecutionCapacity;
  executionGap?: "not_instrumented" | "generation_changed";
  wireVersion?: number;
  expectedWireVersion?: number;
  protocolCompatible?: boolean;
};

/** Readiness for this installation, not for an arbitrary responding socket.
 * No fallback may turn a missing identity into permission to use the service.
 * A legacy/occupied/unresponsive path remains unknown, never repaired here. */
export async function observeModeldService(durableRoot: string, runRoot: string): Promise<ModeldServiceObservation> {
  const observedAt = new Date().toISOString();
  const identity = await probeModeldIdentity(runRoot);
  if (identity) {
    const matched = identity.rootId === modeldRootId(durableRoot, runRoot);
    const status = matched ? await probeModeldExecution(runRoot) : null;
    const valid = status?.generation === identity.generation;
    return { ready: matched && (!status || valid), scope: matched ? "matched" : "mismatch", serviceEpoch: identity.generation, observedAt,
      wireVersion: WIRE_VERSION, expectedWireVersion: WIRE_VERSION, protocolCompatible: true,
      ...(status && valid ? { execution: status.execution } : { executionGap: status ? "generation_changed" as const : "not_instrumented" as const }) };
  }
  // Observation must not depend on the stricter replacement gate. A legacy
  // service with no execution-status still has an observable protocol identity.
  for (const version of [7, 6, 5, 4] as const) {
  const legacy = await probe(runRoot, "service-info", 200, version);
  if (legacy && typeof legacy.rootId === "string" && typeof legacy.serverGeneration === "string") {
    const matched = legacy.rootId === modeldRootId(durableRoot, runRoot);
    const activity = matched ? await probe(runRoot, "execution-status", 200, version) : null;
    const execution = projectExecutionCapacity(activity?.execution);
    const sameGeneration = activity?.serverGeneration === legacy.serverGeneration;
    return { ready: false, scope: matched ? "matched" : "mismatch", serviceEpoch: legacy.serverGeneration, observedAt,
      ...(execution && sameGeneration ? { execution } : { executionGap: activity && !sameGeneration ? "generation_changed" as const : "not_instrumented" as const }),
      wireVersion: version, expectedWireVersion: WIRE_VERSION, protocolCompatible: false };
  }
  }
  let absent = false;
  try { lstatSync(modeldSocketPath(runRoot)); }
  catch (error) {
    // Access errors and invalid parent paths are not proof of absence.
    absent = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
  return { ready: absent ? false : null, scope: absent ? "not_observed" : "unavailable", serviceEpoch: null, observedAt, expectedWireVersion: WIRE_VERSION };
}

import {
  WIRE_FRAME_MAX_BYTES,
  WireError,
  exactKeys,
  parseWireVersion,
  type CancelStepRequest,
  type HostEpoch,
  type RunStepRequest,
  type SelectionIdentity,
  type ServiceEpoch,
  parseContextSnapshot,
} from "@grokbox/runtime-kernel/contract";

export const MODELD_MAX_FRAME = WIRE_FRAME_MAX_BYTES;
export { WIRE_FRAME_MAX_BYTES };

export function encodeModeldFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MODELD_MAX_FRAME) throw new Error("modeld frame too large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

export function decodeModeldFrame(
  buffer: Buffer,
): { value: unknown; rest: Buffer } | { error: "too-large" | "malformed" } | null {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32BE(0);
  if (length > MODELD_MAX_FRAME) return { error: "too-large" };
  if (buffer.length < 4 + length) return null;
  const payload = buffer.subarray(4, 4 + length);
  try {
    const text = payload.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(payload)) return { error: "malformed" };
    return { value: JSON.parse(text) as unknown, rest: Buffer.from(buffer.subarray(4 + length)) };
  } catch {
    return { error: "malformed" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseHostEpoch(value: unknown): HostEpoch | undefined {
  if (!isRecord(value) || !exactKeys(value, ["compile", "source", "profile", "hostIdentity", "bridgeDigest", "wireVersion"])) {
    return undefined;
  }
  if ([value.compile, value.source, value.profile, value.hostIdentity, value.bridgeDigest, value.wireVersion].some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as unknown as HostEpoch;
}

function parseServiceEpoch(value: unknown): ServiceEpoch | undefined {
  if (!isRecord(value) || !exactKeys(value, ["incarnationId"]) || typeof value.incarnationId !== "string") return undefined;
  return { incarnationId: value.incarnationId };
}

function parseSelection(value: unknown): SelectionIdentity | undefined {
  if (!isRecord(value) || !exactKeys(value, ["agentId", "modelId", "selectionRevision"])) return undefined;
  if (typeof value.agentId !== "string" || typeof value.modelId !== "string" || typeof value.selectionRevision !== "string") return undefined;
  return value as unknown as SelectionIdentity;
}

export type ParsedWireRequest =
  | { method: "health" }
  | { method: "run-step"; request: RunStepRequest }
  | { method: "cancel-step"; request: CancelStepRequest };

export function parseV3Request(value: unknown): ParsedWireRequest {
  const version = parseWireVersion(value);
  if (version !== 3) throw new WireError("unsupported_version");
  if (!isRecord(value) || typeof value.method !== "string") throw new WireError("malformed_frame");
  if (value.method === "health") {
    if (!exactKeys(value, ["version", "method"])) throw new WireError("extra_keys");
    return { method: "health" };
  }
  if (value.method === "run-step") {
    if (!exactKeys(value, ["version", "method", "hostEpoch", "serviceEpoch", "agentId", "turnId", "stepId", "selection", "snapshot"], ["bindingId"])) {
      throw new WireError("extra_keys");
    }
    const hostEpoch = parseHostEpoch(value.hostEpoch);
    const serviceEpoch = parseServiceEpoch(value.serviceEpoch);
    const selection = parseSelection(value.selection);
    if (!hostEpoch || !serviceEpoch || !selection) throw new WireError("malformed_frame");
    if (typeof value.agentId !== "string" || typeof value.turnId !== "string" || typeof value.stepId !== "string") {
      throw new WireError("malformed_frame");
    }
    if (Object.hasOwn(value, "bindingId") && typeof value.bindingId !== "string") throw new WireError("malformed_frame");
    if (!isRecord(value.snapshot) || !exactKeys(value.snapshot, ["version", "profileId", "abiIdentity", "systemMessages", "messages", "tools", "snapshotDigest"], ["options"])) {
      throw new WireError("extra_keys");
    }
    let snapshot;
    try { snapshot = parseContextSnapshot(value.snapshot); }
    catch { throw new WireError("malformed_frame"); }
    const request: RunStepRequest = {
      hostEpoch,
      serviceEpoch,
      agentId: value.agentId,
      turnId: value.turnId,
      stepId: value.stepId,
      selection,
      snapshot,
    };
    if (typeof value.bindingId === "string") request.bindingId = value.bindingId;
    return { method: "run-step", request };
  }
  if (value.method === "cancel-step") {
    if (!exactKeys(value, ["version", "method", "hostEpoch", "serviceEpoch", "agentId", "turnId", "stepId"])) {
      throw new WireError("extra_keys");
    }
    const hostEpoch = parseHostEpoch(value.hostEpoch);
    const serviceEpoch = parseServiceEpoch(value.serviceEpoch);
    if (!hostEpoch || !serviceEpoch) throw new WireError("malformed_frame");
    if (typeof value.agentId !== "string" || typeof value.turnId !== "string" || typeof value.stepId !== "string") {
      throw new WireError("malformed_frame");
    }
    return {
      method: "cancel-step",
      request: {
        hostEpoch,
        serviceEpoch,
        agentId: value.agentId,
        turnId: value.turnId,
        stepId: value.stepId,
      },
    };
  }
  throw new WireError("unknown_method");
}

export type ClientSession =
  | { method: "health" }
  | { method: "cancel-step" }
  | { method: "run-step"; phase: "start" | "events"; sequence: number };

export function clientSessionFor(body: unknown): ClientSession {
  if (!isRecord(body) || typeof body.method !== "string") throw new WireError("malformed_frame");
  if (body.method === "health") return { method: "health" };
  if (body.method === "cancel-step") return { method: "cancel-step" };
  if (body.method === "run-step") return { method: "run-step", phase: "start", sequence: 0 };
  throw new WireError("unknown_method");
}

function uuidLike(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

/** Strict v3 response. Returns whether the session is complete. */
export function acceptModeldFrame(session: ClientSession, value: unknown): { session: ClientSession; done: boolean; control?: ParsedV4Control } {
  if (!isRecord(value)) throw new WireError("malformed_frame");
  if (value.ok === false) {
    if (!exactKeys(value, ["ok", "version", "error"])) throw new WireError("extra_keys");
    if (value.version !== 3 || !isRecord(value.error) || !exactKeys(value.error, ["code"]) || typeof value.error.code !== "string") {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  if (session.method === "health") {
    if (!exactKeys(value, ["ok", "method", "version", "serverGeneration"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "health" || value.version !== 3 || !uuidLike(value.serverGeneration)) {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  if (session.method === "cancel-step") {
    if (!exactKeys(value, ["ok", "method", "version"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "cancel-step" || value.version !== 3) throw new WireError("malformed_frame");
    return { session, done: true };
  }
  if (session.phase === "start") {
    if (!exactKeys(value, ["ok", "method", "kind", "version", "bindingId"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "run-step" || value.kind !== "accepted" || value.version !== 3 || typeof value.bindingId !== "string") {
      throw new WireError("malformed_frame");
    }
    return { session: { method: "run-step", phase: "events", sequence: 0 }, done: false };
  }
  if (isRecord(value) && value.version === 4) {
    const control = parseV4ControlFrame(value);
    if (control.method !== "compact-request") throw new WireError("unknown_method");
    return { session, done: false, control };
  }
  if (value.kind === "event") {
    if (!exactKeys(value, ["kind", "sequence", "event"])) throw new WireError("extra_keys");
    if (value.sequence !== session.sequence || !isRecord(value.event)) throw new WireError("malformed_frame");
    return { session: { ...session, sequence: session.sequence + 1 }, done: false };
  }
  if (value.kind === "terminal") {
    if (Object.hasOwn(value, "version") && value.version !== 3) throw new WireError("unsupported_version");
    if (value.outcome === "ok") {
      if (!exactKeys(value, ["kind", "outcome", "bindingId"], ["finishReason", "usage", "version"])) throw new WireError("extra_keys");
      if (typeof value.bindingId !== "string") throw new WireError("malformed_frame");
    } else if (value.outcome === "error") {
      if (!exactKeys(value, ["kind", "outcome", "code"], ["version"])) throw new WireError("extra_keys");
      if (typeof value.code !== "string") throw new WireError("malformed_frame");
    } else if (value.outcome === "duplicate") {
      if (!exactKeys(value, ["kind", "outcome", "snapshotDigest", "bindingId"], ["version"])) throw new WireError("extra_keys");
    } else {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  throw new WireError("malformed_frame");
}

export type ParsedV4Control =
  | { method: "compact-request"; agentId: string; turnId: string; stepId: string; bindingId: string; selectionRevision: string; recoveryNonce: string; deadlineMs: number }
  | { method: "resume-step"; agentId: string; turnId: string; stepId: string; bindingId: string; selectionRevision: string; recoveryNonce: string; snapshot: ReturnType<typeof parseContextSnapshot> };

/** Fake/offline v4 control frames. Production parseV3Request still rejects version 4. */
export function parseV4ControlFrame(value: unknown): ParsedV4Control {
  const version = parseWireVersion(value);
  if (version !== 4) throw new WireError("unsupported_version");
  if (!isRecord(value) || typeof value.method !== "string") throw new WireError("malformed_frame");
  if (value.method === "compact-request") {
    if (!exactKeys(value, ["version", "method", "agentId", "turnId", "stepId", "bindingId", "selectionRevision", "recoveryNonce", "deadlineMs"])) {
      throw new WireError("extra_keys");
    }
    const compactIds = [value.agentId, value.turnId, value.stepId, value.bindingId, value.selectionRevision, value.recoveryNonce];
    if (compactIds.some((item) => typeof item !== "string")) throw new WireError("malformed_frame");
    const [agentId, turnId, stepId, bindingId, selectionRevision, recoveryNonce] = compactIds as string[];
    if (typeof value.deadlineMs !== "number" || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0) {
      throw new WireError("malformed_frame");
    }
    return {
      method: "compact-request",
      agentId, turnId, stepId, bindingId, selectionRevision, recoveryNonce,
      deadlineMs: value.deadlineMs,
    };
  }
  if (value.method === "resume-step") {
    if (!exactKeys(value, ["version", "method", "agentId", "turnId", "stepId", "bindingId", "selectionRevision", "recoveryNonce", "snapshot"])) {
      throw new WireError("extra_keys");
    }
    const resumeIds = [value.agentId, value.turnId, value.stepId, value.bindingId, value.selectionRevision, value.recoveryNonce];
    if (resumeIds.some((item) => typeof item !== "string")) throw new WireError("malformed_frame");
    const [agentId, turnId, stepId, bindingId, selectionRevision, recoveryNonce] = resumeIds as string[];
    let snapshot;
    try { snapshot = parseContextSnapshot(value.snapshot); }
    catch { throw new WireError("malformed_frame"); }
    return {
      method: "resume-step",
      agentId, turnId, stepId, bindingId, selectionRevision, recoveryNonce,
      snapshot,
    };
  }
  throw new WireError("unknown_method");
}

import {
  WIRE_FRAME_MAX_BYTES,
  WIRE_VERSION,
  WireError,
  exactKeys,
  parseWireVersion,
  type CancelStepRequest,
  type HostEpoch,
  type RunStepRequest,
  type SelectionIdentity,
  type ServiceEpoch,
  parseContextSnapshot,
  annotateStreamFailure,
  projectExecutionCapacity,
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
  | { method: "service-info" }
  | { method: "execution-status" }
  | { method: "run-step"; request: RunStepRequest }
  | { method: "cancel-step"; request: CancelStepRequest };

/** v3 is rejected with zero effects. Production parser is parseModeldRequest. */
export function parseV3Request(value: unknown): ParsedWireRequest {
  void value;
  throw new WireError("unsupported_version");
}

export function parseModeldRequest(value: unknown): ParsedWireRequest {
  const version = parseWireVersion(value);
  if (version === 3 || version !== WIRE_VERSION) throw new WireError("unsupported_version");
  if (!isRecord(value) || typeof value.method !== "string") throw new WireError("malformed_frame");
  if (value.method === "health" || value.method === "service-info" || value.method === "execution-status") {
    if (!exactKeys(value, ["version", "method"])) throw new WireError("extra_keys");
    return { method: value.method };
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
  | { method: "service-info" }
  | { method: "execution-status" }
  | { method: "cancel-step" }
  | { method: "run-step"; phase: "start" | "events"; sequence: number; bindingId?: string; expectedBindingId?: string };

export function clientSessionFor(body: unknown): ClientSession {
  if (!isRecord(body) || typeof body.method !== "string") throw new WireError("malformed_frame");
  if (body.method === "health" || body.method === "service-info" || body.method === "execution-status") return { method: body.method };
  if (body.method === "cancel-step") return { method: "cancel-step" };
  if (body.method === "run-step") return { method: "run-step", phase: "start", sequence: 0, ...(typeof body.bindingId === "string" ? { expectedBindingId: body.bindingId } : {}) };
  throw new WireError("unknown_method");
}

function uuidLike(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

function validWireUsage(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["promptTokens", "completionTokens"], ["cacheReadTokens", "cacheWriteTokens"])) return false;
  return Object.values(value).every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
}
function isWireInferenceEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
  if (value.type === "text_delta" || value.type === "reasoning_delta") return exactKeys(value, ["type", "text"]) && typeof value.text === "string";
  if (!id(value.toolCallId) || !id(value.toolName)) return false;
  if (value.type === "tool_start") return exactKeys(value, ["type", "toolCallId", "toolName"]);
  if (value.type === "tool_delta") return exactKeys(value, ["type", "toolCallId", "toolName", "argsTextDelta"]) && typeof value.argsTextDelta === "string";
  if (value.type === "tool_complete") return exactKeys(value, ["type", "toolCallId", "toolName", "args"]) && value.args !== undefined;
  return false;
}

/** Strict v4 response. A success must match the admitted binding and an explicit finish. */
export function acceptModeldFrame(session: ClientSession, value: unknown): { session: ClientSession; done: boolean; control?: ParsedV4Control } {
  if (!isRecord(value)) throw new WireError("malformed_frame");
  if (value.ok === false) {
    if (!exactKeys(value, ["ok", "version", "error"])) throw new WireError("extra_keys");
    if (value.version !== WIRE_VERSION || !isRecord(value.error) || !exactKeys(value.error, ["code"]) || typeof value.error.code !== "string") {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  if (session.method === "execution-status") {
    if (!exactKeys(value, ["ok", "method", "version", "serverGeneration", "execution"]) || value.ok !== true
      || value.method !== "execution-status" || value.version !== WIRE_VERSION || !uuidLike(value.serverGeneration)
      || !projectExecutionCapacity(value.execution)) throw new WireError("malformed_frame");
    return { session, done: true };
  }
  if (session.method === "service-info") {
    if (!exactKeys(value, ["ok", "method", "version", "serverGeneration", "rootId"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "service-info" || value.version !== WIRE_VERSION || !uuidLike(value.serverGeneration)
      || (value.rootId !== null && (typeof value.rootId !== "string" || !/^[a-f0-9]{64}$/.test(value.rootId)))) {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  if (session.method === "health") {
    if (!exactKeys(value, ["ok", "method", "version", "serverGeneration"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "health" || value.version !== WIRE_VERSION || !uuidLike(value.serverGeneration)) {
      throw new WireError("malformed_frame");
    }
    return { session, done: true };
  }
  if (session.method === "cancel-step") {
    if (!exactKeys(value, ["ok", "method", "version"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "cancel-step" || value.version !== WIRE_VERSION) throw new WireError("malformed_frame");
    return { session, done: true };
  }
  if (session.phase === "start") {
    if (!exactKeys(value, ["ok", "method", "kind", "version", "bindingId"])) throw new WireError("extra_keys");
    if (value.ok !== true || value.method !== "run-step" || value.kind !== "accepted" || value.version !== WIRE_VERSION || typeof value.bindingId !== "string") {
      throw new WireError("malformed_frame");
    }
    if (!value.bindingId || value.bindingId.length > 128 || (session.expectedBindingId !== undefined && value.bindingId !== session.expectedBindingId)) {
      throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "terminal_binding_mismatch", rejectSite: "wire_terminal" });
    }
    return { session: { method: "run-step", phase: "events", sequence: 0, bindingId: value.bindingId }, done: false };
  }
  if (value.kind === "event") {
    if (!exactKeys(value, ["kind", "sequence", "event"])) throw new WireError("extra_keys");
    if (value.sequence !== session.sequence || !isWireInferenceEvent(value.event)) throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "invalid_event_shape", rejectSite: "wire_event", wireSequence: session.sequence });
    return { session: { ...session, sequence: session.sequence + 1 }, done: false };
  }
  if (value.kind === "terminal") {
    if (Object.hasOwn(value, "version") && value.version !== WIRE_VERSION) throw new WireError("unsupported_version");
    if (value.outcome === "ok") {
      if (!exactKeys(value, ["kind", "outcome", "bindingId", "finishReason"], ["usage", "version"])) throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "invalid_terminal", rejectSite: "wire_terminal" });
      if (!session.bindingId || value.bindingId !== session.bindingId) throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "terminal_binding_mismatch", rejectSite: "wire_terminal" });
      if (!["stop", "error", "abort"].includes(String(value.finishReason))) throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "unsupported_finish_reason", rejectSite: "wire_terminal" });
      if (value.usage !== undefined && !validWireUsage(value.usage)) throw annotateStreamFailure(new WireError("malformed_frame"), { normalizeCause: "invalid_usage", rejectSite: "wire_terminal" });
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
  if (typeof value.method === "string") {
    const control = parseV4ControlFrame(value);
    if (control.method !== "compact-request") throw new WireError("unknown_method");
    return { session, done: false, control };
  }
  throw new WireError("malformed_frame");
}

export type ParsedV4Control =
  | { method: "compact-request"; agentId: string; turnId: string; stepId: string; bindingId: string; selectionRevision: string; recoveryNonce: string; deadlineMs: number }
  | { method: "resume-step"; agentId: string; turnId: string; stepId: string; bindingId: string; selectionRevision: string; recoveryNonce: string; snapshot: ReturnType<typeof parseContextSnapshot> };

/** v4 compact-request / resume-step. Initial connection still uses parseModeldRequest. */
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

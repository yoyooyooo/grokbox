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

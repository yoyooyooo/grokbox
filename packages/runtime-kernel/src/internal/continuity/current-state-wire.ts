import { continuityObject, continuityStorePolicy, isContinuityHash, isContinuityUuid, recoveryManifest,
  type RecoveryManifest } from "./material.ts";
import { CurrentStateFailure, copyNativeMaterial, type NativeMaterial } from "./current-state.ts";

export const CURRENT_STATE_RPC_VERSION = 1 as const;
export const MAX_CURRENT_STATE_WIRE_BYTES = 24 * 1024 * 1024;
export type CurrentStateWireMaterial = { manifest: RecoveryManifest; content: Array<{ hash: string; base64: string }> };
export type CurrentStateRpcRequest = { version: 1; action: "capabilities" | "head" | "capture" | "compose" | "birth" | "load" | "startup" | "startup-status" | "preview" | "initialize" | "observe" | "activate";
  agentId: string; payload?: string; confirm?: boolean };
const bad = (): never => { throw new CurrentStateFailure("invalid_request"); };
export function currentStateRpcRequest(raw: unknown): CurrentStateRpcRequest {
  try {
    const v = continuityObject(raw, ["version", "action", "agentId", "payload", "confirm"]);
    if (v.version !== 1 || !["capabilities", "head", "capture", "compose", "birth", "load", "startup", "startup-status", "preview", "initialize", "observe", "activate"].includes(String(v.action))
      || !isContinuityUuid(v.agentId) || v.payload !== undefined && (typeof v.payload !== "string" || Buffer.byteLength(v.payload) > MAX_CURRENT_STATE_WIRE_BYTES)
      || v.confirm !== undefined && typeof v.confirm !== "boolean") return bad();
    if (["initialize", "activate", "birth", "load", "startup"].includes(String(v.action)) && v.confirm !== true) return bad();
    return v as CurrentStateRpcRequest;
  } catch { return bad(); }
}
export function encodeCurrentStateMaterial(raw: NativeMaterial): CurrentStateWireMaterial {
  const material = copyNativeMaterial(raw, continuityStorePolicy());
  return { manifest: material.manifest, content: [...material.content].map(([hash, value]) => ({ hash, base64: Buffer.from(value).toString("base64") })) };
}
export function decodeCurrentStateMaterial(raw: unknown): NativeMaterial {
  try {
    const v = continuityObject(raw, ["manifest", "content"]), policy = continuityStorePolicy();
    const manifest = recoveryManifest(v.manifest, policy);
    if (!Array.isArray(v.content) || v.content.length > policy.maxParts) return bad();
    const content = new Map<string, Uint8Array>(); let total = 0;
    for (const value of v.content) {
      const row = continuityObject(value, ["hash", "base64"]);
      if (!isContinuityHash(row.hash) || typeof row.base64 !== "string" || row.base64.length > Math.ceil(policy.maxPartBytes / 3) * 4
        || row.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(row.base64) || content.has(row.hash)) return bad();
      total += Math.floor(row.base64.length / 4) * 3; if (total > policy.maxSnapshotBytes + policy.maxParts * 2) return bad();
      const bytes = Buffer.from(row.base64, "base64"); if (bytes.toString("base64") !== row.base64) return bad();
      content.set(row.hash, bytes);
    }
    return copyNativeMaterial({ manifest, content }, policy);
  } catch { return bad(); }
}

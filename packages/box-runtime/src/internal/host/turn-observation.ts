/** Native createSession already supplies these fields. They are observations,
 * not an authorization token, provider input, or permission to join other TURNs.
 * In particular a native parentRequestId is NOT renamed to kernel stepId. */
export const NATIVE_REQUEST_SOURCES = ["turn", "agent", "automation", "handoff-resume", "connector", "voice-call"] as const;
export type NativeTurnObservation = {
  version: 1;
  source: (typeof NATIVE_REQUEST_SOURCES)[number] | "unknown" | "not_provided";
  sourceEvidence: "native-session-options";
  isSubagent?: boolean;
  isComputerUseSubagent?: boolean;
  isBrowserUseSubagent?: boolean;
  lineage: "provided" | "absent" | "invalid";
  nativeParentRequestId?: string;
  nativeRootParentRequestId?: string;
  parentToolCallIdObserved?: boolean;
};
function own(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}
function requestId(value: unknown): value is string {
  // The qualified native producer uses UUID requests. Unknown future identity
  // shapes remain unqualified rather than logging arbitrary strings or secrets.
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}
export function observeNativeTurn(options: unknown): NativeTurnObservation {
  const result: NativeTurnObservation = { version: 1, source: "not_provided", sourceEvidence: "native-session-options", lineage: "absent" };
  try {
    const source = own(options, "requestSource");
    if (source !== undefined) result.source = typeof source === "string" && (NATIVE_REQUEST_SOURCES as readonly string[]).includes(source)
      ? source as NativeTurnObservation["source"] : "unknown";
    for (const key of ["isSubagent", "isComputerUseSubagent", "isBrowserUseSubagent"] as const) {
      const value = own(options, key);
      if (typeof value === "boolean") result[key] = value;
    }
    const lineage = own(options, "lineage");
    if (lineage != null) {
      const parent = own(lineage, "parentRequestId"), root = own(lineage, "rootParentRequestId");
      if (!requestId(parent) || !requestId(root)) result.lineage = "invalid";
      else {
        result.lineage = "provided";
        result.nativeParentRequestId = parent;
        result.nativeRootParentRequestId = root;
        // Native call IDs may contain controls and provider-specific material.
        // Only presence is needed to distinguish lineage shape; never copy it.
        result.parentToolCallIdObserved = typeof own(lineage, "parentAgentToolCallId") === "string";
      }
    }
  } catch { result.lineage = "invalid"; }
  return result;
}
export function projectNativeTurnObservation(value: unknown): NativeTurnObservation | undefined {
  try {
    if (own(value, "version") !== 1 || own(value, "sourceEvidence") !== "native-session-options") return undefined;
    const source = own(value, "source"), lineage = own(value, "lineage");
    if (typeof source !== "string" || ![...NATIVE_REQUEST_SOURCES, "unknown", "not_provided"].includes(source)) return undefined;
    if (lineage !== "provided" && lineage !== "absent" && lineage !== "invalid") return undefined;
    const out: NativeTurnObservation = { version: 1, source: source as NativeTurnObservation["source"], sourceEvidence: "native-session-options", lineage };
    for (const key of ["isSubagent", "isComputerUseSubagent", "isBrowserUseSubagent"] as const) {
      const flag = own(value, key); if (typeof flag === "boolean") out[key] = flag;
    }
    if (lineage === "provided") {
      const parent = own(value, "nativeParentRequestId"), root = own(value, "nativeRootParentRequestId");
      if (!requestId(parent) || !requestId(root)) return undefined;
      out.nativeParentRequestId = parent; out.nativeRootParentRequestId = root;
      const tool = own(value, "parentToolCallIdObserved");
      if (typeof tool === "boolean") out.parentToolCallIdObserved = tool;
    }
    return out;
  } catch { return undefined; }
}

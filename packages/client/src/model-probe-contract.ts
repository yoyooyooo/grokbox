import { normalizeModelProbe as normalize, parseModelProbeReceipt, type ModelProbeReceipt } from "@grokbox/runtime-kernel/model-probe";
import { ManagementClientError } from "./contract.ts";
export type { ModelProbeRequest, ModelProbeReceipt } from "@grokbox/runtime-kernel/model-probe";
export function normalizeModelProbe(value: unknown) {
  try { return normalize(value); }
  catch { throw new ManagementClientError("invalid_input", "Confirm one bounded model probe using its observed revision and persisted request UUID."); }
}
export function modelProbeReceipt(value: unknown): value is ModelProbeReceipt {
  try { parseModelProbeReceipt(value); return true; } catch { return false; }
}

import { ManagementClientError, UUID } from "./contract.ts";
import { record as isObject } from "./response-validation.ts";
export const SYSTEM_CONFIG_DOMAINS = ["daemon", "runtime", "ops", "storage", "materials"] as const;
export type SystemConfigDomain = typeof SYSTEM_CONFIG_DOMAINS[number];
export type SystemConfigChange = {
  requestId: string; expectedRevision: string; confirmed: true; domain: SystemConfigDomain;
} & ({ mode: "patch" | "replace"; value: Record<string, unknown> } | { mode: "reset" });
export type SystemConfigView = { revision: string; document: Record<string, unknown>; application: "not-observed"; grantsIncluded: false };
export type SystemConfigReceipt = {
  requestId: string; revision: string; commit: "committed" | "unchanged"; changedPaths: string[];
  application: { state: "not-required" | "pending" | "applied" | "restart-required"; reason?: string };
};
export function systemConfigDomain(value: unknown): value is SystemConfigDomain {
  return typeof value === "string" && SYSTEM_CONFIG_DOMAINS.some(domain => domain === value);
}
export function normalizeSystemConfigChange(value: unknown): SystemConfigChange {
  if (!isObject(value) || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision)
    || value.confirmed !== true || !systemConfigDomain(value.domain)
    || !["patch", "replace", "reset"].includes(String(value.mode))
    || Object.keys(value).some(key => !["requestId", "expectedRevision", "confirmed", "domain", "mode", ...(value.mode === "reset" ? [] : ["value"])].includes(key))
    || value.mode !== "reset" && !isObject(value.value)) throw new ManagementClientError("invalid_input", "Declare a supported config domain, explicit mode, revision and confirmed request UUID.");
  const common = { requestId: value.requestId.toLowerCase(), expectedRevision: value.expectedRevision, confirmed: true as const, domain: value.domain };
  if (value.mode === "reset") return { ...common, mode: "reset" };
  if ((value.mode === "patch" || value.mode === "replace") && isObject(value.value)) return { ...common, mode: value.mode, value: value.value };
  throw new ManagementClientError("invalid_input", "Invalid config change.");
}
export function systemConfigReceipt(value: unknown): value is SystemConfigReceipt {
  return isObject(value) && Object.keys(value).every(key => ["requestId", "revision", "commit", "changedPaths", "application"].includes(key))
    && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
    && ["committed", "unchanged"].includes(String(value.commit))
    && Array.isArray(value.changedPaths) && value.changedPaths.every(path => typeof path === "string")
    && isObject(value.application) && Object.keys(value.application).every(key => ["state", "reason"].includes(key))
    && ["not-required", "pending", "applied", "restart-required"].includes(String(value.application.state))
    && (value.application.reason === undefined || typeof value.application.reason === "string");
}

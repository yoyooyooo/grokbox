import { CAPABILITIES, ManagementClientError, UUID } from "./contract.ts";
import { record as isObject } from "./response-validation.ts";
import type { AccessChange, ManagedAccessGrant, AccessReceipt, AccessView } from "@grokbox/runtime-kernel/management-access";
export type { AccessChange, ManagedAccessGrant, AccessReceipt, AccessView };
export function accessGrant(value: unknown): value is ManagedAccessGrant {
  return isObject(value) && Object.keys(value).length === 4 && typeof value.grantId === "string" && UUID.test(value.grantId)
    && typeof value.principalId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.principalId) && value.principalId !== "installation-owner"
    && typeof value.tokenSha256 === "string" && /^[a-f0-9]{64}$/.test(value.tokenSha256) && Array.isArray(value.capabilities)
    && value.capabilities.every(capability => CAPABILITIES.some(item => item === capability))
    && new Set(value.capabilities).size === value.capabilities.length
    && !value.capabilities.some(capability => ["system.config.write", "system.access.write", "models.credentials.import", "console.grants.create"].includes(capability));
}
export function normalizeAccessChange(value: unknown): AccessChange {
  if (!isObject(value) || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || value.confirmed !== true
    || Object.keys(value).length !== 5) throw new ManagementClientError("invalid_input", "Invalid access change.");
  const common = { requestId: value.requestId.toLowerCase(), expectedRevision: value.expectedRevision, confirmed: true as const };
  if (value.action === "revoke" && typeof value.grantId === "string" && UUID.test(value.grantId)) return { ...common, action: "revoke", grantId: value.grantId.toLowerCase() };
  if (value.action === "grant" && accessGrant(value.grant)) return { ...common, action: "grant", grant: { ...value.grant, grantId: value.grant.grantId.toLowerCase(), capabilities: [...value.grant.capabilities].sort() } };
  throw new ManagementClientError("invalid_input", "Grant a bounded principal and verifier, or revoke an exact grant UUID. Administrative capabilities cannot be delegated.");
}
export function accessView(value: unknown): value is AccessView {
  return isObject(value) && Object.keys(value).length === 3 && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
    && value.ownerRevocable === false && Array.isArray(value.grants) && value.grants.length <= 63
    && value.grants.every(grant => isObject(grant) && Object.keys(grant).length === 3 && accessGrant({ ...grant, tokenSha256: "0".repeat(64) }));
}
export function accessReceipt(value: unknown): value is AccessReceipt {
  return isObject(value) && Object.keys(value).length === 5 && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision) && typeof value.grantId === "string" && UUID.test(value.grantId)
    && ["grant", "revoke"].includes(String(value.action)) && value.committed === true;
}

import { ManagementClientError, UUID } from "./contract.ts";
import { record as isObject } from "./response-validation.ts";
import type { ModelCredentialRequest, ModelCredentialReceipt } from "@grokbox/runtime-kernel/model-credential";
export type { ModelCredentialRequest, ModelCredentialReceipt };
export function normalizeModelCredential(value: unknown): ModelCredentialRequest {
  if (!isObject(value) || Object.keys(value).length !== 5 || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || value.confirmed !== true
    || typeof value.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.modelId)
    || typeof value.piProvider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.piProvider)) throw new ManagementClientError("invalid_input", "Confirm one model credential import with an exact Pi provider, request UUID and revision.");
  return { requestId: value.requestId.toLowerCase(), expectedRevision: value.expectedRevision, modelId: value.modelId, piProvider: value.piProvider, confirmed: true };
}
export function modelCredentialReceipt(value: unknown): value is ModelCredentialReceipt {
  return isObject(value) && Object.keys(value).length === 6 && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.modelId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.modelId)
    && (value.state === "unknown" || value.state === "failed" ? value.revision === null : value.state === "succeeded" && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision))
    && value.effectiveWhen === "next-unbound-turn" && value.secretReturned === false;
}

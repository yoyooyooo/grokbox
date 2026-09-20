import { createHash, timingSafeEqual } from "node:crypto";
import { CAPABILITIES, type ApiErrorCode, type Capability } from "@grokbox/client/contract";

export type AccessGrant = { tokenSha256: string; principalId: string; capabilities: readonly Capability[] };
export type Principal = { id: string; capabilities: readonly Capability[]; credentialSha256?: string };
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpFailure";
  }
}
export function validateGrants(grants: readonly AccessGrant[]): void {
  if (!Array.isArray(grants) || grants.length > 64) throw new HttpFailure(503, "unavailable", "Management access policy is unavailable.");
  const digests = new Set<string>();
  for (const grant of grants) {
    if (!grant || !/^[a-f0-9]{64}$/.test(grant.tokenSha256) || digests.has(grant.tokenSha256)
      || typeof grant.principalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.principalId)
      || !Array.isArray(grant.capabilities) || grant.capabilities.some((capability: unknown) => !CAPABILITIES.includes(capability as Capability))) {
      throw new HttpFailure(503, "unavailable", "Management access policy is invalid.");
    }
    digests.add(grant.tokenSha256);
  }
}
export function authenticate(header: string | undefined, grants: readonly AccessGrant[]): Principal {
  validateGrants(grants);
  const token = /^Bearer ([^\s]{1,8192})$/.exec(header ?? "")?.[1];
  if (!token) throw new HttpFailure(401, "authentication_required", "A management credential is required.");
  const digest = createHash("sha256").update(token).digest();
  let matched: AccessGrant | undefined;
  for (const grant of grants) if (timingSafeEqual(digest, Buffer.from(grant.tokenSha256, "hex"))) matched = grant;
  if (!matched) throw new HttpFailure(401, "authentication_required", "The management credential was rejected.");
  return { id: matched.principalId, capabilities: [...matched.capabilities], credentialSha256: matched.tokenSha256 };
}
export function requireCapability(principal: Principal, capability: Capability): void {
  if (!principal.capabilities.includes(capability)) throw new HttpFailure(403, "permission_denied", "This principal lacks the required capability.", { capability });
}

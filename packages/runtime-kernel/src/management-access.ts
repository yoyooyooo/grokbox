export type ManagedAccessGrant = { grantId: string; principalId: string; tokenSha256: string; capabilities: string[] };
export type AccessChange = { requestId: string; expectedRevision: string; confirmed: true } &
  ({ action: "grant"; grant: ManagedAccessGrant } | { action: "revoke"; grantId: string });
export type AccessReceipt = { requestId: string; revision: string; action: "grant" | "revoke"; grantId: string; committed: true };
export type AccessView = { revision: string; grants: Array<Omit<ManagedAccessGrant, "tokenSha256">>; ownerRevocable: false };

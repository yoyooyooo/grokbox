export type ModelCredentialRequest = {
  requestId: string; expectedRevision: string; modelId: string; piProvider: string; confirmed: true;
};
export type ModelCredentialReceipt = {
  requestId: string; modelId: string; state: "succeeded" | "failed" | "unknown";
  revision: string | null; effectiveWhen: "next-unbound-turn"; secretReturned: false;
};

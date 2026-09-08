export type HostEpoch = {
  compile: string;
  source: string;
  profile: string;
  hostIdentity: string;
  bridgeDigest: string;
  wireVersion: string;
};

export type ServiceEpoch = {
  incarnationId: string;
};

export type SelectionIdentity = {
  agentId: string;
  modelId: string;
  selectionRevision: string;
};

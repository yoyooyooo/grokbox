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

export type ProcessIdentity = {
  pid: number;
  uid: number;
  start: number;
  exe: string;
  cmdline: readonly string[];
  ppid: number;
  ancestry: readonly number[];
};

export type StableProcessIdentity = Pick<ProcessIdentity, "pid" | "uid" | "start" | "exe" | "cmdline">;

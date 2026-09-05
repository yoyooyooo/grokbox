export const DAEMON_PROTOCOL_MAJOR = 1;

export const DAEMON_METHODS = [
  "handshake",
  "health",
  "listAgents",
  "searchAgents",
  "getAgentTranscriptTail",
  "getAgentThread",
  "getAgentMemories",
  "sendPrompt",
  "createAgent",
  "createGroup",
  "updateAgent",
  "setGroupMembers",
  "setAgentNotifyOnUpdates",
  "setAgentHiddenFromSidebar",
  "deleteAgent",
  "fsStat",
  "fsList",
  "fsRead",
  "fsDownloadOpen",
  "fsDownloadChunk",
  "fsDownloadCancel",
  "fsWrite",
  "fsMkdir",
  "fsUploadOpen",
  "fsUploadChunk",
  "fsUploadCommit",
  "fsUploadCancel",
  "fsRemove",
  "fsMutationStatus",
  "jobSubmit",
  "jobList",
  "jobShow",
  "jobLogsRead",
  "jobCancel",
  "eventRead",
  "desktopStatus",
  "desktopKeepAdd",
  "desktopKeepRemove",
  "desktopPrunePlan",
  "desktopPrune",
  "desktopPruneEnable",
  "desktopPruneDisable",
] as const;

export type DaemonMethod = (typeof DAEMON_METHODS)[number];

export const DAEMON_CAPABILITIES = [
  "grok.health.read",
  "grok.roster.read",
  "grok.transcript.read",
  "grok.transcript.write",
  "grok.memory.read",
  "grok.roster.write",
  "grok.events.read",
] as const;

export type DaemonRequest = {
  protocolMajor: number;
  method: DaemonMethod;
  params: Record<string, unknown>;
};

export type DaemonSuccess = {
  ok: true;
  result: unknown;
  gateway?: { pid: number; startedAt: number };
};

export type DaemonFailure = {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
};

export type DaemonResponse = DaemonSuccess | DaemonFailure;

export type DaemonHandshake = {
  protocolMajor: number;
  daemonVersion: string;
  daemonPid: number;
  startedAt: number;
  daemonGeneration: string;
  capabilities: readonly string[];
  filesystemRoots: readonly {
    name: string;
    operations: readonly (
      "stat" | "list" | "read" | "download" |
      "write" | "mkdir" | "upload" | "remove" | "remove-recursive" | "exec"
    )[];
  }[];
  gateway: { pid: number; startedAt: number };
};

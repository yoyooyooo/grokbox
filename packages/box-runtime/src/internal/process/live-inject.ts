import type { Census, ProcessIdentity, ProcessPort } from "./process-port.ts";

export type LiveIdentityResult = {
  ok: boolean;
  recoveryRequired: boolean;
  code?: string;
  diskShaBefore: string;
  diskShaAfter: string;
  census: Census;
  coverage: "none" | "attested" | "window-open";
  hostPid?: number;
  marker?: { mode?: string; transformed?: boolean; modeld?: boolean };
};

export type IdentityChainContext = {
  processes: ProcessPort;
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
  diskSha: () => string;
  roles: () => Array<ProcessIdentity & { role: string }>;
  spawnHost: () => ProcessIdentity;
  readMarker: () => { mode?: string; transformed?: boolean; modeld?: boolean } | undefined;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now: () => number;
  persist?: (host: ProcessIdentity, sha: string) => Promise<void>;
};

const BLOCKED: LiveIdentityResult = {
  ok: false,
  recoveryRequired: false,
  code: "live-host-blocked",
  diskShaBefore: "",
  diskShaAfter: "",
  census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
  coverage: "none",
};

/** Retired fake-tree inject. Does not STOP/TERM/CONT or spawn. */
export async function runIdentityChainInject(_ctx: IdentityChainContext): Promise<LiveIdentityResult> {
  return { ...BLOCKED, code: "legacy-inject-removed" };
}

/** Retired live inject. Does not load h3-live or signal. */
export async function runLiveIdentityInject(_input?: {
  root: string;
  preloadPath: string;
  reviewedProfilePath?: string;
  ephemeralRoot?: string;
}): Promise<LiveIdentityResult> {
  return { ...BLOCKED };
}

export async function runLiveIdentityDeactivate(_input?: { root: string }): Promise<LiveIdentityResult> {
  return { ...BLOCKED };
}

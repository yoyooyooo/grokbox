export const HOST_UPGRADE_RPC_FORBIDDEN = ["updateHostNow", "autoUpdateBoxNow"] as const;

export type HostStatusReader = {
  getHostStatus: () => Promise<unknown>;
};

/** Explicit read-only Gateway capability: status only, never upgrade RPCs. */
export function readOnlyHostStatus(port: HostStatusReader): HostStatusReader {
  return {
    getHostStatus: () => port.getHostStatus(),
  };
}

export function assertNoUpgradeRpc(method: string): void {
  if ((HOST_UPGRADE_RPC_FORBIDDEN as readonly string[]).includes(method)) {
    throw new Error(`read-only Gateway forbids ${method}`);
  }
}

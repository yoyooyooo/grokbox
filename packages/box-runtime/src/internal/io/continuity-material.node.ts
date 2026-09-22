import { botProfile } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure } from "@grokbox/runtime-kernel/continuity";
import type { ContinuityGateway, ContinuityDiscovery } from "./continuity-gateway.node.ts";

export const botProfileRevision = (raw: unknown) => sha256Text(canonicalJson(botProfile(raw)));

/**
 * Reads the current native Bot profile through the qualified Gateway generation.
 * Memory and transcript material are not reconstructed from legacy Gateway RPCs;
 * callers must use the native current-state owner or preserve native_unavailable.
 */
export function nativeMaterialReader(
  gateway: ContinuityGateway,
  check: <A>(r: { result: A; discovery: ContinuityDiscovery }) => A,
  timeoutMs: number,
) {
  const profile = async (agentId: string) => {
    const response = await gateway.listAgents(timeoutMs);
    const matches = check({ result: response.agents, discovery: response.discovery })
      .filter((r: any) => r?.id === agentId && r?.isGroup !== true) as any[];
    if (matches.length !== 1) throw new CurrentStateFailure("source_changed");
    const row = matches[0];
    return botProfile({
      name: row.name,
      description: row.description ?? "",
      title: row.title ?? "",
      avatarShape: row.avatarShape ?? "",
      avatarColor: row.avatarColor ?? "",
    });
  };
  return { profile };
}

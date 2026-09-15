import { composeAgentTitle, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { assignedModelTokens } from "@grokbox/runtime-kernel/selection";
import { loadModelsFileSync } from "./selection.node.ts";

export const HOST_PROFILE_TITLE_SYMBOL = "grokbox.box-runtime.profile-title.v1";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Refresh a showing trailer from last-known harness and models.json. Hidden titles pass through. */
export function bindHostProfileTitle(options: { durableRoot: string }): (input: unknown) => { title: string } | undefined {
  return (input) => {
    try {
      if (!record(input)) return undefined;
      const profile = record(input.profile) ? input.profile : {};
      const parsed = parseAgentTitle(profile.title);
      if (!parsed.showing) return undefined;
      const localHarness = input.localHarness;
      const owner = localHarness === "box" || localHarness === "temporal" ? localHarness : "leave";
      if (owner === "leave") return undefined;
      const agentId = typeof input.agentId === "string" ? input.agentId.toLowerCase() : "";
      const file = loadModelsFileSync(options.durableRoot);
      const token = agentId && file ? assignedModelTokens(file).get(agentId) : undefined;
      const composed = composeAgentTitle(profile.title, {
        type: "sync",
        owner,
        ...(owner === "box" ? { m: token ?? null } : { m: null }),
      });
      if (!composed.changed) return undefined;
      return { title: composed.title };
    } catch {
      return undefined;
    }
  };
}

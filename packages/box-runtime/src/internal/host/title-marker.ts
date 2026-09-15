import { composeAgentTitle, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { assignedModelTokens, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { loadModelsFileSync } from "./selection.node.ts";

export const HOST_PROFILE_TITLE_SYMBOL = "grokbox.box-runtime.profile-title.v1";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assignedModelId(file: ModelsFile, agentId: string): string | undefined {
  const agents = file.assignments.agents;
  if (Object.hasOwn(agents, agentId)) return agents[agentId];
  for (const [id, modelId] of Object.entries(agents)) {
    if (id.toLowerCase() === agentId) return modelId;
  }
  return undefined;
}

/** Compose `m`: string paints, `null` clears, omit/`undefined` preserves a transient miss. */
function syncBoxTitleModel(file: ModelsFile | null, agentId: string): string | null | undefined {
  if (!file || !agentId) return undefined;
  if (assignedModelId(file, agentId) === undefined) return null;
  return assignedModelTokens(file).get(agentId);
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
      const composed = composeAgentTitle(profile.title, {
        type: "sync",
        owner,
        ...(owner === "box" ? { m: syncBoxTitleModel(file, agentId) } : { m: null }),
      });
      if (!composed.changed) return undefined;
      return { title: composed.title };
    } catch {
      return undefined;
    }
  };
}

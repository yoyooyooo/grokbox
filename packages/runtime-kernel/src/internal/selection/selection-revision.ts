import { canonicalJson, sha256Text } from "../../hash.ts";
import { decideRouteSession, modelForAgent, type ModelsFile, type ModelRecord } from "./models.ts";

export function computeSelectionRevision(input: {
  agentId: string;
  model: ModelRecord;
}): string {
  return sha256Text(canonicalJson({
    agentId: input.agentId,
    apiKeyRef: input.model.apiKeyRef,
    capabilities: input.model.capabilities,
    dataTypes: input.model.dataTypes,
    endpoint: input.model.endpoint,
    model: input.model.model,
    modelId: input.model.id,
    provider: input.model.provider,
  }));
}

export type CapturedSelection =
  | { kind: "official" }
  | { kind: "managed"; modelId: string; selectionRevision: string; assignment: "agent" };

/** Host-visible capture. No credential values. Other bots do not enter this revision. */
export function captureManagedSelection(file: ModelsFile, agentId?: string): CapturedSelection {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed" || !agentId) return { kind: "official" };
  const model = modelForAgent(file, agentId);
  if (!model) return { kind: "official" };
  return {
    kind: "managed",
    modelId: decided.modelId,
    assignment: "agent",
    selectionRevision: computeSelectionRevision({ agentId, model }),
  };
}

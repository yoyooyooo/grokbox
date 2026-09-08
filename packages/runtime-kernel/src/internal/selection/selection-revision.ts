import { canonicalJson, sha256Text } from "../../hash.ts";
import type { ModelRecord } from "./models.ts";

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

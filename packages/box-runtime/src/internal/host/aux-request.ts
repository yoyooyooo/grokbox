export const AUX_PURPOSES = ["memory-extraction", "episode"] as const;
export type AuxPurpose = (typeof AUX_PURPOSES)[number];

export type AuxParentBinding = {
  agentId: string;
  turnId: string;
  stepId: string;
  modelId: string;
  selectionRevision: string;
};

export type GrokboxAuxRequest = {
  purpose: AuxPurpose;
  auxRequestId: string;
  parent: AuxParentBinding;
};

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Trusted adapter fact only. Message body is never a purpose source. */
export function grokboxAuxFrom(value: unknown): GrokboxAuxRequest | undefined {
  if (!isRecord(value) || !isRecord(value.grokboxAux)) return undefined;
  const aux = value.grokboxAux;
  if (aux.purpose !== "memory-extraction" && aux.purpose !== "episode") return undefined;
  const auxRequestId = boundedId(aux.auxRequestId);
  if (!auxRequestId) return undefined;
  if (!isRecord(aux.parent)) return undefined;
  const agentId = boundedId(aux.parent.agentId);
  const turnId = boundedId(aux.parent.turnId);
  const stepId = boundedId(aux.parent.stepId);
  const modelId = boundedId(aux.parent.modelId);
  const selectionRevision = boundedId(aux.parent.selectionRevision);
  if (!agentId || !turnId || !stepId || !modelId || !selectionRevision) return undefined;
  if (stepId === auxRequestId) return undefined;
  return {
    purpose: aux.purpose,
    auxRequestId,
    parent: { agentId, turnId, stepId, modelId, selectionRevision },
  };
}

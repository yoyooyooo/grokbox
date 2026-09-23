import { BoxRuntimeError } from "./contract.ts";
import { canonicalJson, sha256Text } from "./hash.ts";
import {
  applyFollowDefault, applyModelDelete, applyModelRecord, applyReset, applyUse,
  assertRouteAssignment, modelReferences, parseModelsFile, parseReasoningPolicy, parseReasoningCapability, requireModel,
  persistModelsDocument, type ModelsFile, type ModelRecord, type ModelCapabilities, type ReasoningCapability, type ReasoningPolicy,
} from "./selection.ts";

export type BotModelSelection = { kind: "native" } | { kind: "default" } | { kind: "model"; modelId: string; reasoning?: ReasoningPolicy };
export type ModelPatch = Partial<Pick<ModelRecord, "provider" | "model" | "endpoint" | "apiKeyRef" | "dataTypes">> & {
  capabilities?: Partial<Omit<ModelCapabilities, "reasoning">> & { reasoning?: ReasoningCapability | null };
  contextWindowTokens?: number | null; chatDialect?: ModelRecord["chatDialect"] | null; alias?: string | null;
};
export type ModelChange =
  | { kind: "bot-selection"; agentId: string; selection: BotModelSelection }
  | { kind: "default-selection"; selection: { modelId: string; reasoning?: ReasoningPolicy } | null }
  | { kind: "model-put"; modelId: string; model: ModelRecord }
  | { kind: "model-patch"; modelId: string; patch: ModelPatch }
  | { kind: "model-delete"; modelId: string };
export type ModelChangeRequest = { requestId: string; expectedRevision: string; change: ModelChange };
export type ModelCaller = { installationId: string; principalId: string };
/** Trusted process-local check; never accepted from client JSON or stored. */
export type ModelPublicationCheck = (signal: AbortSignal) => Promise<void>;
/** Constructed only when the check rejects before physical publication. */
export class ModelPublicationRefused extends Error {
  constructor(readonly reason: unknown) { super("model_publication_refused_before_dispatch"); }
}
export type ModelSnapshot = { models: ModelsFile; revision: string };
export type ModelOperation = {
  version: 1;
  operationRef: string;
  requestId: string;
  command: ModelChange["kind"];
  target: string;
  state: "succeeded" | "unknown";
  beforeRevision: string;
  configRevision: string;
  acceptedAt: string;
  effectiveWhen: "next-turn";
  currentTurn: "unchanged";
  concurrency: "local_serialized";
};
export type ModelOperationLocator = { operationRef: string; requestId: string };
export type ModelOperationKey = ModelOperationLocator & { fingerprint: string };
export type ModelManagementCode = "invalid_input" | "not_found" | "revision_conflict" | "idempotency_conflict" | "operation_unknown"
  | "model_in_use" | "model_default_in_use" | "model_default_missing" | "model_source_read_only" | "store_full" | "unavailable";
export class ModelManagementError extends Error {
  readonly _tag = "ModelManagementError";
  constructor(readonly code: ModelManagementCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ModelManagementError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new ModelManagementError("invalid_input", "Invalid model management request.");
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function modelId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw invalid();
  return value;
}
function selectedModel(value: unknown): { modelId: string; reasoning?: ReasoningPolicy } {
  const input = object(value, ["kind", "modelId", "reasoning"]);
  if (input.kind !== undefined && input.kind !== "model") throw invalid();
  const reasoning = parseReasoningPolicy(input.reasoning);
  return { modelId: modelId(input.modelId), ...(reasoning ? { reasoning } : {}) };
}

function modelInput(id: string, value: unknown): ModelRecord {
  const model = object(value, ["id", "provider", "model", "endpoint", "apiKeyRef", "capabilities", "dataTypes", "contextWindowTokens", "chatDialect", "alias"]);
  if (model.id !== undefined && model.id !== id) throw invalid();
  if (model.capabilities !== undefined) {
    const capabilities = object(model.capabilities, ["vision", "tools", "images", "reasoning"]);
    for (const key of ["vision", "tools", "images"]) if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") throw invalid();
  }
  if (model.dataTypes !== undefined && (!Array.isArray(model.dataTypes) || model.dataTypes.length > 16
    || model.dataTypes.some(type => typeof type !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(type)))) throw invalid();
  if (id !== "stub/echo") {
    for (const key of ["provider", "model", "endpoint", "apiKeyRef"]) {
      if (typeof model[key] !== "string" || !model[key].length || model[key].length > 2048 || /[\x00-\x1f\x7f]/.test(model[key])) throw invalid();
    }
    const endpoint = new URL(model.endpoint as string);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw invalid();
  }
  return parseModelsFile({ version: 3, models: { [id]: model }, assignments: { main: null, agents: {} } }).models[id]!;
}

function patchInput(value: unknown): ModelPatch {
  const patch = object(value, ["provider", "model", "endpoint", "apiKeyRef", "capabilities", "dataTypes", "contextWindowTokens", "chatDialect", "alias"]);
  if (!Object.keys(patch).length) throw invalid();
  for (const field of ["provider", "model", "endpoint", "apiKeyRef"]) {
    const value = patch[field];
    if (value !== undefined && (typeof value !== "string" || !value.length || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) throw invalid();
  }
  if (patch.dataTypes !== undefined && (!Array.isArray(patch.dataTypes) || patch.dataTypes.length > 16
    || patch.dataTypes.some(value => typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)))) throw invalid();
  if (patch.capabilities !== undefined) {
    const capabilities = object(patch.capabilities, ["vision", "tools", "images", "reasoning"]);
    for (const key of ["vision", "tools", "images"]) if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") throw invalid();
    if (capabilities.reasoning !== undefined && capabilities.reasoning !== null) parseReasoningCapability(capabilities.reasoning);
  }
  if (patch.contextWindowTokens !== undefined && patch.contextWindowTokens !== null
    && (typeof patch.contextWindowTokens !== "number" || !Number.isSafeInteger(patch.contextWindowTokens) || patch.contextWindowTokens <= 0)) throw invalid();
  if (patch.chatDialect !== undefined && patch.chatDialect !== null && !["standard", "minimax-inline-v1"].includes(String(patch.chatDialect))) throw invalid();
  if (patch.alias !== undefined && patch.alias !== null && (typeof patch.alias !== "string" || !/^[a-z0-9][a-z0-9._-]{0,15}$/.test(patch.alias))) throw invalid();
  return structuredClone(patch) as ModelPatch;
}

function patchModel(current: ModelsFile, id: string, patch: ModelPatch): ModelsFile {
  const record = requireModel(current, id);
  const { catalog: _catalog, ...base } = record;
  const next: Record<string, unknown> = { ...base, ...patch };
  for (const key of ["alias", "chatDialect", "contextWindowTokens"]) if (next[key] === null) delete next[key];
  if (patch.capabilities !== undefined) {
    const capabilities: Record<string, unknown> = { ...record.capabilities, ...patch.capabilities };
    if (capabilities.reasoning === null) delete capabilities.reasoning;
    next.capabilities = capabilities;
  }
  if (id === "stub/echo" && Object.keys(patch).some(key => key !== "contextWindowTokens")) {
    throw new BoxRuntimeError("invalid_usage", "model_source_read_only");
  }
  return applyModelRecord(current, id, modelInput(id, next));
}

export function parseModelChangeRequest(value: unknown): ModelChangeRequest {
  try {
    const input = object(value, ["requestId", "expectedRevision", "change"]);
    if (typeof input.requestId !== "string" || !UUID.test(input.requestId)
      || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw invalid();
    const change = object(input.change, ["kind", "agentId", "selection", "modelId", "model", "patch"]);
    let parsed: ModelChange;
    switch (change.kind) {
      case "bot-selection": {
        object(change, ["kind", "agentId", "selection"]);
        if (typeof change.agentId !== "string" || !UUID.test(change.agentId)) throw invalid();
        const selection = object(change.selection, ["kind", "modelId", "reasoning"]);
        if (selection.kind === "native" || selection.kind === "default") {
          object(selection, ["kind"]);
          parsed = { kind: change.kind, agentId: change.agentId.toLowerCase(), selection: { kind: selection.kind } };
        } else {
          if (selection.kind !== "model") throw invalid();
          parsed = { kind: change.kind, agentId: change.agentId.toLowerCase(), selection: { kind: "model", ...selectedModel(selection) } };
        }
        break;
      }
      case "default-selection": {
        object(change, ["kind", "selection"]);
        if (change.selection !== null) object(change.selection, ["modelId", "reasoning"]);
        parsed = { kind: change.kind, selection: change.selection === null ? null : selectedModel(change.selection) };
        break;
      }
      case "model-put": {
        object(change, ["kind", "modelId", "model"]);
        const id = modelId(change.modelId);
        parsed = { kind: change.kind, modelId: id, model: modelInput(id, change.model) };
        break;
      }
      case "model-patch":
        object(change, ["kind", "modelId", "patch"]);
        parsed = { kind: change.kind, modelId: modelId(change.modelId), patch: patchInput(change.patch) };
        break;
      case "model-delete":
        object(change, ["kind", "modelId"]);
        parsed = { kind: change.kind, modelId: modelId(change.modelId) };
        break;
      default: throw invalid();
    }
    return { requestId: input.requestId.toLowerCase(), expectedRevision: input.expectedRevision, change: parsed };
  } catch { throw invalid(); }
}

export function modelOperationLocator(caller: ModelCaller, requestId: string): ModelOperationLocator {
  if (!UUID.test(caller.installationId) || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(caller.principalId) || !UUID.test(requestId)) throw invalid();
  const id = requestId.toLowerCase();
  const key = sha256Text(canonicalJson({ installationId: caller.installationId.toLowerCase(), principalId: caller.principalId, requestId: id }));
  return { operationRef: `model-operation:${caller.installationId.toLowerCase()}:${key}`, requestId: id };
}
export function modelOperationKey(caller: ModelCaller, request: ModelChangeRequest): ModelOperationKey {
  return { ...modelOperationLocator(caller, request.requestId), fingerprint: sha256Text(canonicalJson({ version: 1, ...request })) };
}

export function modelConfigurationRevision(models: ModelsFile): string {
  return sha256Text(canonicalJson(models));
}
export function persistedModelsRevision(models: ModelsFile): string {
  return sha256Text(canonicalJson(persistModelsDocument(models)));
}
export function modelChangeTarget(change: ModelChange): string {
  return change.kind === "bot-selection" ? change.agentId : change.kind === "default-selection" ? "default" : change.modelId;
}
export function applyModelChange(current: ModelsFile, change: ModelChange): ModelsFile {
  try {
    if ((change.kind === "model-patch" || change.kind === "model-delete") && change.modelId !== "stub/echo" && !Object.hasOwn(current.models, change.modelId)) {
      throw new ModelManagementError("not_found", "The model is not configured.");
    }
    let next: ModelsFile;
    switch (change.kind) {
      case "bot-selection":
        next = change.selection.kind === "native" ? applyReset(current, change.agentId)
          : change.selection.kind === "default" ? applyFollowDefault(current, change.agentId)
          : applyUse(current, change.selection.modelId, change.agentId, change.selection.reasoning);
        break;
      case "default-selection":
        next = change.selection === null ? applyReset(current) : applyUse(current, change.selection.modelId, undefined, change.selection.reasoning);
        break;
      case "model-put": next = applyModelRecord(current, change.modelId, change.model); break;
      case "model-patch": next = patchModel(current, change.modelId, change.patch); break;
      case "model-delete": next = applyModelDelete(current, change.modelId); break;
    }
    assertRouteAssignment(next);
    return next;
  } catch (error) {
    if (error instanceof ModelManagementError) throw error;
    const reason = error instanceof BoxRuntimeError ? error.message : "invalid_input";
    if (reason === "model_in_use" && change.kind === "model-delete") {
      throw new ModelManagementError(reason, "The model is still referenced.", modelReferences(current, change.modelId));
    }
    if (reason === "model_default_in_use") {
      const followers = Object.entries(current.assignments.agents).filter(([, assignment]) => assignment.modelId === undefined);
      throw new ModelManagementError(reason, "The default still has followers.", {
        agentIds: followers.slice(0, 100).map(([id]) => id), total: followers.length, truncated: followers.length > 100,
      });
    }
    if (reason === "model_default_missing" || reason === "model_source_read_only") throw new ModelManagementError(reason, reason);
    throw invalid();
  }
}

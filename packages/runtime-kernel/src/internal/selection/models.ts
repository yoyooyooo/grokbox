import { BoxRuntimeError } from "../contract/errors.ts";

export type DesiredMode = "disabled" | "observe" | "identity" | "route";

export const STUB_ECHO_MODEL_ID = "stub/echo";

export type ModelCapabilities = {
  vision: boolean;
  tools: boolean;
  images: boolean;
};

export type ModelRecord = {
  id: string;
  provider: string;
  model: string;
  endpoint: string;
  apiKeyRef: string;
  capabilities: ModelCapabilities;
  dataTypes: string[];
  /** Qualified context window for this model/endpoint. Not generation maxTokens. */
  contextWindowTokens?: number;
};

export const STUB_ECHO_MODEL: ModelRecord = {
  id: STUB_ECHO_MODEL_ID,
  provider: "stub",
  model: "echo",
  endpoint: "stub:echo",
  apiKeyRef: "",
  capabilities: { vision: false, tools: false, images: false },
  dataTypes: ["text"],
};

export type ModelsFile = {
  version: 1;
  models: Record<string, ModelRecord>;
  assignments: {
    main: string | null;
    agents: Record<string, string>;
  };
};

export type DesiredFile = {
  version: 1;
  mode: DesiredMode;
};

const EMPTY_MODELS: ModelsFile = {
  version: 1,
  models: {},
  assignments: { main: null, agents: {} },
};

const EMPTY_DESIRED: DesiredFile = { version: 1, mode: "disabled" };

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function parseApiKeyRef(value: string): { kind: "env" | "file"; ref: string } {
  if (value.includes("$")) {
    throw new BoxRuntimeError("credential_invalid", "Secret interpolation with $VAR is not allowed.");
  }
  if (value.startsWith("env:") && value.length > 4 && !value.slice(4).includes(":")) {
    return { kind: "env", ref: value };
  }
  if (value.startsWith("file:")) {
    const path = value.slice("file:".length);
    if (!isAbsolutePath(path)) {
      throw new BoxRuntimeError("credential_invalid", "file: secret references must be absolute paths.");
    }
    return { kind: "file", ref: value };
  }
  throw new BoxRuntimeError(
    "credential_invalid",
    "apiKeyRef must be env:<NAME> or file:/absolute/path; literal secrets are not allowed.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeNetworkEndpoint(endpoint: string): boolean {
  return /^(https?|wss?):/i.test(endpoint);
}

function parseContextWindowTokens(value: unknown, id: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BoxRuntimeError("invalid_usage", `Model '${id}' contextWindowTokens must be a positive safe integer.`);
  }
  return value;
}

/** Pi models.json uses `contextWindow`; grokbox canonical is `contextWindowTokens`. Never guess. */
function parseRecordContextWindowTokens(value: Record<string, unknown>, id: string): number | undefined {
  const tokens = value.contextWindowTokens;
  const alias = value.contextWindow;
  if (tokens === undefined && alias === undefined) return undefined;
  if (tokens !== undefined && alias !== undefined) {
    const parsedTokens = parseContextWindowTokens(tokens, id);
    const parsedAlias = parseContextWindowTokens(alias, id);
    if (parsedTokens !== parsedAlias) {
      throw new BoxRuntimeError(
        "invalid_usage",
        `Model '${id}' contextWindow and contextWindowTokens disagree.`,
      );
    }
    return parsedTokens;
  }
  return parseContextWindowTokens(tokens !== undefined ? tokens : alias, id);
}

/** Trusted adapter window if positive safe int; else canonical record. Never guess from name. */
export function qualifiedContextWindowTokens(record: ModelRecord, adapterWindow?: unknown): number | undefined {
  if (typeof adapterWindow === "number" && Number.isSafeInteger(adapterWindow) && adapterWindow > 0) return adapterWindow;
  if (typeof record.contextWindowTokens === "number" && Number.isSafeInteger(record.contextWindowTokens) && record.contextWindowTokens > 0) {
    return record.contextWindowTokens;
  }
  return undefined;
}

function parseModel(id: string, value: unknown): ModelRecord {
  if (!isRecord(value)) throw new BoxRuntimeError("invalid_usage", `Model '${id}' is invalid.`);
  if (id === STUB_ECHO_MODEL_ID) {
    if (typeof value.apiKeyRef === "string" && value.apiKeyRef.length > 0) {
      throw new BoxRuntimeError("credential_invalid", "stub/echo forbids credential references.");
    }
    if (typeof value.endpoint === "string" && looksLikeNetworkEndpoint(value.endpoint)) {
      throw new BoxRuntimeError("invalid_usage", "stub/echo forbids network endpoints.");
    }
    const stubWindow = parseRecordContextWindowTokens(value, id);
    return stubWindow !== undefined ? { ...STUB_ECHO_MODEL, contextWindowTokens: stubWindow } : STUB_ECHO_MODEL;
  }
  const provider = value.provider;
  const model = value.model;
  const endpoint = value.endpoint;
  const apiKeyRef = value.apiKeyRef;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new BoxRuntimeError("invalid_usage", `Model '${id}' is missing provider.`);
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new BoxRuntimeError("invalid_usage", `Model '${id}' is missing model.`);
  }
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new BoxRuntimeError("invalid_usage", `Model '${id}' is missing endpoint.`);
  }
  if (typeof apiKeyRef !== "string") {
    throw new BoxRuntimeError("invalid_usage", `Model '${id}' is missing apiKeyRef.`);
  }
  parseApiKeyRef(apiKeyRef);
  const capabilitiesRaw = isRecord(value.capabilities) ? value.capabilities : {};
  const capabilities: ModelCapabilities = {
    vision: capabilitiesRaw.vision === true,
    tools: capabilitiesRaw.tools !== false,
    images: capabilitiesRaw.images === true || capabilitiesRaw.vision === true,
  };
  const dataTypes = Array.isArray(value.dataTypes)
    ? value.dataTypes.filter((entry): entry is string => typeof entry === "string")
    : [
        "text",
        ...(capabilities.tools ? ["tools"] : []),
        ...(capabilities.vision || capabilities.images ? ["images"] : []),
      ];
  const contextWindowTokens = parseRecordContextWindowTokens(value, id);
  return {
    id, provider, model, endpoint, apiKeyRef, capabilities, dataTypes,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

export function parseModelsFile(value: unknown): ModelsFile {
  if (value === undefined) return EMPTY_MODELS;
  if (!isRecord(value) || value.version !== 1) {
    throw new BoxRuntimeError("invalid_usage", "models.json must be version 1.");
  }
  if ((value.models !== undefined && !isRecord(value.models)) ||
    (value.assignments !== undefined && !isRecord(value.assignments)) ||
    (isRecord(value.assignments) && value.assignments.agents !== undefined && !isRecord(value.assignments.agents))) {
    throw new BoxRuntimeError("invalid_usage", "models and assignments must be objects.");
  }
  const models: Record<string, ModelRecord> = Object.create(null);
  if (isRecord(value.models)) {
    for (const [id, record] of Object.entries(value.models)) models[id] = parseModel(id, record);
  }
  const assignmentsRaw = isRecord(value.assignments) ? value.assignments : {};
  const main = assignmentsRaw.main === null || assignmentsRaw.main === undefined
    ? null
    : typeof assignmentsRaw.main === "string"
      ? assignmentsRaw.main
      : (() => {
          throw new BoxRuntimeError("invalid_usage", "assignments.main must be a model id or null.");
        })();
  const agents: Record<string, string> = Object.create(null);
  if (isRecord(assignmentsRaw.agents)) {
    for (const [agentId, modelId] of Object.entries(assignmentsRaw.agents)) {
      if (typeof modelId !== "string") {
        throw new BoxRuntimeError("invalid_usage", `assignments.agents.${agentId} must be a model id.`);
      }
      agents[agentId] = modelId;
    }
  }
  return { version: 1, models, assignments: { main, agents } };
}

export function parseDesiredFile(value: unknown): DesiredFile {
  if (value === undefined) return EMPTY_DESIRED;
  if (!isRecord(value) || value.version !== 1) {
    throw new BoxRuntimeError("invalid_usage", "desired.json must be version 1.");
  }
  const mode = value.mode;
  if (mode !== "disabled" && mode !== "observe" && mode !== "identity" && mode !== "route") {
    throw new BoxRuntimeError("invalid_usage", "desired mode must be disabled, observe, identity, or route.");
  }
  return { version: 1, mode };
}

export function parseModelId(value: string): { provider: string; model: string; id: string } {
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) {
    throw new BoxRuntimeError("invalid_usage", "Model id must be provider/model.");
  }
  return { provider: value.slice(0, index), model: value.slice(index + 1), id: value };
}

function stubFromFile(file: ModelsFile): ModelRecord {
  return Object.hasOwn(file.models, STUB_ECHO_MODEL_ID) ? file.models[STUB_ECHO_MODEL_ID]! : STUB_ECHO_MODEL;
}

export function requireModel(file: ModelsFile, id: string): ModelRecord {
  if (id === STUB_ECHO_MODEL_ID) return stubFromFile(file);
  const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
  if (!record) throw new BoxRuntimeError("invalid_usage", `Unknown model '${id}'. Add it to models.json first.`);
  return record;
}

export function assignmentTarget(forAgent?: string): { kind: "main" } | { kind: "agent"; id: string } {
  if (forAgent === undefined || forAgent.length === 0) return { kind: "main" };
  return { kind: "agent", id: forAgent };
}

export function applyUse(file: ModelsFile, modelId: string, forAgent?: string): ModelsFile {
  requireModel(file, modelId);
  if (forAgent === undefined || forAgent.length === 0) {
    return { ...file, assignments: { ...file.assignments, main: modelId } };
  }
  return {
    ...file,
    assignments: { ...file.assignments, agents: { ...file.assignments.agents, [forAgent]: modelId } },
  };
}

export function applyReset(file: ModelsFile, forAgent?: string): ModelsFile {
  if (forAgent === undefined || forAgent.length === 0) {
    return { ...file, assignments: { ...file.assignments, main: null } };
  }
  const agents = { ...file.assignments.agents };
  delete agents[forAgent];
  return { ...file, assignments: { ...file.assignments, agents } };
}

export function assertResetAllowed(desired: DesiredFile, forAgent?: string): void {
  if (desired.mode === "route" && !forAgent) {
    throw new BoxRuntimeError(
      "invalid_usage",
      "Reset of the box default is refused in route mode; use --for <agent-id> for a single Bot's next-turn official selection.",
    );
  }
}

/** Data rule only. Not the OpenAI mapper / SDK codec (T23). */
export function openaiCompatibleAdmitted(record: ModelRecord): boolean {
  if (record.id === STUB_ECHO_MODEL_ID || record.provider === "stub") return false;
  if (record.provider !== "openai" && record.provider !== "openai-chat" && record.provider !== "openai-responses") {
    return false;
  }
  return /^https?:\/\//i.test(record.endpoint) && record.apiKeyRef.length > 0;
}

export function routeModelAdmitted(record: ModelRecord): boolean {
  if (record.id === STUB_ECHO_MODEL_ID) return true;
  return openaiCompatibleAdmitted(record);
}

export type BackendKind = "echo" | "openai-chat" | "openai-responses";

/** Exact kind for registry lookup. Unknown providers fail closed. */
export function backendKindForModel(record: ModelRecord): BackendKind {
  if (record.id === STUB_ECHO_MODEL_ID || record.provider === "stub") return "echo";
  if (record.provider === "openai-responses") return "openai-responses";
  if (record.provider === "openai" || record.provider === "openai-chat") return "openai-chat";
  throw new BoxRuntimeError("invalid_usage", "Unknown backend kind.");
}

function assignedModelIds(file: ModelsFile): string[] {
  const ids: string[] = [];
  if (file.assignments.main) ids.push(file.assignments.main);
  ids.push(...Object.values(file.assignments.agents));
  return ids;
}

export function routeHasNonStubAssignment(file: ModelsFile): boolean {
  for (const id of assignedModelIds(file)) {
    if (id === STUB_ECHO_MODEL_ID) continue;
    const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
    if (!record || !openaiCompatibleAdmitted(record)) return true;
  }
  return false;
}

export function assertStubOnlyRouteAssignments(file: ModelsFile): void {
  for (const id of assignedModelIds(file)) {
    if (id === STUB_ECHO_MODEL_ID) continue;
    const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
    if (!record || !openaiCompatibleAdmitted(record)) {
      throw new BoxRuntimeError("invalid_usage", "route admits only stub/echo or openai* in this slice.");
    }
  }
}

export function assertRouteAssignment(file: ModelsFile): void {
  assertStubOnlyRouteAssignments(file);
  if (file.assignments.main) requireModel(file, file.assignments.main);
}

export function disclosure(file: ModelsFile, modelId: string, forAgent?: string) {
  const record = requireModel(file, modelId);
  const target = assignmentTarget(forAgent);
  return {
    model: record.id,
    provider: record.provider,
    endpoint: record.endpoint,
    dataTypes: record.dataTypes,
    takesEffect: "next_user_turn",
    blastRadius: target.kind === "main" ? "box_default" : "single_bot",
    assignment: target.kind === "main" ? "main" : { agent: target.id },
  };
}

export function resolveAssignment(file: ModelsFile, agentId?: string): ModelRecord {
  const id = agentId && Object.hasOwn(file.assignments.agents, agentId) ? file.assignments.agents[agentId] : file.assignments.main;
  if (!id) {
    throw new BoxRuntimeError("invalid_usage", "No assignments.main; modeld pin requires a managed model id.");
  }
  return requireModel(file, id);
}

export type RouteSessionDecision =
  | { kind: "official" }
  | { kind: "managed"; modelId: string; assignment: "agent" };

export function decideRouteSession(file: ModelsFile, agentId?: string): RouteSessionDecision {
  if (!agentId || !Object.hasOwn(file.assignments.agents, agentId)) return { kind: "official" };
  const id = file.assignments.agents[agentId]!;
  const record = id === STUB_ECHO_MODEL_ID ? stubFromFile(file) : Object.hasOwn(file.models, id) ? file.models[id] : undefined;
  if (!record || !routeModelAdmitted(record)) {
    throw new BoxRuntimeError("invalid_usage", "route admits only stub/echo or openai* in this slice.");
  }
  return { kind: "managed", modelId: record.id, assignment: "agent" };
}

export function resolveRouteSessionModel(file: ModelsFile, agentId?: string): { modelId: string; assignment: "agent" } {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed") {
    throw new BoxRuntimeError("invalid_usage", "unassigned route session is official passthrough, not a managed modelId.");
  }
  return { modelId: decided.modelId, assignment: decided.assignment };
}

export function modelForAgent(file: ModelsFile, agentId: string): ModelRecord | undefined {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed") return undefined;
  if (decided.modelId === STUB_ECHO_MODEL_ID) return stubFromFile(file);
  return Object.hasOwn(file.models, decided.modelId) ? file.models[decided.modelId] : undefined;
}

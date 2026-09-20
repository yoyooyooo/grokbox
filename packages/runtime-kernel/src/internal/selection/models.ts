import { BoxRuntimeError } from "../contract/errors.ts";
import { assertReasoningSupported, parseReasoningCapability, parseReasoningPolicy, type ReasoningCapability, type ReasoningPolicy } from "./reasoning.ts";
import {
  adaptPiCatalog,
  catalogWantsPi,
  PI_PROVIDER_NAME_PATTERN,
  PI_PROVIDER_REF_PREFIX,
  piModelsPathCandidates,
  type ExternalCatalogEntry,
} from "./pi-catalog.ts";

export type DesiredMode = "disabled" | "observe" | "identity" | "route";

export const STUB_ECHO_MODEL_ID = "stub/echo";

export type ModelCapabilities = {
  vision: boolean;
  tools: boolean;
  images: boolean;
  reasoning?: ReasoningCapability;
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
  /** Explicit Chat protocol dialect; absent uses narrowly qualified endpoint defaults. */
  chatDialect?: "standard" | "minimax-inline-v1";
  /** Short App Label token for `m=`. Unique among models when set. */
  alias?: string;
  /** Set on records adapted from externalCatalog. Never persisted. */
  catalog?: "pi";
};

export const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,15}$/;

export const STUB_ECHO_MODEL: ModelRecord = {
  id: STUB_ECHO_MODEL_ID,
  provider: "stub",
  model: "echo",
  endpoint: "stub:echo",
  apiKeyRef: "",
  capabilities: { vision: false, tools: false, images: false },
  dataTypes: ["text"],
};

/** A catalog identity plus per-Bot policy, never a derived catalog model. */
export type ModelAssignment = { modelId: string; reasoning?: ReasoningPolicy };
export type BotModelAssignment = ModelAssignment | { kind: "default"; modelId?: never; reasoning?: never };
/** Runtime-only immutable snapshot. reasoning is never a catalog record field. */
export type ResolvedModelSelection = ModelRecord & { reasoning?: ReasoningPolicy };

export type ModelsFile = {
  version: 3;
  models: Record<string, ModelRecord>;
  assignments: {
    main: ModelAssignment | null;
    agents: Record<string, BotModelAssignment>;
  };
  externalCatalog?: ExternalCatalogEntry[];
  credentials?: Record<string, string>;
};

export type DesiredFile = {
  version: 1;
  mode: DesiredMode;
};

const EMPTY_MODELS: ModelsFile = {
  version: 3,
  models: {},
  assignments: { main: null, agents: {} },
};

const EMPTY_DESIRED: DesiredFile = { version: 1, mode: "disabled" };

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function parseApiKeyRef(value: string): { kind: "env" | "file" | "pi-provider"; ref: string } {
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
  if (value.startsWith(PI_PROVIDER_REF_PREFIX)) {
    const name = value.slice(PI_PROVIDER_REF_PREFIX.length);
    if (!PI_PROVIDER_NAME_PATTERN.test(name)) {
      throw new BoxRuntimeError("credential_invalid", "pi-provider: references must use a Pi provider name.");
    }
    return { kind: "pi-provider", ref: value };
  }
  throw new BoxRuntimeError(
    "credential_invalid",
    "apiKeyRef must be env:<NAME>, file:/absolute/path, or pi-provider:<name>; literal secrets are not allowed.",
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

function exactFields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new BoxRuntimeError("invalid_usage", `Unknown field in ${where}; refusing a lossy configuration read/write.`);
  }
}

function parseModel(id: string, value: unknown): ModelRecord {
  if (!isRecord(value)) throw new BoxRuntimeError("invalid_usage", `Model '${id}' is invalid.`);
  exactFields(value, ["id", "provider", "model", "endpoint", "apiKeyRef", "capabilities", "dataTypes", "contextWindowTokens", "contextWindow", "chatDialect", "alias", "catalog"], "model record");
  if (isRecord(value.capabilities)) exactFields(value.capabilities, ["vision", "tools", "images", "reasoning"], "model capabilities");
  if (id === STUB_ECHO_MODEL_ID) {
    if (isRecord(value.capabilities) && value.capabilities.reasoning !== undefined && value.capabilities.reasoning !== false) {
      throw new BoxRuntimeError("invalid_usage", "stub/echo cannot declare reasoning efforts.");
    }
    if (value.chatDialect !== undefined) throw new BoxRuntimeError("invalid_usage", "chatDialect requires Chat Completions.");
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
  const reasoning = parseReasoningCapability(capabilitiesRaw.reasoning);
  const capabilities: ModelCapabilities = {
    ...(reasoning !== undefined ? { reasoning } : {}),
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
  const chatDialect = value.chatDialect;
  if (chatDialect !== undefined && (chatDialect !== "standard" && chatDialect !== "minimax-inline-v1")) throw new BoxRuntimeError("invalid_usage", "Unsupported Chat dialect.");
  if (chatDialect !== undefined && provider !== "openai" && provider !== "openai-chat") throw new BoxRuntimeError("invalid_usage", "chatDialect requires Chat Completions.");
  const aliasRaw = value.alias;
  let alias: string | undefined;
  if (aliasRaw !== undefined) {
    if (typeof aliasRaw !== "string" || !MODEL_ALIAS_PATTERN.test(aliasRaw)) {
      throw new BoxRuntimeError("invalid_usage", `Model '${id}' alias must be 1-16 chars in [a-z0-9._-], starting with a letter or digit.`);
    }
    alias = aliasRaw;
  }
  return {
    id, provider, model, endpoint, apiKeyRef, capabilities, dataTypes,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(alias !== undefined ? { alias } : {}),
    ...(chatDialect !== undefined ? { chatDialect } : {}),
  };
}

export function parseModelsFile(value: unknown): ModelsFile {
  if (value === undefined) return structuredClone(EMPTY_MODELS);
  if (!isRecord(value) || ![1, 2, 3].includes(value.version as number)) {
    throw new BoxRuntimeError("invalid_usage", "models.json must be version 3; versions 1 and 2 are import inputs.");
  }
  exactFields(value, ["version", "models", "assignments", "externalCatalog", "credentials"], "models.json");
  if ((value.models !== undefined && !isRecord(value.models)) ||
    (value.assignments !== undefined && !isRecord(value.assignments)) ||
    (isRecord(value.assignments) && value.assignments.agents !== undefined && !isRecord(value.assignments.agents))) {
    throw new BoxRuntimeError("invalid_usage", "models and assignments must be objects.");
  }
  const models: Record<string, ModelRecord> = Object.create(null);
  if (isRecord(value.models)) {
    const aliases = new Map<string, string>();
    for (const [id, record] of Object.entries(value.models)) {
      const parsed = parseModel(id, record);
      if (parsed.alias !== undefined) {
        const prior = aliases.get(parsed.alias);
        if (prior !== undefined) {
          throw new BoxRuntimeError("invalid_usage", `Model alias '${parsed.alias}' is used by '${prior}' and '${id}'.`);
        }
        aliases.set(parsed.alias, id);
      }
      models[id] = parsed;
    }
  }
  const externalCatalog = parseExternalCatalog(value.externalCatalog);
  const credentials = parseCatalogCredentials(value.credentials);
  const assignmentsRaw = isRecord(value.assignments) ? value.assignments : {};
  exactFields(assignmentsRaw, ["main", "agents"], "assignments");
  const parseAssignment = (entry: unknown): ModelAssignment => {
    if (value.version === 1) {
      if (typeof entry !== "string" || !entry.length) throw new BoxRuntimeError("invalid_usage", "Version 1 assignments must be nonempty model ids.");
      return { modelId: entry };
    }
    if (!isRecord(entry)) throw new BoxRuntimeError("invalid_usage", "Assignments must be modelId/reasoning objects.");
    exactFields(entry, ["modelId", "reasoning"], "model assignment");
    if (typeof entry.modelId !== "string" || !entry.modelId.length) throw new BoxRuntimeError("invalid_usage", "An assignment requires a nonempty modelId.");
    const reasoning = parseReasoningPolicy(entry.reasoning);
    return { modelId: entry.modelId, ...(reasoning ? { reasoning } : {}) };
  };
  const main = assignmentsRaw.main === null || assignmentsRaw.main === undefined ? null : parseAssignment(assignmentsRaw.main);
  const agents: Record<string, BotModelAssignment> = Object.create(null);
  if (isRecord(assignmentsRaw.agents)) {
    for (const [agentId, assignment] of Object.entries(assignmentsRaw.agents)) {
      if (value.version === 3 && isRecord(assignment) && assignment.kind === "default") {
        exactFields(assignment, ["kind"], "default model selection");
        if (!main) throw new BoxRuntimeError("invalid_usage", "model_default_missing");
        agents[agentId] = { kind: "default" };
      } else agents[agentId] = parseAssignment(assignment);
    }
  }
  return {
    version: 3,
    models,
    assignments: { main, agents },
    ...(externalCatalog.length > 0 ? { externalCatalog } : {}),
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}

function parseExternalCatalog(value: unknown): ExternalCatalogEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new BoxRuntimeError("invalid_usage", "externalCatalog must be a short array.");
  }
  return value.map((entry, index) => {
    if (entry === "pi") return "pi";
    if (!isRecord(entry) || entry.id !== "pi") {
      throw new BoxRuntimeError("invalid_usage", `externalCatalog[${index}] must be "pi".`);
    }
    if (entry.modelsPath !== undefined) {
      if (typeof entry.modelsPath !== "string" || !isAbsolutePath(entry.modelsPath)) {
        throw new BoxRuntimeError("invalid_usage", "Pi modelsPath must be an absolute path.");
      }
    }
    return { id: "pi" as const, ...(typeof entry.modelsPath === "string" ? { modelsPath: entry.modelsPath } : {}) };
  });
}

function parseCatalogCredentials(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BoxRuntimeError("invalid_usage", "credentials must be an object.");
  const out: Record<string, string> = Object.create(null);
  for (const [provider, ref] of Object.entries(value)) {
    if (typeof ref !== "string") {
      throw new BoxRuntimeError("invalid_usage", `credentials.${provider} must be env: or file:.`);
    }
    const parsed = parseApiKeyRef(ref);
    if (parsed.kind !== "env" && parsed.kind !== "file") {
      throw new BoxRuntimeError("invalid_usage", `credentials.${provider} must be env: or file:.`);
    }
    out[provider] = ref;
  }
  return out;
}

/** Disk document: assignments, catalog pointer, credentials, local models. Strips Pi-adapted records. */
export function persistModelsDocument(file: ModelsFile): {
  version: 3;
  models: Record<string, ModelRecord>;
  assignments: ModelsFile["assignments"];
  externalCatalog?: ExternalCatalogEntry[];
  credentials?: Record<string, string>;
} {
  const models: Record<string, ModelRecord> = Object.create(null);
  for (const [id, record] of Object.entries(file.models)) {
    if (record.catalog === "pi") continue;
    const { catalog: _catalog, ...rest } = record;
    models[id] = rest;
  }
  return {
    version: 3,
    models,
    assignments: file.assignments,
    ...(file.externalCatalog && file.externalCatalog.length > 0 ? { externalCatalog: file.externalCatalog } : {}),
    ...(file.credentials && Object.keys(file.credentials).length > 0 ? { credentials: file.credentials } : {}),
  };
}

/** Merge Pi providers into models. Local records win on id. Does not read the filesystem. */
export function resolveExternalCatalog(file: ModelsFile, input: {
  pi?: unknown;
}): ModelsFile {
  if (!file.externalCatalog || !catalogWantsPi(file.externalCatalog)) return file;
  if (input.pi === undefined) {
    throw new BoxRuntimeError("invalid_usage", "Pi models.json was not found for externalCatalog pi.");
  }
  const adapted = adaptPiCatalog(input.pi, file.credentials ?? {});
  return { ...file, models: { ...adapted, ...file.models } };
}

/** Discover and merge Pi. `read` returns undefined when the path is missing. */
export function resolveModelsWithPi(file: ModelsFile, input: {
  homedir: string;
  env: Record<string, string | undefined>;
  read: (path: string) => unknown | undefined;
}): ModelsFile {
  if (!file.externalCatalog || !catalogWantsPi(file.externalCatalog)) return file;
  const candidates = piModelsPathCandidates({
    catalog: file.externalCatalog,
    homedir: input.homedir,
    env: input.env,
  });
  for (const path of candidates) {
    const pi = input.read(path);
    if (pi !== undefined) return resolveExternalCatalog(file, { pi });
  }
  throw new BoxRuntimeError("invalid_usage", "Pi models.json was not found for externalCatalog pi.");
}

export function assignedModelAliases(file: ModelsFile): Map<string, string> {
  return assignedModelTokens(file, "alias-only");
}

const LABEL_TOKEN = /^[A-Za-z0-9._:/-]+$/;

/** Label `m=` token: alias if set, otherwise the short `model` field when it fits. */
export function assignedModelTokens(file: ModelsFile, mode: "alias-only" | "alias-or-model" = "alias-or-model"): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const agentId of Object.keys(file.assignments.agents)) {
    const assignment = assignmentForBot(file, agentId)!;
    const record = Object.hasOwn(file.models, assignment.modelId) ? file.models[assignment.modelId] : undefined;
    if (!record) continue;
    const token = record.alias ?? (mode === "alias-or-model" && LABEL_TOKEN.test(record.model) ? record.model : undefined);
    if (token !== undefined) tokens.set(agentId.toLowerCase(), token);
  }
  return tokens;
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

export function applyUse(file: ModelsFile, modelId: string, forAgent?: string, reasoning?: ReasoningPolicy): ModelsFile {
  const record = requireModel(file, modelId);
  const policy = parseReasoningPolicy(reasoning);
  assertReasoningSupported(record, policy);
  const assignment: ModelAssignment = { modelId, ...(policy ? { reasoning: policy } : {}) };
  if (forAgent === undefined || forAgent.length === 0) {
    return { ...file, assignments: { ...file.assignments, main: assignment } };
  }
  return {
    ...file,
    assignments: { ...file.assignments, agents: { ...file.assignments.agents, [forAgent]: assignment } },
  };
}

export function applyReset(file: ModelsFile, forAgent?: string): ModelsFile {
  if (forAgent === undefined || forAgent.length === 0) {
    const followers = Object.values(file.assignments.agents).some(assignment => assignment.modelId === undefined);
    if (followers) throw new BoxRuntimeError("invalid_usage", "model_default_in_use");
    return { ...file, assignments: { ...file.assignments, main: null } };
  }
  const agents = { ...file.assignments.agents };
  delete agents[forAgent];
  return { ...file, assignments: { ...file.assignments, agents } };
}

export function assignmentForBot(file: ModelsFile, agentId: string): ModelAssignment | undefined {
  if (!Object.hasOwn(file.assignments.agents, agentId)) return undefined;
  const assignment = file.assignments.agents[agentId]!;
  if (assignment.modelId !== undefined) return assignment;
  if (!file.assignments.main) throw new BoxRuntimeError("invalid_usage", "model_default_missing");
  return file.assignments.main;
}

export function applyFollowDefault(file: ModelsFile, agentId: string): ModelsFile {
  if (!agentId) throw new BoxRuntimeError("invalid_usage", "A default follower requires a Bot ID.");
  if (!file.assignments.main) throw new BoxRuntimeError("invalid_usage", "model_default_missing");
  resolveModelSelection(file, file.assignments.main);
  return { ...file, assignments: { ...file.assignments, agents: { ...file.assignments.agents, [agentId]: { kind: "default" } } } };
}

export function modelReferences(file: ModelsFile, modelId: string, limit = 100) {
  const references: Array<{ kind: "default" } | { kind: "bot"; agentId: string; selection: "model" | "default" }> = [];
  if (file.assignments.main?.modelId === modelId) references.push({ kind: "default" });
  for (const [agentId, selection] of Object.entries(file.assignments.agents)) {
    if (assignmentForBot(file, agentId)?.modelId === modelId) {
      references.push({ kind: "bot", agentId, selection: selection.modelId === undefined ? "default" : "model" });
    }
  }
  const bound = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 100));
  return { references: references.slice(0, bound), total: references.length, truncated: references.length > bound };
}

export function applyModelDelete(file: ModelsFile, modelId: string): ModelsFile {
  const record = requireModel(file, modelId);
  if (modelReferences(file, modelId).total) throw new BoxRuntimeError("invalid_usage", "model_in_use");
  if (record.catalog === "pi" || modelId === STUB_ECHO_MODEL_ID) throw new BoxRuntimeError("invalid_usage", "model_source_read_only");
  const models = { ...file.models };
  delete models[modelId];
  return { ...file, models };
}

export function applyModelRecord(file: ModelsFile, modelId: string, input: unknown): ModelsFile {
  const record = parseModel(modelId, input);
  if (record.alias && Object.values(file.models).some(other => other.id !== modelId && other.alias === record.alias)) {
    throw new BoxRuntimeError("invalid_usage", "Model alias is already in use.");
  }
  const next = { ...file, models: { ...file.models, [modelId]: record } };
  if (next.assignments.main?.modelId === modelId) resolveModelSelection(next, next.assignments.main);
  for (const agentId of Object.keys(next.assignments.agents)) {
    const assignment = assignmentForBot(next, agentId)!;
    if (assignment.modelId === modelId) resolveModelSelection(next, assignment);
  }
  return next;
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
  if (file.assignments.main) ids.push(file.assignments.main.modelId);
  ids.push(...Object.keys(file.assignments.agents).map(agentId => assignmentForBot(file, agentId)!.modelId));
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

export const ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE = "route_model_not_admitted";
export const ROUTE_MODEL_NOT_ADMITTED_MESSAGE = "route admits only stub/echo or openai* in this slice.";

function routeModelNotAdmitted(): never {
  throw new BoxRuntimeError("invalid_usage", ROUTE_MODEL_NOT_ADMITTED_MESSAGE, {
    failureCode: ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
  });
}

export function assertStubOnlyRouteAssignments(file: ModelsFile): void {
  for (const id of assignedModelIds(file)) {
    if (id === STUB_ECHO_MODEL_ID) continue;
    const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
    if (!record || !openaiCompatibleAdmitted(record)) routeModelNotAdmitted();
  }
}

export function assertRouteAssignment(file: ModelsFile): void {
  assertStubOnlyRouteAssignments(file);
  if (file.assignments.main) resolveModelSelection(file, file.assignments.main);
  for (const agentId of Object.keys(file.assignments.agents)) resolveModelSelection(file, assignmentForBot(file, agentId)!);
}

export function disclosure(file: ModelsFile, modelId: string, forAgent?: string) {
  const record = requireModel(file, modelId);
  const target = assignmentTarget(forAgent);
  const assignment = forAgent ? assignmentForBot(file, forAgent) : file.assignments.main;
  return {
    reasoning: { requested: assignment?.reasoning?.effort ?? "default", providerReported: "unknown" },
    reasoningCapability: record.capabilities.reasoning ?? "unknown",
    modelsSchemaVersion: 3,
    model: record.id,
    provider: record.provider,
    endpoint: record.endpoint,
    dataTypes: record.dataTypes,
    takesEffect: "next_user_turn",
    blastRadius: target.kind === "main" ? "box_default" : "single_bot",
    assignment: target.kind === "main" ? "main" : { agent: target.id },
  };
}

/** Detach the whole selected record before TURN admission; later config edits
 * cannot mutate endpoint, capability whitelist or effort inside this snapshot. */
export function resolveModelSelection(file: ModelsFile, assignment: ModelAssignment): ResolvedModelSelection {
  const record = requireModel(file, assignment.modelId);
  const reasoning = parseReasoningPolicy(assignment.reasoning);
  assertReasoningSupported(record, reasoning);
  const resolved: ResolvedModelSelection = structuredClone({ ...record, ...(reasoning ? { reasoning } : {}) });
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(resolved);
  return resolved;
}

export function resolveAssignment(file: ModelsFile, agentId?: string): ResolvedModelSelection {
  const assignment = agentId && Object.hasOwn(file.assignments.agents, agentId) ? assignmentForBot(file, agentId) : file.assignments.main;
  if (!assignment) throw new BoxRuntimeError("invalid_usage", "No assignments.main; modeld pin requires a managed model id.");
  return resolveModelSelection(file, assignment);
}

export type RouteSessionDecision =
  | { kind: "official" }
  | { kind: "managed"; modelId: string; assignment: "agent" };

export function decideRouteSession(file: ModelsFile, agentId?: string): RouteSessionDecision {
  if (!agentId || !Object.hasOwn(file.assignments.agents, agentId)) return { kind: "official" };
  const assignment = assignmentForBot(file, agentId)!;
  const id = assignment.modelId;
  const record = id === STUB_ECHO_MODEL_ID ? stubFromFile(file) : Object.hasOwn(file.models, id) ? file.models[id] : undefined;
  if (!record || !routeModelAdmitted(record)) routeModelNotAdmitted();
  assertReasoningSupported(record, assignment.reasoning);
  return { kind: "managed", modelId: record.id, assignment: "agent" };
}

export function resolveRouteSessionModel(file: ModelsFile, agentId?: string): { modelId: string; assignment: "agent" } {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed") {
    throw new BoxRuntimeError("invalid_usage", "unassigned route session is official passthrough, not a managed modelId.");
  }
  return { modelId: decided.modelId, assignment: decided.assignment };
}

export function modelForAgent(file: ModelsFile, agentId: string): ResolvedModelSelection | undefined {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed") return undefined;
  return resolveModelSelection(file, assignmentForBot(file, agentId)!);
}

export function assignedReasoningEfforts(file: ModelsFile): Map<string, string> {
  return new Map(Object.keys(file.assignments.agents).flatMap(id => {
    const selection = assignmentForBot(file, id)!;
    return selection.reasoning ? [[id.toLowerCase(), selection.reasoning.effort]] : [];
  }));
}

/** Revalidate a durable TURN snapshot without consulting today's assignments.
 * The serialized policy and capability whitelist must survive cold restoration. */
export function parseResolvedModelSelection(value: unknown): ResolvedModelSelection {
  if (!isRecord(value) || typeof value.id !== "string") throw new BoxRuntimeError("invalid_usage", "Invalid resolved model snapshot.");
  const { reasoning, ...raw } = value;
  const model = parseModel(value.id, raw);
  if (raw.catalog === "pi") model.catalog = "pi";
  return resolveModelSelection({ version: 3, models: { [model.id]: model }, assignments: { main: null, agents: {} } },
    { modelId: model.id, ...(reasoning !== undefined ? { reasoning: parseReasoningPolicy(reasoning) } : {}) });
}

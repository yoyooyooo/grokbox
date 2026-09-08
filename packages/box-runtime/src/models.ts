import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { BoxRuntimeError } from "./errors.ts";
import { openAiAccepts } from "./modeld-openai-map.ts";
import { OBSERVATION_MAX_BYTES } from "./observation.ts";
import { desiredPath, modelsPath, resolveDurableRoot } from "./paths.ts";

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

export function parseApiKeyRef(value: string): { kind: "env" | "file"; ref: string } {
  if (value.includes("$")) {
    throw new BoxRuntimeError("credential_invalid", "Secret interpolation with $VAR is not allowed.");
  }
  if (value.startsWith("env:") && value.length > 4 && !value.slice(4).includes(":")) {
    return { kind: "env", ref: value };
  }
  if (value.startsWith("file:")) {
    const path = value.slice("file:".length);
    if (!isAbsolute(path)) {
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

function parseModel(id: string, value: unknown): ModelRecord {
  if (!isRecord(value)) throw new BoxRuntimeError("invalid_usage", `Model '${id}' is invalid.`);
  if (id === STUB_ECHO_MODEL_ID) {
    if (typeof value.apiKeyRef === "string" && value.apiKeyRef.length > 0) {
      throw new BoxRuntimeError("credential_invalid", "stub/echo forbids credential references.");
    }
    if (typeof value.endpoint === "string" && looksLikeNetworkEndpoint(value.endpoint)) {
      throw new BoxRuntimeError("invalid_usage", "stub/echo forbids network endpoints.");
    }
    return STUB_ECHO_MODEL;
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
  return { id, provider, model, endpoint, apiKeyRef, capabilities, dataTypes };
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type RuntimeStore = {
  root: string;
  loadModels: () => Promise<ModelsFile>;
  loadDesired: () => Promise<DesiredFile>;
  saveModels: (file: ModelsFile) => Promise<void>;
  saveDesired: (file: DesiredFile) => Promise<void>;
};

export function openRuntimeStore(rootOverride?: string, env?: NodeJS.Dict<string>): RuntimeStore {
  const root = resolveDurableRoot(rootOverride, env);
  return {
    root,
    loadModels: async () => parseModelsFile(await readJson(modelsPath(root))),
    loadDesired: async () => parseDesiredFile(await readJson(desiredPath(root))),
    saveModels: async (file) => await writeJsonAtomic(modelsPath(root), file),
    saveDesired: async (file) => await writeJsonAtomic(desiredPath(root), file),
  };
}

export function parseModelId(value: string): { provider: string; model: string; id: string } {
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) {
    throw new BoxRuntimeError("invalid_usage", "Model id must be provider/model.");
  }
  return { provider: value.slice(0, index), model: value.slice(index + 1), id: value };
}

export function requireModel(file: ModelsFile, id: string): ModelRecord {
  if (id === STUB_ECHO_MODEL_ID) return STUB_ECHO_MODEL;
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

export function assertResetAllowed(desired: DesiredFile): void {
  if (desired.mode === "route") {
    throw new BoxRuntimeError(
      "invalid_usage",
      "models reset is refused while desired mode is route; deactivate or activate identity first.",
    );
  }
}

export function routeModelAdmitted(record: ModelRecord): boolean {
  if (record.id === STUB_ECHO_MODEL_ID) return true;
  return openAiAccepts(record);
}

function assignedModelIds(file: ModelsFile): string[] {
  const ids: string[] = [];
  if (file.assignments.main) ids.push(file.assignments.main);
  ids.push(...Object.values(file.assignments.agents));
  return ids;
}

/** True when any assignment is neither stub/echo nor an openai* record `openAiAccepts` would admit. */
export function routeHasNonStubAssignment(file: ModelsFile): boolean {
  for (const id of assignedModelIds(file)) {
    if (id === STUB_ECHO_MODEL_ID) continue;
    const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
    if (!record || !openAiAccepts(record)) return true;
  }
  return false;
}

export function assertStubOnlyRouteAssignments(file: ModelsFile): void {
  for (const id of assignedModelIds(file)) {
    if (id === STUB_ECHO_MODEL_ID) continue;
    const record = Object.hasOwn(file.models, id) ? file.models[id] : undefined;
    if (!record || !openAiAccepts(record)) {
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

/** Selective route: only `assignments.agents[agentId]` opts into modeld. Missing override is official passthrough. `main` is not a session fallback. */
export type RouteSessionDecision =
  | { kind: "official" }
  | { kind: "managed"; modelId: string; assignment: "agent" };

export function decideRouteSession(file: ModelsFile, agentId?: string): RouteSessionDecision {
  if (!agentId || !Object.hasOwn(file.assignments.agents, agentId)) return { kind: "official" };
  const id = file.assignments.agents[agentId]!;
  const record = id === STUB_ECHO_MODEL_ID ? STUB_ECHO_MODEL : Object.hasOwn(file.models, id) ? file.models[id] : undefined;
  if (!record || !routeModelAdmitted(record)) {
    throw new BoxRuntimeError("invalid_usage", "route admits only stub/echo or openai* in this slice.");
  }
  return { kind: "managed", modelId: record.id, assignment: "agent" };
}

/** Bounded no-follow regular-file read for preload/hook. Never mkdir or repair. */
export function loadModelsFileSync(root: string): ModelsFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(modelsPath(root), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > OBSERVATION_MAX_BYTES) return null;
    const bytes = Buffer.alloc(OBSERVATION_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > OBSERVATION_MAX_BYTES) return null;
    return parseModelsFile(JSON.parse(bytes.subarray(0, n).toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function resolveRouteSessionModel(file: ModelsFile, agentId?: string): { modelId: string; assignment: "agent" } {
  const decided = decideRouteSession(file, agentId);
  if (decided.kind !== "managed") {
    throw new BoxRuntimeError("invalid_usage", "unassigned route session is official passthrough, not a managed modelId.");
  }
  return { modelId: decided.modelId, assignment: decided.assignment };
}

export function secretsDir(root: string): string {
  return join(root, "secrets");
}

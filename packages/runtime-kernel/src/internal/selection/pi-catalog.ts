import { BoxRuntimeError } from "../contract/errors.ts";
import type { ModelCapabilities, ModelRecord } from "./models.ts";

const PI_API_TO_PROVIDER = {
  "openai-responses": "openai-responses",
  "openai-completions": "openai-chat",
} as const;

export type ExternalCatalogId = "pi";
export type ExternalCatalogEntry = ExternalCatalogId | { id: ExternalCatalogId; modelsPath?: string };

export const PI_PROVIDER_REF_PREFIX = "pi-provider:";
export const PI_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type PiProviderApiKeyLookup =
  | { kind: "string"; value: string }
  | { kind: "command-form" }
  | { kind: "unavailable" };

export function piProviderApiKeyRef(providerName: string): string | undefined {
  if (!PI_PROVIDER_NAME_PATTERN.test(providerName)) return undefined;
  return `${PI_PROVIDER_REF_PREFIX}${providerName}`;
}

/** Trimmed string bearer, command-form, or missing. Never executes `!/` keys. */
export function lookupPiProviderApiKey(pi: unknown, providerName: string): PiProviderApiKeyLookup {
  if (!isRecord(pi) || !isRecord(pi.providers) || !Object.hasOwn(pi.providers, providerName)) {
    return { kind: "unavailable" };
  }
  const provider = pi.providers[providerName];
  if (!isRecord(provider)) return { kind: "unavailable" };
  return reusablePiApiKey(provider);
}

function reusablePiApiKey(provider: Record<string, unknown>): PiProviderApiKeyLookup {
  const key = provider.apiKey;
  if (typeof key !== "string") return { kind: "unavailable" };
  const value = key.trim();
  if (!value) return { kind: "unavailable" };
  if (value.startsWith("!/")) return { kind: "command-form" };
  return { kind: "string", value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinHome(homedir: string, relative: string): string {
  if (!isAbsolutePath(homedir)) {
    throw new BoxRuntimeError("invalid_usage", "homedir must be an absolute path.");
  }
  const base = homedir.endsWith("/") ? homedir.slice(0, -1) : homedir;
  return `${base}/${relative}`;
}

export function catalogWantsPi(catalog: readonly ExternalCatalogEntry[]): boolean {
  return catalog.some((entry) => entry === "pi" || (typeof entry === "object" && entry.id === "pi"));
}

/** Ordered unique absolute candidates. Existence is the caller's job. */
export function piModelsPathCandidates(input: {
  catalog: readonly ExternalCatalogEntry[];
  homedir: string;
  env: Record<string, string | undefined>;
}): string[] {
  const override = input.catalog.map((entry) => typeof entry === "object" ? entry.modelsPath : undefined).find((path) => path);
  if (override) return [override];
  const fromEnv = input.env.PI_MODELS_PATH;
  const out: string[] = [];
  if (typeof fromEnv === "string" && isAbsolutePath(fromEnv)) out.push(fromEnv);
  out.push(joinHome(input.homedir, ".pi/agent/models.json"));
  out.push(joinHome(input.homedir, ".pi/models.json"));
  return [...new Set(out)];
}

function grokboxId(providerName: string, modelId: string): string {
  return `${providerName}/${modelId}`;
}

function capabilitiesOf(model: Record<string, unknown>): ModelCapabilities {
  const input = Array.isArray(model.input) ? model.input.filter((entry): entry is string => typeof entry === "string") : [];
  const vision = input.includes("image") || input.includes("images");
  return { vision, tools: true, images: vision };
}

function apiKeyRefForPiProvider(providerName: string, provider: Record<string, unknown>, credentials: Record<string, string>): string | undefined {
  if (Object.hasOwn(credentials, providerName)) {
    const override = credentials[providerName];
    return typeof override === "string" && override.length > 0 ? override : undefined;
  }
  if (reusablePiApiKey(provider).kind !== "string") return undefined;
  return piProviderApiKeyRef(providerName);
}

/** Pi catalog only. Never copies apiKey or executes command-form keys. */
export function adaptPiCatalog(pi: unknown, credentials: Record<string, string>): Record<string, ModelRecord> {
  if (!isRecord(pi) || !isRecord(pi.providers)) {
    throw new BoxRuntimeError("invalid_usage", "Pi models.json must have providers.");
  }
  const models: Record<string, ModelRecord> = Object.create(null);
  for (const [providerName, provider] of Object.entries(pi.providers)) {
    if (!isRecord(provider)) continue;
    const api = provider.api;
    if (typeof api !== "string" || !(api in PI_API_TO_PROVIDER)) continue;
    const apiKeyRef = apiKeyRefForPiProvider(providerName, provider, credentials);
    if (!apiKeyRef) continue;
    const endpoint = provider.baseUrl;
    if (typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)) continue;
    const rows = provider.models;
    if (!Array.isArray(rows)) continue;
    const grokboxProvider = PI_API_TO_PROVIDER[api as keyof typeof PI_API_TO_PROVIDER];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string" || row.id.length === 0 || row.id.includes("/")) continue;
      const id = grokboxId(providerName, row.id);
      const capabilities = capabilitiesOf(row);
      const window = row.contextWindow;
      const contextWindowTokens = typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : undefined;
      models[id] = {
        id,
        provider: grokboxProvider,
        model: row.id,
        endpoint,
        apiKeyRef,
        capabilities,
        dataTypes: [
          "text",
          ...(capabilities.tools ? ["tools"] : []),
          ...(capabilities.vision || capabilities.images ? ["images"] : []),
        ],
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        catalog: "pi",
      };
    }
  }
  return models;
}

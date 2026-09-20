import { UUID, type ModelOperation, type ModelView, type BotModelView, type BotView, type BotModelSelection } from "./contract.ts";

/** Public wire validation only. Admission, configuration and publishing stay in
 * the Server's domain program. These functions import no runtime implementation. */
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
export const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const modelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
export const cursor = (value: unknown): boolean => value === null || typeof value === "string" && value.length > 0 && value.length <= 256;
export const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
const nullable = (value: unknown, validate: (v: unknown) => boolean): boolean => value === null || validate(value);
// Exhaustive type checking makes adding/removing a domain effort a compile-time
// change to its wire decoder, without importing Effect or provider code.
type Effort = NonNullable<Extract<BotModelSelection, { kind: "model" }>["reasoning"]>["effort"];
const efforts = { none: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true } satisfies Record<Effort, true>;
const effort = (value: unknown): boolean => typeof value === "string" && Object.hasOwn(efforts, value);
export const policy = (value: unknown): boolean => record(value) && exact(value, ["effort"]) && effort(value.effort);
export function selectedModel(value: unknown, kind = false): boolean {
  return record(value) && exact(value, kind ? ["kind", "modelId", "reasoning"] : ["modelId", "reasoning"])
    && (!kind || value.kind === "model") && modelId(value.modelId) && (value.reasoning === undefined || policy(value.reasoning));
}
function capabilities(value: unknown): boolean {
  if (!record(value) || !exact(value, ["vision", "tools", "images", "reasoning"]) || ![value.vision, value.tools, value.images].every(flag => typeof flag === "boolean")) return false;
  const reasoning = value.reasoning;
  return reasoning === undefined || reasoning === false || record(reasoning) && exact(reasoning, ["efforts"])
    && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0 && reasoning.efforts.length <= Object.keys(efforts).length
    && reasoning.efforts.every(effort) && new Set(reasoning.efforts).size === reasoning.efforts.length;
}
function publicEndpoint(value: unknown): boolean {
  if (value === null) return true;
  if (!text(value, 4096)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function model(value: unknown): value is ModelView {
  return record(value) && exact(value, ["id", "provider", "model", "alias", "endpoint", "configurationSource", "capabilities", "contextWindowTokens", "credential"])
    && modelId(value.id) && text(value.provider, 2048) && text(value.model, 2048) && nullable(value.alias, item => text(item, 256))
    && ["local", "pi", "builtin"].includes(String(value.configurationSource)) && publicEndpoint(value.endpoint)
    && capabilities(value.capabilities) && nullable(value.contextWindowTokens, positive)
    && record(value.credential) && exact(value.credential, ["configured", "source"]) && typeof value.credential.configured === "boolean"
    && ["env", "file", "pi-provider", "none"].includes(String(value.credential.source));
}
export function botModel(value: unknown, expectedRef: string): value is BotModelView {
  if (!record(value) || !exact(value, ["botRef", "selection", "revision", "effectiveModel", "effectiveWhen", "currentTurn", "source"])
    || value.botRef !== expectedRef || !revision(value.revision) || value.source !== "model-configuration"
    || value.effectiveWhen !== "next-turn" || value.currentTurn !== "not-observed" || !record(value.selection)) return false;
  const selected = value.selection;
  if (selected.kind === "native" || selected.kind === "default") {
    if (!exact(selected, ["kind"])) return false;
  } else if (!selectedModel(selected, true)) return false;
  const effective = value.effectiveModel;
  if (effective === null) return selected.kind !== "model";
  if (!record(effective) || !exact(effective, ["modelId", "reasoning"]) || !modelId(effective.modelId) || !nullable(effective.reasoning, policy)) return false;
  if (selected.kind === "native") return false;
  return selected.kind !== "model" || selected.modelId === effective.modelId
    && (selected.reasoning === undefined ? effective.reasoning === null : record(effective.reasoning) && record(selected.reasoning) && selected.reasoning.effort === effective.reasoning.effort);
}
export function operation(value: unknown, installationId: string): value is ModelOperation {
  if (!record(value) || !exact(value, ["version", "operationRef", "requestId", "command", "target", "state", "beforeRevision", "configRevision", "acceptedAt", "effectiveWhen", "currentTurn", "concurrency"])
    || value.version !== 1 || typeof value.operationRef !== "string" || !value.operationRef.startsWith(`model-operation:${installationId}:`)
    || !revision(value.operationRef.slice(`model-operation:${installationId}:`.length)) || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || !["succeeded", "unknown"].includes(String(value.state)) || !revision(value.beforeRevision) || !revision(value.configRevision)
    || value.effectiveWhen !== "next-turn" || value.currentTurn !== "unchanged" || value.concurrency !== "local_serialized"
    || typeof value.acceptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.acceptedAt)) return false;
  const time = Date.parse(value.acceptedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.acceptedAt) return false;
  switch (value.command) {
    case "bot-selection": return typeof value.target === "string" && UUID.test(value.target);
    case "default-selection": return value.target === "default";
    case "model-put": case "model-patch": case "model-delete": return modelId(value.target);
    default: return false;
  }
}
export function botSource(value: unknown): value is BotView["source"] {
  return record(value) && exact(value, ["kind", "generation", "pid", "startedAt", "observedAt"]) && value.kind === "native-gateway"
    && revision(value.generation) && positive(value.pid) && positive(value.startedAt) && positive(value.observedAt);
}
export function botRow(value: unknown, installationId: string): value is BotView {
  return record(value) && exact(value, ["id", "botRef", "name", "title", "description", "nativeHarness", "hidden", "running", "runningTurn", "updatedAt", "textTruncated", "truncatedFields", "coverage", "source"])
    && typeof value.id === "string" && UUID.test(value.id) && value.botRef === `bot:${installationId}:${value.id}` && typeof value.name === "string"
    && nullable(value.title, item => typeof item === "string") && nullable(value.description, item => typeof item === "string")
    && ["box", "temporal", null].includes(value.nativeHarness as never)
    && [value.hidden, value.running, value.runningTurn].every(flag => flag === null || typeof flag === "boolean")
    && nullable(value.updatedAt, item => typeof item === "number" && Number.isFinite(item))
    && Array.isArray(value.truncatedFields) && value.truncatedFields.length <= 3 && new Set(value.truncatedFields).size === value.truncatedFields.length
    && value.truncatedFields.every(field => ["name", "title", "description"].includes(field)) && value.textTruncated === (value.truncatedFields.length > 0)
    && value.coverage === "current-snapshot" && botSource(value.source);
}

/** Scoped source documents, not Memory fact identities or proof of TURN adoption. */
export const MATERIAL_POLICY = Object.freeze({ maxSources: 8, maxDocuments: 1000, maxDirectoryEntries: 4000, maxDepth: 8,
  maxDocumentBytes: 64 * 1024, maxSourceBytes: 4 * 1024 * 1024, maxIndexBytes: 64 * 1024 * 1024,
  maxOperations: 2048, maxWriteBytes: 32 * 1024, intervalMs: 30_000, scanTimeoutMs: 10_000 });
export type MaterialSourceConfig = { id: string; root: string; accountScope: string } & (
  { kind: "native-memory"; agentIds: string[]; projects: string[] } | { kind: "files"; writable: boolean });
export type MaterialsConfiguration = { enabled: boolean; intervalMs: number; sources: MaterialSourceConfig[] };
export type MaterialKind = "memory" | "project" | "membership" | "file";
export type MaterialScope = "agent" | "user" | "project" | "file";
export type MaterialMetadata = {
  ref: string; sourceId: string; binding: string; path: string; kind: MaterialKind; scope: MaterialScope;
  agentId: string | null; project: string | null; bytes: number; revision: string; modifiedAtMs: number;
  writable: boolean; membership: string[]; contentIncluded: false; author: "not-observed";
};
export type MaterialSourceView = { id: string; kind: MaterialSourceConfig["kind"]; accountScope: string; binding: string | null;
  state: "not-indexed" | "ready" | "partial" | "unavailable"; indexedAtMs: number | null; attemptedAtMs: number | null;
  documents: number; skipped: number; reason: string | null; writable: boolean; freshness: "not-indexed" | "fresh" | "stale";
  coverage: "configured-local-sources"; upstreamSync: "not-observed"; identityBasis: "explicit-source-binding" };
export type MaterialStatus = { owner: "management-server"; state: "not-configured" | "disabled" | "indexing" | "waiting" | "unavailable" | "stopped";
  lastCycleAtMs: number | null; cycles: number; sources: MaterialSourceView[]; sourceWrites: false; historyReconstructed: false };
export type MaterialPage = { items: MaterialMetadata[]; nextCursor: string | null; snapshot: string; sources: MaterialSourceView[];
  search: "none" | "literal-case-insensitive"; coverage: "indexed-window"; contentIncluded: false };
export type MaterialRead = { document: MaterialMetadata; content: string; encoding: "utf8"; observedAtMs: number;
  source: "direct-read"; contentProjection: "exact-text" | "authorized-membership"; indexedRevision: string | null; indexState: "matched" | "lagging" | "not-indexed" | "unavailable"; includedInTurn: "not-observed" };
export type MaterialWrite = { requestId: string; ref: string; expectedRevision: string; content: string; confirmed: true };
export type MaterialOperation = { requestId: string; operationRef: string; ref: string; sourceId: string; binding: string;
  beforeRevision: string; afterRevision: string | null; state: "succeeded" | "unknown" | "refused"; acceptedAtMs: number; settledAtMs: number | null;
  sourceWrite: "replace-existing-text"; evidence: "source-readback" | "not-verified"; externalCompareAndSwap: false; indexAdoption: "not-observed" };
export type MaterialQuery = { sourceId?: string; kind?: MaterialKind; scope?: MaterialScope; query?: string; cursor?: string; limit?: number };
export class MaterialError extends Error {
  constructor(readonly code: "wrong_installation" | "invalid_input" | "permission_denied" | "source_unavailable" | "source_changed" | "source_incomplete" | "not_found" | "cursor_gap" | "revision_conflict" | "operation_unknown" | "idempotency_conflict" | "store_full", readonly reason: string) {
    super(reason); this.name = "MaterialError";
  }
}
export const MATERIAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MATERIAL_SHA = /^[a-f0-9]{64}$/;
export const MATERIAL_SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const MATERIAL_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const invalid = (reason: string): never => { throw new MaterialError("invalid_input", reason); };
export function materialPath(path: unknown): string {
  if (typeof path !== "string" || !path || new TextEncoder().encode(path).length > 512 || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).length > 255)) return invalid("Invalid relative material path.");
  return path;
}
export function materialReference(installationId: string, binding: string, sourceId: string, path: string): string {
  if (!MATERIAL_UUID.test(installationId) || !MATERIAL_SHA.test(binding) || !MATERIAL_SOURCE_ID.test(sourceId)) return invalid("Invalid material source identity.");
  return `material:${installationId.toLowerCase()}:${binding}:${sourceId}:${encodeURIComponent(materialPath(path))}`;
}
export function materialIdentity(ref: unknown, installationId: string) {
  if (typeof installationId !== "string" || !MATERIAL_UUID.test(installationId)) throw new MaterialError("wrong_installation", "Pin the connection before using material references.");
  const p = typeof ref === "string" ? ref.split(":") : [];
  if (p.length !== 5 || p[0] !== "material" || !MATERIAL_UUID.test(p[1]!) || !MATERIAL_SHA.test(p[2]!) || !MATERIAL_SOURCE_ID.test(p[3]!)) return invalid("Use a complete installation/source-scoped material reference.");
  if (p[1]!.toLowerCase() !== installationId.toLowerCase()) throw new MaterialError("wrong_installation", "The material belongs to another installation.");
  let path: string; try { path = materialPath(decodeURIComponent(p[4]!)); } catch { return invalid("Invalid material reference path."); }
  if (encodeURIComponent(path) !== p[4]) return invalid("The material reference path is not canonical.");
  return { sourceId: p[3]!, binding: p[2]!, path, ref: materialReference(installationId, p[2]!, p[3]!, path) };
}
export function normalizeMaterialWrite(value: unknown, installationId: string): MaterialWrite {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return invalid("Invalid material write.");
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).some(k => typeof k !== "string" || !["requestId", "ref", "expectedRevision", "content", "confirmed"].includes(k) || !("value" in Object.getOwnPropertyDescriptor(row,k)!))) return invalid("Unknown material write field.");
  if (typeof row.requestId !== "string" || !MATERIAL_UUID.test(row.requestId) || typeof row.expectedRevision !== "string" || !MATERIAL_SHA.test(row.expectedRevision)
    || typeof row.content !== "string" || row.content.includes("\0") || new TextEncoder().encode(row.content).length > MATERIAL_POLICY.maxWriteBytes || row.confirmed !== true) return invalid("An existing document revision, request UUID, bounded UTF-8 text and confirmation are required.");
  const target = materialIdentity(row.ref, installationId);
  return { requestId: row.requestId.toLowerCase(), ref: target.ref, expectedRevision: row.expectedRevision, content: row.content, confirmed: true };
}
export function normalizeMaterialQuery(value: MaterialQuery): MaterialQuery {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).some(k => typeof k !== "string" || !["sourceId","kind","scope","query","cursor","limit"].includes(k) || !("value" in Object.getOwnPropertyDescriptor(value,k)!))) return invalid("Invalid material query fields.");
  if (value.sourceId !== undefined && !MATERIAL_SOURCE_ID.test(value.sourceId) || value.kind !== undefined && !["memory", "project", "membership", "file"].includes(value.kind)
    || value.scope !== undefined && !["agent", "user", "project", "file"].includes(value.scope)
    || value.query !== undefined && (typeof value.query !== "string" || !value.query.trim() || value.query.length > 256 || /[\x00-\x1f]/.test(value.query))
    || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)
    || value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 160)) return invalid("Invalid bounded material query.");
  return { ...value };
}

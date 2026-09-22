/** Current named-root files. Native material documents keep their source identity;
 * a named root cannot alias native or managed material storage. No OS sandbox claim. */
export const FILE_POLICY = Object.freeze({ chunkBytes: 32768, maxBytes: 67108864, readBytes: 65536, maxTransfers: 32, maxOperations: 2048, transferIdleMs: 60000 });
export const FILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FILE_SHA = /^[a-f0-9]{64}$/;
export const FILE_ACTIONS = ["write", "mkdir", "delete", "upload", "restore"] as const;
export type FileAction = typeof FILE_ACTIONS[number];
export type FileRootView = { name: string; ref: string; binding: string; operations: string[]; externalCompareAndSwap: false };
export type FileRootsView = { roots: FileRootView[]; state: "ready" | "unconfigured" | "unavailable"; coverage: "configured-named-roots" };
export type FileEntry = { ref: string; name: string; kind: "file" | "directory"; size: number; mode: string; modifiedAt: string; revision: string | null };
export type FileDirectory = { ref: string; entries: FileEntry[]; complete: boolean; nextCursor: string | null; snapshot: string; contentIncluded: false };
export type FileRead = { ref: string; size: number; sha256: string; contentBase64: string; encoding: "base64" };
export type FileChange = { requestId: string; ref: string; confirmed: true; expectedRevision: string | null } & (
  { action: "write"; content: string } | { action: "mkdir" } | { action: "delete"; recursive: boolean }
  | { action: "upload"; size: number; sha256: string } | { action: "restore"; deletionRequestId: string });
export type FileOperation = { version: 1; requestId: string; operationRef: string; ref: string; action: FileAction; serviceGeneration: string;
  expectedRevision: string | null; state: "unknown" | "succeeded" | "refused" | "cancelled";
  acceptedAtMs: number; settledAtMs: number | null; result: { revision: string | null; size: number | null; kind: "file" | "directory"; recoverable: boolean } | null;
  externalCompareAndSwap: false; indexAdoption: "not-observed" };
export type FileUpload = { requestId: string; ref: string; generation: string; chunkBytes: 32768; size: number; sha256: string; chunks: number; operation: FileOperation };
export type FileUploadControl = { requestId: string; generation: string; action: "commit" | "cancel" };
export type FileUploadChunk = { requestId: string; generation: string; index: number; contentBase64: string };
export type FileDownload = { requestId: string; ref: string; generation: string; size: number; sha256: string; chunkBytes: 32768; chunks: number };
export type FileDownloadChunk = { requestId: string; index: number; bytes: number; contentBase64: string; done: boolean };
export class FileError extends Error {
  constructor(readonly code: "invalid_input" | "wrong_installation" | "permission_denied" | "source_changed" | "source_unavailable" | "source_incomplete" | "not_found" | "revision_conflict" | "idempotency_conflict" | "operation_unknown" | "store_full", message: string) { super(message); this.name = "FileError"; }
}
const invalid = (): never => { throw new FileError("invalid_input", "Use bounded data, the exact scoped file reference and the original request identity."); };
export function fileData(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const keys = Reflect.ownKeys(value);
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => typeof k !== "string" || ![...required, ...optional].includes(k))) return invalid();
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !("value" in d) || !d.enumerable) return invalid(); }
  return value as Record<string, unknown>;
}
export function filePath(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 512 || /[\\\x00-\x1f\x7f]/.test(value)
    || value !== "" && value.split("/").some(p => !p || p === "." || p === ".." || new TextEncoder().encode(p).length > 255)) return invalid();
  return value;
}
export function fileReference(installationId: string, binding: string, root: string, path = ""): string {
  if (!FILE_UUID.test(installationId) || !FILE_SHA.test(binding) || !/^[a-z][a-z0-9-]{0,31}$/.test(root)) return invalid();
  return `file:${installationId.toLowerCase()}:${binding}:${root}:${encodeURIComponent(filePath(path))}`;
}
export function fileIdentity(value: unknown, installationId: string) {
  if (typeof installationId !== "string" || !FILE_UUID.test(installationId)) throw new FileError("wrong_installation", "Pin the file connection to an installation.");
  const p = typeof value === "string" ? value.split(":") : [];
  if (p.length !== 5 || p[0] !== "file" || !FILE_UUID.test(p[1]!) || !FILE_SHA.test(p[2]!) || !/^[a-z][a-z0-9-]{0,31}$/.test(p[3]!)) return invalid();
  if (p[1]!.toLowerCase() !== installationId.toLowerCase()) throw new FileError("wrong_installation", "This file belongs to another installation.");
  let path: string; try { path = filePath(decodeURIComponent(p[4]!)); } catch { return invalid(); }
  const ref = fileReference(installationId, p[2]!, p[3]!, path); if (ref !== value) return invalid();
  return { ref, binding: p[2]!, root: p[3]!, path, remotePath: `${p[3]}:/${path}` };
}
export function normalizeFileChange(value: unknown, installationId: string): FileChange {
  const base = ["requestId", "ref", "action", "expectedRevision", "confirmed"];
  // Check descriptors before reading the action discriminator.
  const v = fileData(value, base, ["content", "size", "sha256", "recursive", "deletionRequestId"]);
  if (typeof v.action !== "string" || !FILE_ACTIONS.includes(v.action as FileAction)) return invalid();
  fileData(v, [...base, ...(v.action === "write" ? ["content"] : v.action === "upload" ? ["size", "sha256"] : v.action === "delete" ? ["recursive"] : v.action === "restore" ? ["deletionRequestId"] : [])]);
  if (typeof v.requestId !== "string" || !FILE_UUID.test(v.requestId) || v.confirmed !== true
    || v.expectedRevision !== null && (typeof v.expectedRevision !== "string" || !FILE_SHA.test(v.expectedRevision))) return invalid();
  const target = fileIdentity(v.ref, installationId); if (!target.path) return invalid();
  if (v.action === "write" && (typeof v.content !== "string" || v.content.includes("\0") || new TextEncoder().encode(v.content).length > 32768
    || new TextDecoder().decode(new TextEncoder().encode(v.content)) !== v.content)) return invalid();
  if (v.action === "upload" && (!Number.isSafeInteger(v.size) || Number(v.size) < 0 || Number(v.size) > FILE_POLICY.maxBytes || typeof v.sha256 !== "string" || !FILE_SHA.test(v.sha256))) return invalid();
  if (v.action === "delete" && (typeof v.recursive !== "boolean" || v.expectedRevision === null)) return invalid();
  if ((v.action === "mkdir" || v.action === "restore") && v.expectedRevision !== null) return invalid();
  if (v.action === "restore" && (typeof v.deletionRequestId !== "string" || !FILE_UUID.test(v.deletionRequestId))) return invalid();
  return { ...v, requestId: v.requestId.toLowerCase(), ref: target.ref, ...(v.action === "restore" ? { deletionRequestId: (v.deletionRequestId as string).toLowerCase() } : {}) } as FileChange;
}
export function fileBase64(text: unknown, maxBytes: number): number {
  if (typeof text !== "string" || text.length > 4 * Math.ceil(maxBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return invalid();
  try { const value = atob(text); if (btoa(value) !== text || value.length > maxBytes) return invalid(); return value.length; } catch { return invalid(); }
}
export function normalizeFileUploadChunk(value: unknown): FileUploadChunk {
  const v = fileData(value, ["requestId", "generation", "index", "contentBase64"]);
  if (typeof v.requestId !== "string" || !FILE_UUID.test(v.requestId) || typeof v.generation !== "string" || !FILE_UUID.test(v.generation)
    || !Number.isSafeInteger(v.index) || Number(v.index) < 0 || Number(v.index) >= FILE_POLICY.maxBytes / FILE_POLICY.chunkBytes || !fileBase64(v.contentBase64, FILE_POLICY.chunkBytes)) return invalid();
  return { requestId: v.requestId.toLowerCase(), generation: v.generation.toLowerCase(), index: Number(v.index), contentBase64: v.contentBase64 as string };
}
export function validFileOperation(value: unknown, installationId: string, requestId?: string, request?: FileChange): value is FileOperation {
  try {
    const v = fileData(value, ["version", "requestId", "operationRef", "ref", "action", "serviceGeneration", "expectedRevision", "state", "acceptedAtMs", "settledAtMs", "result", "externalCompareAndSwap", "indexAdoption"]);
    const target = fileIdentity(v.ref, installationId);
    if (!target.path || v.version !== 1 || typeof v.serviceGeneration !== "string" || !FILE_UUID.test(v.serviceGeneration) || typeof v.requestId !== "string" || !FILE_UUID.test(v.requestId) || requestId !== undefined && v.requestId !== requestId
      || typeof v.operationRef !== "string" || !v.operationRef.startsWith(`file-operation:${installationId}:`) || v.operationRef.split(":").length !== 3 || !FILE_SHA.test(v.operationRef.split(":")[2]!)
      || !FILE_ACTIONS.includes(v.action as FileAction) || !["unknown", "succeeded", "refused", "cancelled"].includes(v.state as string)
      || v.expectedRevision !== null && (typeof v.expectedRevision !== "string" || !FILE_SHA.test(v.expectedRevision))
      || !Number.isSafeInteger(v.acceptedAtMs) || Number(v.acceptedAtMs) < 1 || v.settledAtMs !== null && (!Number.isSafeInteger(v.settledAtMs) || Number(v.settledAtMs) < Number(v.acceptedAtMs))
      || v.externalCompareAndSwap !== false || v.indexAdoption !== "not-observed" || v.state === "cancelled" && v.action !== "upload") return false;
    if (v.state === "succeeded") {
      const r = fileData(v.result, ["revision", "size", "kind", "recoverable"]);
      if (v.settledAtMs === null || !["file", "directory"].includes(r.kind as string) || r.size !== null && (!Number.isSafeInteger(r.size) || Number(r.size) < 0)
        || r.revision !== null && (typeof r.revision !== "string" || !FILE_SHA.test(r.revision)) || r.recoverable !== (v.action === "delete")) return false;
      if (v.action === "delete" ? r.revision !== null || r.size !== null : r.revision === null || r.size === null) return false;
      if ((v.action === "write" || v.action === "upload") && r.kind !== "file" || v.action === "mkdir" && r.kind !== "directory") return false;
      if (request?.action === "upload" && (r.revision !== request.sha256 || r.size !== request.size)) return false;
      if (request?.action === "write" && r.size !== new TextEncoder().encode(request.content).length) return false;
    } else if (v.result !== null || v.state !== "unknown" && v.settledAtMs === null) return false;
    return !request || v.ref === request.ref && v.action === request.action && v.expectedRevision === request.expectedRevision;
  } catch { return false; }
}

export function normalizeFileUploadControl(value: unknown): FileUploadControl {
  const v = fileData(value, ["requestId", "generation", "action"]);
  if (typeof v.requestId !== "string" || !FILE_UUID.test(v.requestId) || typeof v.generation !== "string" || !FILE_UUID.test(v.generation) || !["commit", "cancel"].includes(v.action as string)) return invalid();
  return { requestId: v.requestId.toLowerCase(), generation: v.generation.toLowerCase(), action: v.action as "commit" | "cancel" };
}

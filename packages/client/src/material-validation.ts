import { MATERIAL_POLICY as P, MATERIAL_SHA, MATERIAL_UUID, MATERIAL_SOURCE_ID, MATERIAL_SLUG, materialIdentity, type MaterialMetadata, type MaterialPage, type MaterialRead, type MaterialOperation, type MaterialStatus, type MaterialSourceView, type MaterialWrite } from "./contract.ts";
import { exact, record } from "./response-validation.ts";
const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown) => v === null || number(v);
const sha = (v: unknown) => typeof v === "string" && MATERIAL_SHA.test(v);
function target(ref: unknown, installationId: string) { try { return materialIdentity(ref, installationId); } catch { return null; } }
export function materialMetadata(v: unknown, installationId: string): v is MaterialMetadata {
  if (!record(v) || !exact(v,["ref","sourceId","binding","path","kind","scope","agentId","project","bytes","revision","modifiedAtMs","writable","membership","contentIncluded","author"])) return false;
  const ref = target(v.ref,installationId);
  if (!ref || ref.sourceId !== v.sourceId || ref.binding !== v.binding || ref.path !== v.path || !sha(v.revision) || !number(v.bytes) || Number(v.bytes) > P.maxDocumentBytes || !number(v.modifiedAtMs)
    || typeof v.writable !== "boolean" || v.contentIncluded !== false || v.author !== "not-observed" || !Array.isArray(v.membership)
    || v.membership.length > 64 || v.membership.some(x => typeof x !== "string" || !MATERIAL_SLUG.test(x)) || new Set(v.membership).size !== v.membership.length) return false;
  if (v.kind === "file") return v.scope === "file" && v.agentId === null && v.project === null && !v.membership.length;
  if (v.writable !== false) return false;
  if (v.kind === "project") return v.scope === "project" && v.agentId === null && typeof v.project === "string" && MATERIAL_SLUG.test(v.project) && !v.membership.length;
  if (v.kind === "membership") return v.scope === "agent" && typeof v.agentId === "string" && MATERIAL_UUID.test(v.agentId) && v.project === null;
  return v.kind === "memory" && ["agent","user","project"].includes(String(v.scope)) && typeof v.agentId === "string" && MATERIAL_UUID.test(v.agentId)
    && (v.scope === "project" ? typeof v.project === "string" && MATERIAL_SLUG.test(v.project) : v.project === null) && !v.membership.length;
}
export function materialSource(v: unknown): v is MaterialSourceView {
  return record(v) && exact(v,["id","kind","accountScope","binding","state","indexedAtMs","attemptedAtMs","documents","skipped","reason","writable","freshness","coverage","upstreamSync","identityBasis"])
    && typeof v.id === "string" && MATERIAL_SOURCE_ID.test(v.id) && ["native-memory","files"].includes(String(v.kind)) && sha(v.accountScope) && (v.binding === null || sha(v.binding))
    && ["not-indexed","ready","partial","unavailable"].includes(String(v.state)) && time(v.indexedAtMs) && time(v.attemptedAtMs) && number(v.documents) && Number(v.documents) <= P.maxDocuments && number(v.skipped)
    && (v.reason === null || typeof v.reason === "string" && /^[a-z-]{1,96}$/.test(v.reason)) && typeof v.writable === "boolean" && (v.kind === "files" || v.writable === false)
    && ["not-indexed","fresh","stale"].includes(String(v.freshness)) && (v.indexedAtMs === null ? v.freshness === "not-indexed" : v.freshness !== "not-indexed")
    && v.coverage === "configured-local-sources" && v.upstreamSync === "not-observed" && v.identityBasis === "explicit-source-binding";
}
const sources = (v: unknown): v is MaterialSourceView[] => Array.isArray(v) && v.length <= P.maxSources && v.every(materialSource) && new Set(v.map(s => s.id)).size === v.length;
export function materialStatus(v: unknown): v is MaterialStatus {
  return record(v) && exact(v,["owner","state","lastCycleAtMs","cycles","sources","sourceWrites","historyReconstructed"])
    && v.owner === "management-server" && ["not-configured","disabled","indexing","waiting","unavailable","stopped"].includes(String(v.state)) && time(v.lastCycleAtMs) && number(v.cycles)
    && sources(v.sources) && v.sourceWrites === false && v.historyReconstructed === false;
}
export function materialPage(v: unknown, installationId: string, query: { sourceId?: string; kind?: string; scope?: string; query?: string; limit?: number }): v is MaterialPage {
  return record(v) && exact(v,["items","nextCursor","snapshot","sources","search","coverage","contentIncluded"])
    && sha(v.snapshot) && sources(v.sources) && Array.isArray(v.items) && v.items.length <= (query.limit ?? 50)
    && v.items.every(item => materialMetadata(item,installationId) && (!query.sourceId || item.sourceId === query.sourceId) && (!query.kind || item.kind === query.kind) && (!query.scope || item.scope === query.scope)
      && (v.sources as MaterialSourceView[]).some(s => s.id === item.sourceId && s.binding === item.binding))
    && new Set(v.items.map(item => item.ref)).size === v.items.length
    && (v.nextCursor === null || typeof v.nextCursor === "string" && new RegExp(`^${v.snapshot}:\\d+$`).test(v.nextCursor))
    && v.search === (query.query ? "literal-case-insensitive" : "none") && v.coverage === "indexed-window" && v.contentIncluded === false;
}
export function materialRead(v: unknown, installationId: string, ref: string): v is MaterialRead {
  return record(v) && exact(v,["document","content","encoding","observedAtMs","source","contentProjection","indexedRevision","indexState","includedInTurn"])
    && materialMetadata(v.document,installationId) && v.document.ref === ref && typeof v.content === "string" && !v.content.includes("\0")
    && new TextEncoder().encode(v.content).length <= P.maxDocumentBytes && v.encoding === "utf8" && number(v.observedAtMs) && v.source === "direct-read"
    && v.contentProjection === (v.document.kind === "membership" ? "authorized-membership" : "exact-text")
    && (v.indexedRevision === null || sha(v.indexedRevision)) && (v.indexedRevision === null ? ["not-indexed","unavailable"].includes(String(v.indexState)) : v.indexState === (v.indexedRevision === v.document.revision ? "matched" : "lagging")) && v.includedInTurn === "not-observed";
}
export function materialOperation(v: unknown, installationId: string, requestId: string, input?: MaterialWrite): v is MaterialOperation {
  if (!record(v) || !exact(v,["requestId","operationRef","ref","sourceId","binding","beforeRevision","afterRevision","state","acceptedAtMs","settledAtMs","sourceWrite","evidence","externalCompareAndSwap","indexAdoption"])) return false;
  const ref = target(v.ref,installationId);
  return !!ref && ref.sourceId === v.sourceId && ref.binding === v.binding && v.requestId === requestId
    && typeof v.operationRef === "string" && new RegExp(`^material-operation:${installationId}:[a-f0-9]{64}$`).test(v.operationRef)
    && sha(v.beforeRevision) && (v.afterRevision === null || sha(v.afterRevision)) && ["succeeded","unknown","refused"].includes(String(v.state))
    && number(v.acceptedAtMs) && time(v.settledAtMs) && v.sourceWrite === "replace-existing-text" && v.externalCompareAndSwap === false && v.indexAdoption === "not-observed"
    && (v.state === "succeeded" ? sha(v.afterRevision) && v.evidence === "source-readback" && number(v.settledAtMs) : v.afterRevision === null && v.evidence === "not-verified")
    && (!input || input.ref === v.ref && input.expectedRevision === v.beforeRevision);
}

import { normalizeContextChange, normalizeContextContinuation, type ContextChange, type ContextContinuation, type ContextOperation, ManagementClientError, UUID, incidentIdentity, notificationIdentity, type ReceiverChangeRequest, type ModelChange, type ModelChangeRequest, type IncidentChangeRequest, type SetupRequest, type SetupKind, type MaterialWrite, type ProtectionChangeRequest, normalizeProtectionChange, materialIdentity, routineIdentity, botIdFromRef, setupKind } from "@grokbox/client";

export type OperationScope = { installationId: string; principalId: string };
export type LocalOperation = {
  version: 1; requestId: string; installationId: string; principalId: string; command: ModelChange["kind"] | "incident-ack" | "incident-snooze" | "receiver-enable" | "receiver-disable" | "receiver-unbind" | "notification-test" | "setup-settings" | "setup-apply" | "setup-enable" | "setup-disable" | "setup-delete" | "setup-bind" | "material-write" | "protection-policy" | "context-control"; databaseId?: string; contextScope?: string;
  setupKind?: SetupKind; setupScope?: string;
  target: string; createdAt: number; state: "awaiting-response" | "unknown" | "succeeded" | "refused" | "retired";
};
type StoragePort = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
const prefix = (scope: OperationScope) => `grokbox:operation:v1:${scope.installationId}:${encodeURIComponent(scope.principalId)}:`;
const valid = (value: unknown, scope: OperationScope): value is LocalOperation => {
  const row = value as LocalOperation | null;
  return !!row && row.version === 1 && row.installationId === scope.installationId && row.principalId === scope.principalId
    && UUID.test(row.requestId) && Number.isSafeInteger(row.createdAt) && row.createdAt > 0 && typeof row.target === "string" && row.target.length <= (row.command === "material-write" ? 1800 : 256)
    && Object.keys(row).every(key => ["version", "requestId", "installationId", "principalId", "command", "databaseId", "contextScope", "setupKind", "setupScope", "target", "createdAt", "state"].includes(key))
    && (row.command === "context-control" || row.contextScope === undefined)
    && (row.command === "context-control" ? validContextLocator(row, scope) : row.command === "protection-policy" ? validProtectionLocator(row,scope) : row.command === "material-write" ? validMaterialLocator(row,scope) : row.command.startsWith("setup-") ? validSetupLocator(row,scope)
      : row.setupKind === undefined && row.setupScope === undefined && (["incident-ack", "incident-snooze"].includes(row.command)
      ? typeof row.databaseId === "string" && UUID.test(row.databaseId) && row.target.startsWith(`incident:${scope.installationId}:${row.databaseId}:`) && UUID.test(row.target.split(":")[3] ?? "") && row.target.split(":").length === 4
      : ["receiver-enable", "receiver-disable", "receiver-unbind", "notification-test"].includes(row.command)
        ? typeof row.databaseId === "string" && UUID.test(row.databaseId) && row.target.startsWith(`receiver:${scope.installationId}:${row.databaseId}:`) && UUID.test(row.target.split(":")[3] ?? "") && row.target.split(":").length === 4
        : row.databaseId === undefined && ["bot-selection", "default-selection", "model-put", "model-patch", "model-delete"].includes(row.command)))
    && ["awaiting-response", "unknown", "succeeded", "refused", "retired"].includes(row.state);
};
function validContextLocator(row: LocalOperation, scope: OperationScope): boolean {
  if (row.databaseId !== undefined || row.setupKind !== undefined || row.setupScope !== undefined || !/^[a-f0-9]{64}$/.test(row.contextScope ?? "")) return false;
  try { return row.target === `bot:${scope.installationId}:${botIdFromRef(row.target, scope.installationId)}`; } catch { return false; }
}
function contextMetadata(input: ContextChange, scope: OperationScope): Pick<LocalOperation, "command" | "target" | "contextScope"> {
  const request = normalizeContextChange(input, scope.installationId);
  return { command: "context-control", target: request.botRef, contextScope: request.scopeId };
}
export function contextLocalState(state: ContextOperation["state"]): LocalOperation["state"] {
  return state === "unknown" || state === "admitted" ? "unknown" : state === "cancelled" ? "retired" : "succeeded";
}
function validProtectionLocator(row: LocalOperation, scope: OperationScope): boolean {
  if(row.databaseId!==undefined||row.setupKind!==undefined||row.setupScope!==undefined)return false;
  if(row.target===`protection-system:${scope.installationId}`)return true;
  try{return row.target===`bot:${scope.installationId}:${botIdFromRef(row.target,scope.installationId)}`;}catch{return false;}
}
function protectionMetadata(input:ProtectionChangeRequest,scope:OperationScope):Pick<LocalOperation,"command"|"target"> {
  const request=normalizeProtectionChange(input,scope.installationId);
  return {command:"protection-policy",target:request.action==="system"?`protection-system:${scope.installationId}`:request.botRef};
}
function validMaterialLocator(row: LocalOperation, scope: OperationScope): boolean {
  try { materialIdentity(row.target,scope.installationId); return row.databaseId === undefined && row.setupKind === undefined && row.setupScope === undefined; } catch { return false; }
}
function validSetupLocator(row: LocalOperation, scope: OperationScope): boolean {
  if (row.databaseId !== undefined) return false;
  if (row.command === "setup-settings") return row.setupKind === "settings" && row.setupScope === "installation" && row.target === `notification-settings:${scope.installationId}`;
  if (row.command === "setup-apply") return row.setupKind === "routine" && typeof row.setupScope === "string" && UUID.test(row.setupScope) && row.target === `bot:${scope.installationId}:${row.setupScope}`;
  try {
    const target = routineIdentity(row.target,scope.installationId);
    return row.command === "setup-bind" ? row.setupKind === "pairing" && row.setupScope === "installation"
      : ["setup-enable","setup-disable","setup-delete"].includes(row.command) && row.setupKind === "routine" && row.setupScope === target.botId;
  } catch { return false; }
}
function setupMetadata(input: SetupRequest, scope: OperationScope): Pick<LocalOperation,"command"|"target"|"setupKind"|"setupScope"> {
  if (input.action === "reconcile") throw new Error("Reconciliation retains the original locator; it is not another submission.");
  const kind = setupKind(input.action), target = input.action === "settings" ? `notification-settings:${scope.installationId}`
    : input.action === "apply" ? input.botRef : input.routineRef;
  return { command:`setup-${input.action}`,target,setupKind:kind,
    setupScope:kind === "routine" ? input.action === "apply" ? botIdFromRef(input.botRef,scope.installationId) : routineIdentity(target,scope.installationId).botId : "installation" };
}
export function localOperations(storage: StoragePort, scope: OperationScope): LocalOperation[] {
  const rows: LocalOperation[] = [], start = prefix(scope);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(start)) continue;
    const text = storage.getItem(key);
    if (!text || text.length > 4096) throw new Error("The local operation locator is corrupt; preserve it before recovery.");
    const value: unknown = JSON.parse(text);
    if (!valid(value, scope) || key !== `${start}${value.requestId}`) throw new Error("The local operation locator is corrupt; preserve it before recovery.");
    rows.push(value);
    if (rows.length > 128) throw new Error("The local operation locator capacity is exceeded.");
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Persist only recovery metadata, never model input, cookie, CSRF or a key ref.
 * One key per UUID avoids overwriting another tab's index. Refuse before send if
 * storage is unavailable; unresolved locators are never silently evicted. */
export function rememberOperation(storage: StoragePort, scope: OperationScope, input: ModelChangeRequest | IncidentChangeRequest | ReceiverChangeRequest | SetupRequest | MaterialWrite | ProtectionChangeRequest | ContextChange): LocalOperation {
  try {
    if (!UUID.test(input.requestId) || !UUID.test(scope.installationId) || !scope.principalId || scope.principalId.length > 128
      || localOperations(storage, scope).length >= 128) throw new Error();
    const key = `${prefix(scope)}${input.requestId}`;
    if (storage.getItem(key) !== null) throw new Error();
    const metadata: Pick<LocalOperation, "command" | "target" | "databaseId" | "setupKind" | "setupScope" | "contextScope"> = "change" in input
      ? { command: input.change.kind, target: input.change.kind === "bot-selection" ? input.change.agentId : input.change.kind === "default-selection" ? "default" : input.change.modelId }
      : "receiverRef" in input ? { command: input.action === "test" ? "notification-test" : `receiver-${input.action}`, target: input.receiverRef,
        databaseId: notificationIdentity(input.receiverRef, scope.installationId).databaseId }
      : "incidentRef" in input ? { command: input.action === "ack" ? "incident-ack" : "incident-snooze", target: input.incidentRef,
        databaseId: incidentIdentity(input.incidentRef, scope.installationId).databaseId }
      : "ref" in input ? {command:"material-write",target:materialIdentity(input.ref,scope.installationId).ref}
      : "scopeId" in input ? contextMetadata(input,scope)
      : input.action==="system"||input.action==="set"||input.action==="reset" ? protectionMetadata(input,scope) : setupMetadata(input,scope);
    const row: LocalOperation = { version: 1, requestId: input.requestId, ...scope, ...metadata, createdAt: Date.now(), state: "awaiting-response" };
    if (!valid(row, scope)) throw new Error();
    const text = JSON.stringify(row);
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) throw new Error();
    return row;
  } catch { throw new ManagementClientError("unavailable", "无法保存操作恢复标识，本次尚未提交。请检查浏览器存储或整理已结束的记录。"); }
}
export type OperationDomain = "context" | "protection" | "model" | "material" | "incident" | "receiver" | "notification-test" | "notification-settings" | "routine" | "pairing";
export function operationDomain(row: LocalOperation): OperationDomain {
  if (row.command === "context-control") return "context";
  if (row.command === "protection-policy") return "protection";
  if (row.command === "material-write") return "material";
  if (row.setupKind) return row.setupKind === "settings" ? "notification-settings" : row.setupKind;
  return row.command === "notification-test" ? "notification-test" : row.command.startsWith("receiver-") ? "receiver" : row.command.startsWith("incident-") ? "incident" : "model";
}
export function operationSearch(row: LocalOperation): { requestId: string; domain?: Exclude<OperationDomain, "model">; databaseId?: string; bot?: string; target?: string; scopeId?: string } {
  const domain = operationDomain(row);
  return { requestId: row.requestId, ...(domain === "context" ? { scopeId: row.contextScope } : {}), ...(domain !== "model" ? { domain, databaseId: row.databaseId } : {}), ...(row.setupKind === "routine" ? { bot:row.setupScope } : {}), ...(domain==="protection"?{target:row.target.startsWith("protection-system:")?"system":row.target}:{}) };
}
/** Explicit continuation retains the original locator and verifies persistence
 * before send. It never stores the revision, snapshot selection or action body. */
export function retainContextContinuation(storage: StoragePort, scope: OperationScope, input: ContextContinuation): LocalOperation {
  try {
    const r = normalizeContextContinuation(input, scope.installationId), rows = localOperations(storage, scope), old = rows.find(v => v.requestId === r.requestId);
    if (old && (old.command !== "context-control" || old.target !== r.botRef || old.contextScope !== r.scopeId) || !old && rows.length >= 128) throw Error("locator-conflict");
    const row: LocalOperation = { version: 1, requestId: r.requestId, ...scope, command: "context-control", target: r.botRef, contextScope: r.scopeId,
      createdAt: old?.createdAt ?? Date.now(), state: "awaiting-response" };
    if (!valid(row, scope)) throw Error("locator-invalid");
    const key = `${prefix(scope)}${r.requestId}`, text = JSON.stringify(row); storage.setItem(key, text); if (storage.getItem(key) !== text) throw Error("locator-write-lost");
    return row;
  } catch { throw new ManagementClientError("unavailable", "The original context recovery locator could not be retained; no continuation was submitted."); }
}
export function markOperation(storage: StoragePort, row: LocalOperation, state: LocalOperation["state"]): void {
  const key = `${prefix(row)}${row.requestId}`;
  // A successful domain change is not failed merely because its local UI marker
  // cannot be updated. The pre-submission locator remains usable for readback.
  try { if (storage.getItem(key)) storage.setItem(key, JSON.stringify({ ...row, state })); } catch { /* Keep the original locator. */ }
}
export function forgetSettledOperation(storage: StoragePort, row: LocalOperation): void {
  const current = localOperations(storage, row).find(item => item.requestId === row.requestId);
  if (!current || !["succeeded", "refused", "retired"].includes(current.state)) throw new Error("Unresolved operation locators must be retained.");
  storage.removeItem(`${prefix(row)}${row.requestId}`);
}
